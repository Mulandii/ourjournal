#!/usr/bin/env node
// Import a backup zip made by the journal's "Download a backup" button into the PocketBase server.
//
//   PB_URL=https://journal.example.com PB_ADMIN_EMAIL=... PB_ADMIN_PASSWORD=... \
//     node server/tools/import_backup.mjs path/to/our-little-journal-backup-YYYY-MM-DD.zip [more-parts.zip ...]
//
// Needs Node 18+ and the `unzip` command. Signs in as the server's superuser, so ownership is kept
// exactly as in the backup. Refuses to run twice (if pages or media already exist) unless --force.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const force = args.includes("--force");
const inputs = args.filter((a) => !a.startsWith("--"));
const URL_ = (process.env.PB_URL || "").replace(/\/$/, "");
const EMAIL = process.env.PB_ADMIN_EMAIL, PASS = process.env.PB_ADMIN_PASSWORD;
if (!URL_ || !EMAIL || !PASS || !inputs.length) {
  console.error("usage: PB_URL=… PB_ADMIN_EMAIL=… PB_ADMIN_PASSWORD=… node import_backup.mjs backup.zip [part2.zip …] [--force]");
  process.exit(2);
}

// ---- unpack every part into one folder
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-import-"));
for (const z of inputs) {
  if (fs.statSync(z).isDirectory()) fs.cpSync(z, dir, { recursive: true });
  else execFileSync("unzip", ["-q", "-o", z, "-d", dir]);
}
const data = JSON.parse(fs.readFileSync(path.join(dir, "backup.json"), "utf8"));
console.log(`backup from ${data.exportedAt}: ${data.pages.length} pages, ${data.media.length} photos/videos, ${data.hearts.length} hearts, ${data.notes.length} notes`);

// ---- tiny API helper
let token = "";
async function api(p, { method = "GET", body, form } = {}) {
  const headers = token ? { Authorization: token } : {};
  if (body) headers["Content-Type"] = "application/json";
  const r = await fetch(URL_ + p, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const txt = await r.text();
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (_) { d = txt; }
  if (!r.ok) { const e = new Error(`${method} ${p} → ${r.status} ${JSON.stringify(d)}`); e.status = r.status; throw e; }
  return d;
}
const list = async (c, q = "") => (await api(`/api/collections/${c}/records?perPage=500${q}`)).items;

token = (await api("/api/collections/_superusers/auth-with-password", { method: "POST", body: { identity: EMAIL, password: PASS } })).token;

const users = await list("users");
const bySlot = Object.fromEntries(users.map((u) => [u.who, u.id]));
if (!bySlot.a || !bySlot.b) throw new Error("both accounts must exist on the server first (finish the setup screen)");
// People in the backup are matched in order: the first person -> slot "a", the second -> slot "b".
// (Backups from this app use "a"/"b"; older ones used names.)
const backupKeys = Object.keys(data.people || {});
const uid = { a: bySlot.a, b: bySlot.b };
backupKeys.forEach((k, i) => { if (!uid[k]) uid[k] = i === 0 ? bySlot.a : bySlot.b; });
const ownerId = (w) => uid[w] || bySlot.a;   // anything without an owner goes to the first person

if (!force) {
  const [p, m] = await Promise.all([list("pages", "&perPage=1"), list("media", "&perPage=1")]);
  if (p.length || m.length) { console.error("The server already has pages or photos. Re-run with --force to import anyway (it will add duplicates)."); process.exit(1); }
}

// ---- journal name
const meta = (await list("meta"))[0];
if (meta && data.journalTitle) await api(`/api/collections/meta/records/${meta.id}`, { method: "PATCH", body: { title: data.journalTitle } });

// ---- pages
const pageMap = {};
for (const p of data.pages) {
  const rec = await api("/api/collections/pages/records", { method: "POST", body: {
    title: p.title || "", date: p.date || "", place: p.place || "", note: p.note || "",
    layout: ["D", "C"].includes(p.layout) ? p.layout : "D", owner: ownerId(p.owner),
  } });
  pageMap[p.id] = rec.id;
}
console.log(`pages: ${Object.keys(pageMap).length}`);

// ---- photos + videos
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
const mediaMap = {};
let n = 0, missing = 0;
for (const m of data.media) {
  const file = path.join(dir, m.file);
  if (!fs.existsSync(file)) { missing++; console.warn(`  missing file: ${m.file}`); continue; }
  const ext = path.extname(file).slice(1).toLowerCase();
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], { type: TYPES[ext] || "application/octet-stream" }), path.basename(file));
  if (m.poster && fs.existsSync(path.join(dir, m.poster))) form.append("poster", new Blob([fs.readFileSync(path.join(dir, m.poster))], { type: "image/jpeg" }), "poster.jpg");
  const fields = {
    kind: m.kind === "video" ? "video" : "image", page: (m.pageId && pageMap[m.pageId]) || "", caption: m.caption || "",
    w: Math.round(m.width || 0), h: Math.round(m.height || 0), duration: m.duration || 0, size: fs.statSync(file).size,
    name: (m.originalName || path.basename(file)).slice(0, 120), order: n, addedAt: m.addedAt || Date.now(), owner: ownerId(m.owner),
  };
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  const rec = await api("/api/collections/media/records", { method: "POST", form });
  mediaMap[m.id] = rec.id;
  n++;
  process.stdout.write(`\r  photos/videos: ${n}/${data.media.length}`);
}
console.log(missing ? `\n  (${missing} files were missing from the zip — import every part together)` : "");

// ---- covers
for (const p of data.pages) {
  if (p.coverId && mediaMap[p.coverId]) await api(`/api/collections/pages/records/${pageMap[p.id]}`, { method: "PATCH", body: { cover: mediaMap[p.coverId] } });
}

// ---- hearts + notes (target = media id, or "pg.<page id>")
const target = (on) => on && on.startsWith("pg.") ? (pageMap[on.slice(3)] ? "pg." + pageMap[on.slice(3)] : null) : (mediaMap[on] || null);
let h = 0, t = 0;
for (const x of data.hearts) {
  const tg = target(x.on); if (!tg || !uid[x.who]) continue;
  try { await api("/api/collections/hearts/records", { method: "POST", body: { target: tg, who: uid[x.who] } }); h++; } catch (e) { if (e.status !== 400) throw e; }
}
for (const x of [...data.notes].sort((a, b) => (a.at || 0) - (b.at || 0))) {
  const tg = target(x.on); if (!tg || !uid[x.who] || !x.text) continue;
  await api("/api/collections/notes/records", { method: "POST", body: { target: tg, who: uid[x.who], text: String(x.text).slice(0, 240) } }); t++;
}
console.log(`hearts: ${h}, notes: ${t}`);
fs.rmSync(dir, { recursive: true, force: true });
console.log("Import finished ♡");
