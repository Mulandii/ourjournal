/// <reference path="../pb_data/types.d.ts" />
// Our little journal — schema, access rules and server settings.
//
// Who can do what (enforced here, on the server, not in the page):
//   - nobody can see or do anything without signing in as one of the two people
//   - pages + media: only the owner can change or delete them,
//     except a page's layout, which either of you can switch
//   - hearts + notes: either of you can add them to anything; only the writer can remove their own
//   - accounts can't be created from the website (the two accounts are made on the server)

const AUTH = '@request.auth.id != ""';

migrate((app) => {
  // ---------- users: the two accounts (slot "a" and slot "b"; display names live in `name`) ----------
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new SelectField({ name: "who", values: ["a", "b"], maxSelect: 1, required: true }));
  users.listRule = AUTH;
  users.viewRule = AUTH;
  users.createRule = null;                                            // no sign-ups from the website
  users.updateRule = 'id = @request.auth.id && @request.body.who:isset = false';
  users.deleteRule = null;
  users.authToken.duration = 60 * 60 * 24 * 30;                       // stay signed in for 30 days
  users.fileToken.duration = 60 * 60 * 24 * 3;                        // photo links work for 3 days, then refresh
  users.oauth2.enabled = false;
  users.otp.enabled = false;
  users.mfa.enabled = false;
  users.passwordAuth.enabled = true;
  users.passwordAuth.identityFields = ["email"];
  app.save(users);

  // ---------- meta: the journal's name ----------
  const meta = new Collection({
    type: "base", name: "meta",
    listRule: AUTH, viewRule: AUTH, updateRule: AUTH, createRule: null, deleteRule: null,
    fields: [{ type: "text", name: "title", max: 60 }],
  });
  app.save(meta);
  const m = new Record(meta);
  m.set("title", "Our little journal");
  app.save(m);

  // ---------- pages: journal pages ----------
  const OWN = "owner = @request.auth.id";
  const KEEP_OWNER = '(@request.body.owner:isset = false || @request.body.owner = @request.auth.id)';
  const ONLY_LAYOUT = [
    "title", "date", "place", "note", "cover", "owner",
  ].map((f) => `@request.body.${f}:isset = false`).join(" && ");
  const pages = new Collection({
    type: "base", name: "pages",
    listRule: AUTH, viewRule: AUTH,
    createRule: `${AUTH} && @request.body.owner = @request.auth.id`,
    updateRule: `${AUTH} && ((${OWN} && ${KEEP_OWNER}) || (${ONLY_LAYOUT}))`,
    deleteRule: OWN,
    fields: [
      { type: "text", name: "title", max: 80 },
      { type: "text", name: "date", max: 10 },
      { type: "text", name: "place", max: 60 },
      { type: "text", name: "note", max: 400 },
      { type: "select", name: "layout", values: ["D", "C"], maxSelect: 1 },
      { type: "text", name: "cover", max: 20 },
      { type: "relation", name: "owner", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: false },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
  });
  app.save(pages);

  // ---------- media: photos + videos ----------
  const PAGE_OK = '(@request.body.page:isset = false || @request.body.page = "" || @request.body.page.owner = @request.auth.id)';
  const media = new Collection({
    type: "base", name: "media",
    listRule: AUTH, viewRule: AUTH,
    createRule: `${AUTH} && @request.body.owner = @request.auth.id && ${PAGE_OK}`,
    updateRule: `${OWN} && ${KEEP_OWNER} && ${PAGE_OK}`,
    deleteRule: OWN,
    fields: [
      {
        type: "file", name: "file", required: true, maxSelect: 1, maxSize: 200 * 1024 * 1024, protected: true,
        mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime", "video/x-m4v"],
      },
      { type: "file", name: "poster", maxSelect: 1, maxSize: 5 * 1024 * 1024, protected: true, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
      { type: "select", name: "kind", values: ["image", "video"], maxSelect: 1, required: true },
      { type: "relation", name: "page", collectionId: pages.id, maxSelect: 1, cascadeDelete: true },
      { type: "text", name: "caption", max: 80 },
      { type: "number", name: "w", onlyInt: true },
      { type: "number", name: "h", onlyInt: true },
      { type: "number", name: "duration" },
      { type: "number", name: "size", onlyInt: true },
      { type: "text", name: "name", max: 120 },
      { type: "number", name: "order" },
      { type: "number", name: "addedAt" },
      { type: "relation", name: "owner", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: false },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE INDEX idx_media_page ON media (page)"],
  });
  app.save(media);

  // ---------- hearts + notes ----------
  // target = a media id, or "pg.<page id>" for a journal page
  const MINE = "who = @request.auth.id";
  const hearts = new Collection({
    type: "base", name: "hearts",
    listRule: AUTH, viewRule: AUTH,
    createRule: `${AUTH} && @request.body.who = @request.auth.id`,
    updateRule: null,
    deleteRule: MINE,
    fields: [
      { type: "text", name: "target", required: true, max: 40 },
      { type: "relation", name: "who", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_hearts_target_who ON hearts (target, who)"],
  });
  app.save(hearts);

  const notes = new Collection({
    type: "base", name: "notes",
    listRule: AUTH, viewRule: AUTH,
    createRule: `${AUTH} && @request.body.who = @request.auth.id`,
    updateRule: null,
    deleteRule: MINE,
    fields: [
      { type: "text", name: "target", required: true, max: 40 },
      { type: "relation", name: "who", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true },
      { type: "text", name: "text", required: true, max: 240 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
    ],
    indexes: ["CREATE INDEX idx_notes_target ON notes (target)"],
  });
  app.save(notes);

  // ---------- server settings ----------
  const settings = app.settings();
  settings.meta.appName = "Our little journal";
  settings.backups.cron = "0 3 * * *";      // full backup every night at 03:00 (server time)
  settings.backups.cronMaxKeep = 3;         // keep the last 3
  settings.rateLimits.enabled = true;       // slows down password guessing
  settings.logs.maxDays = 7;
  app.save(settings);
}, (app) => {
  for (const name of ["notes", "hearts", "media", "pages", "meta"]) {
    try { app.delete(app.findCollectionByNameOrId(name)); } catch (_) {}
  }
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("who");
  app.save(users);
});
