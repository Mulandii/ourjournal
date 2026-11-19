/// <reference path="../pb_data/types.d.ts" />
// Early versions stored the two people under their own names instead of the generic slots.
// This turns those values into "a"/"b" (first value -> a, second -> b), keeping display names
// and passwords. On a fresh install there's nothing to do.

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const who = users.fields.getByName("who");
  const legacy = who.values.filter((v) => v !== "a" && v !== "b");
  if (!legacy.length) return;

  who.values = [...legacy, "a", "b"];
  app.save(users);

  const slot = {};
  legacy.slice(0, 2).forEach((v, i) => { slot[v] = i === 0 ? "a" : "b"; });
  for (const u of app.findAllRecords("users")) {
    const w = u.getString("who");
    if (!slot[w]) continue;
    if (!u.getString("name")) u.set("name", w.charAt(0).toUpperCase() + w.slice(1));
    u.set("who", slot[w]);
    u.setEmail(slot[w] + "@journal.local");
    app.save(u);
  }

  who.values = ["a", "b"];
  app.save(users);
}, (app) => {});
