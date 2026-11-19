/// <reference path="../pb_data/types.d.ts" />
// Two small public endpoints for the sign-in screen:
//   GET  /api/journal/people  -> the two display names (or {setup:true} on a brand-new server)
//   POST /api/journal/setup   -> first-run setup: creates both accounts. Needs JOURNAL_SETUP_CODE
//                                from the server's environment and only works while no accounts exist.

routerAdd("GET", "/api/journal/people", (e) => {
  const users = e.app.findAllRecords("users");
  return e.json(200, {
    setup: users.length === 0,
    people: users
      .map((u) => ({ slot: u.getString("who"), name: u.getString("name") }))
      .filter((p) => p.slot === "a" || p.slot === "b")
      .sort((x, y) => (x.slot < y.slot ? -1 : 1)),
  });
});

routerAdd("POST", "/api/journal/setup", (e) => {
  const expected = ($os.getenv("JOURNAL_SETUP_CODE") || "").trim();
  if (expected.length < 8) {
    throw new BadRequestError("Setup is switched off. Set JOURNAL_SETUP_CODE (at least 8 characters) on the server and restart it.");
  }
  if (e.app.countRecords("users") > 0) throw new BadRequestError("This journal is already set up.");

  const body = e.requestInfo().body || {};
  if (String(body.code || "").trim() !== expected) throw new ForbiddenError("That setup code isn’t right.");

  const clean = (v, max) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max);
  const people = [
    { slot: "a", name: clean(body.nameA, 24), password: String(body.passwordA || "") },
    { slot: "b", name: clean(body.nameB, 24), password: String(body.passwordB || "") },
  ];
  for (const p of people) {
    if (!p.name) throw new BadRequestError("Both names are needed.");
    if (p.password.length < 8) throw new BadRequestError("Passwords need at least 8 characters.");
  }
  if (people[0].name.toLowerCase() === people[1].name.toLowerCase()) throw new BadRequestError("Use two different names.");
  const title = clean(body.title, 60) || "Our little journal";

  e.app.runInTransaction((tx) => {
    const users = tx.findCollectionByNameOrId("users");
    for (const p of people) {
      const u = new Record(users);
      u.set("who", p.slot);
      u.set("name", p.name);
      u.setEmail(p.slot + "@journal.local");
      u.setPassword(p.password);
      tx.save(u);
    }
    const metas = tx.findAllRecords("meta");
    if (metas.length) { metas[0].set("title", title); tx.save(metas[0]); }
  });

  return e.json(200, { ok: true, people: people.map((p) => ({ slot: p.slot, name: p.name })) });
});
