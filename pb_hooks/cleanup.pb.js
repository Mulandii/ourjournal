/// <reference path="../pb_data/types.d.ts" />
// When a photo/video or a journal page is deleted, also remove the hearts and love notes on it
// (including ones the other person wrote, which they couldn't delete themselves), and clear a page
// cover that pointed at a deleted photo.

onRecordAfterDeleteSuccess((e) => {
  const id = e.record.id;
  for (const coll of ["hearts", "notes"]) {
    const recs = e.app.findRecordsByFilter(coll, "target = {:t}", "", 0, 0, { t: id });
    for (const r of recs) e.app.delete(r);
  }
  const pageId = e.record.getString("page");
  if (pageId) {
    try {
      const p = e.app.findRecordById("pages", pageId);
      if (p.getString("cover") === id) { p.set("cover", ""); e.app.save(p); }
    } catch (_) { /* page already gone */ }
  }
  e.next();
}, "media");

onRecordAfterDeleteSuccess((e) => {
  const t = "pg." + e.record.id;
  for (const coll of ["hearts", "notes"]) {
    const recs = e.app.findRecordsByFilter(coll, "target = {:t}", "", 0, 0, { t: t });
    for (const r of recs) e.app.delete(r);
  }
  e.next();
}, "pages");
