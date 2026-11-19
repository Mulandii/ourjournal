#!/usr/bin/env node
// Vercel build step for the free Vercel + Supabase setup: writes pb_public/config.js from the
// SUPABASE_URL and SUPABASE_KEY environment variables you entered when deploying.
import fs from "node:fs";

const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const key = String(process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();

function stop(msg) {
  console.error("\n✗ " + msg + "\n  Fix it in Vercel → your project → Settings → Environment Variables, then Redeploy.\n");
  process.exit(1);
}
if (!url || !key) stop("SUPABASE_URL and SUPABASE_KEY are both needed.");
if (!/^https:\/\//.test(url)) stop("SUPABASE_URL should start with https:// (it looks like https://abcdefgh.supabase.co).");

// Never ship a secret key to the browser.
if (/^sb_secret_/.test(key)) stop("That's your SECRET key. Use the Publishable key (starts with sb_publishable_) or the anon key.");
if (key.split(".").length === 3) {
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString());
    if (payload.role === "service_role") stop("That's the service_role (secret) key. Use the anon / Publishable key instead.");
  } catch (_) { /* not a JWT — fine */ }
}

fs.writeFileSync("pb_public/config.js",
  `// written by tools/vercel-build.mjs\nwindow.JOURNAL_CONFIG = ${JSON.stringify({ backend: "supabase", url, key })};\n`);
console.log("✓ Little Journal configured for Supabase at " + url);
