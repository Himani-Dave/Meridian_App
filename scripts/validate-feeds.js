#!/usr/bin/env node
/**
 * validate-feeds.js — check every feed URL in config/sources.json.
 *
 * Each feed in the roster is a CONVENTIONAL GUESS marked "verified": false.
 * Several will be wrong or dead. This script finds out which, tries the common
 * fallbacks, and flips "verified" to true only on an actual successful fetch.
 *
 * The balance check at the end is the point. A silently missing right-leaning
 * feed reintroduces exactly the skew the roster exists to prevent, so this
 * exits non-zero when any lean bucket loses all its feeds.
 *
 * Usage:
 *   node scripts/validate-feeds.js                 # report only
 *   node scripts/validate-feeds.js --write         # update config/sources.json
 *   node scripts/validate-feeds.js --discover      # probe fallbacks for failures
 *
 * Requires Node 18+ (global fetch). No dependencies, no API keys.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ALTERNATES, HOMEPAGES, inspect, sniffAllFeeds } from "./feed-discovery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(__dirname, "..", "config", "sources.json");
const REPORT = join(__dirname, "..", "config", "feed-report.md");

const WRITE    = process.argv.includes("--write");
const DISCOVER = process.argv.includes("--discover");

// Identifies itself, but leads with the Mozilla token. Many WAFs reject any
// User-Agent without it outright, which is what the 403s from AP, the
// Washington Times, the Indian Express and the Times of Israel look like —
// a blanket rule, not a policy against feed readers. This still says who it is
// and links to the project, so it is identification, not disguise.
const UA = "Mozilla/5.0 (compatible; Meridian/0.1; +https://github.com/Himani-Dave/Meridian_App)";
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;          // be polite; these are other people's servers
const FALLBACKS = [
  "/feed", "/feed/", "/rss", "/rss.xml", "/index.xml", "/atom.xml",
  // Patterns that show up on Indian news sites specifically, which is where
  // every remaining gap is: The Hindu, Indian Express, The Print, The Wire,
  // Scroll.in, Swarajya and Organiser were all still unverified.
  "/feed/rss", "/rss/", "/rssfeeds", "/?feed=rss2", "/feeds/posts/default",
  "/section/india/feed/", "/rss/india", "/latest/feed",
];

// ---------------------------------------------------------------------------

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }
    });
    const body = await res.text();
    return { status: res.status, finalUrl: res.url, type: res.headers.get("content-type") ?? "", body };
  } finally {
    clearTimeout(timer);
  }
}

async function check(entry) {
  const result = { id: entry.id, name: entry.name, lean: entry.lean ?? null,
                   country: entry.country ?? entry.region ?? null,
                   url: entry.feed, ok: false, items: 0, note: "" };

  if (!entry.feed) {
    result.note = "no feed url in roster";
    // With no url there is no origin to sniff, so a candidate list is the only
    // way in. `homepage` in the roster gives one when a feed url does not.
    const seed = ALTERNATES[entry.id]?.[0] ?? HOMEPAGES[entry.id] ?? entry.homepage;
    if (DISCOVER && seed) {
      const found = await discover(seed, null, entry.id).catch(() => null);
      if (found) {
        result.ok = true; result.suggested = found.url; result.items = found.items;
        result.note = `had no url in the roster; found ${found.how}`;
      }
    }
    return result;
  }

  try {
    const res = await get(entry.feed);
    const { isFeed, items } = inspect(res.body, res.type);

    if (res.status === 200 && isFeed) {
      result.ok = true;
      result.items = items;
      if (res.finalUrl !== entry.feed) { result.redirected = res.finalUrl; result.note = "redirected"; }
      if (items === 0) { result.ok = false; result.note = "parses as a feed but has 0 items"; }
      return result;
    }

    result.note = res.status !== 200 ? `HTTP ${res.status}`
                : isFeed ? "unexpected" : "200 but not a feed (probably an HTML page)";

    if (DISCOVER) {
      const found = await discover(entry.feed, res, entry.id);
      if (found) { result.ok = true; result.suggested = found.url; result.items = found.items;
                   result.note = `original failed (${result.note}); found ${found.how}`; }
    }
  } catch (err) {
    result.note = err.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(err.message ?? err);
    if (DISCOVER) {
      try {
        const found = await discover(entry.feed, null, entry.id);
        if (found) { result.ok = true; result.suggested = found.url; result.items = found.items;
                     result.note = `original failed (${result.note}); found ${found.how}`; }
      } catch { /* keep the original error */ }
    }
  }
  return result;
}

/** Try the site's homepage <link> tag, then common feed paths. */
async function discover(originalUrl, firstResponse, entryId = null) {
  const origin = new URL(originalUrl).origin;
  const tried = new Set([originalUrl]);

  const attempt = async (candidate, how) => {
    if (!candidate || tried.has(candidate)) return null;
    tried.add(candidate);
    const r = await get(candidate).catch(() => null);
    if (r?.status !== 200) return null;
    const i = inspect(r.body, r.type);
    return i.isFeed && i.items > 0 ? { url: candidate, items: i.items, how } : null;
  };

  // 1. Per-outlet candidates: specific guesses about a known outlet.
  for (const candidate of ALTERNATES[entryId] ?? []) {
    const hit = await attempt(candidate, "from the candidate list");
    if (hit) return hit;
  }

  // 2. What the failed page itself declared, if it returned HTML.
  if (firstResponse?.body && !/xml/i.test(firstResponse.type ?? "")) {
    for (const candidate of sniffAllFeeds(firstResponse.body, origin)) {
      const hit = await attempt(candidate, "declared on the page that failed");
      if (hit) return hit;
    }
  }

  // 3. Ask the homepage. This is the step that was missing entirely, and it is
  //    the one most likely to work: the outlet tells you where its feed is.
  const home = await get(origin + "/").catch(() => null);
  if (home?.status === 200 && home.body) {
    for (const candidate of sniffAllFeeds(home.body, origin)) {
      const hit = await attempt(candidate, "declared in the homepage <head>");
      if (hit) return hit;
    }
  }

  // 4. Generic paths, last, because they are pure guesswork.
  for (const path of FALLBACKS) {
    const hit = await attempt(origin + path, `at ${path}`);
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pool(items, worker, limit) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) out[i] = await worker(items[i++]);
  }));
  return out;
}

// ---------------------------------------------------------------------------

const config = JSON.parse(await readFile(CONFIG, "utf8"));
const targets = [
  ...config.outlets.map(o => ({ ...o, _bucket: "outlets" })),
  ...config.primary.filter(p => p.feed).map(p => ({ ...p, _bucket: "primary" }))
];

console.log(`Checking ${targets.length} feeds${DISCOVER ? " (with fallback discovery)" : ""}...\n`);
const results = await pool(targets, check, CONCURRENCY);

const ok     = results.filter(r => r.ok);
const failed = results.filter(r => !r.ok);

for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  const extra = r.suggested ? `  -> USE: ${r.suggested}` : r.redirected ? `  -> ${r.redirected}` : "";
  console.log(`${mark}  ${String(r.name).padEnd(26)} ${r.ok ? `${r.items} items` : r.note}${extra}`);
}

// --- balance check: the guardrail, not a nicety --------------------------
const byLean = {};
for (const r of results.filter(r => r._bucket !== "primary" && r.lean)) {
  byLean[r.lean] ??= { total: 0, ok: 0 };
  byLean[r.lean].total++;
  if (r.ok) byLean[r.lean].ok++;
}

console.log(`\n${ok.length}/${results.length} feeds verified\n`);
console.log("Balance by lean (verified / total):");
const empty = [];
for (const [lean, c] of Object.entries(byLean).sort()) {
  console.log(`  ${lean.padEnd(20)} ${c.ok}/${c.total}`);
  if (c.ok === 0 && c.total > 0) empty.push(lean);
}

const report = [
  `# Feed validation report`,
  ``,
  `Run: ${new Date().toISOString()}`,
  `Verified: ${ok.length}/${results.length}`,
  ``,
  `## Balance by lean`,
  ``,
  ...Object.entries(byLean).sort().map(([l, c]) => `- ${l}: ${c.ok}/${c.total} verified`),
  ``,
  `## Failures`,
  ``,
  ...(failed.length ? failed.map(r => `- **${r.name}** (${r.lean ?? r.country ?? "-"}) — ${r.note}${r.suggested ? ` — try \`${r.suggested}\`` : ""}\n  - tried: \`${r.url ?? "(none)"}\``) : ["None."]),
  ``,
  `## Redirects worth pinning`,
  ``,
  ...(ok.filter(r => r.redirected).map(r => `- **${r.name}**: \`${r.url}\` -> \`${r.redirected}\``) || ["None."])
].join("\n");

await writeFile(REPORT, report, "utf8");
console.log(`\nReport written to config/feed-report.md`);

if (WRITE) {
  const apply = list => list.map(e => {
    const r = results.find(x => x.id === e.id);
    if (!r) return e;
    const next = { ...e };
    if (r.ok) {
      next.verified = true;
      if (r.suggested) next.feed = r.suggested;
      if (r.redirected) next.feed = r.redirected;
      next.feed_checked = new Date().toISOString().slice(0, 10);
    } else {
      next.verified = false;
      next.feed_error = r.note;
      next.feed_checked = new Date().toISOString().slice(0, 10);
    }
    return next;
  });
  config.outlets = apply(config.outlets);
  config.primary = apply(config.primary);
  await writeFile(CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log("config/sources.json updated.");
} else {
  console.log("Dry run. Re-run with --write to update config/sources.json.");
}

if (empty.length) {
  console.error(`\nBALANCE FAILURE: no working feeds for lean: ${empty.join(", ")}`);
  console.error("Fix these before ingesting. A missing side is a silent bias, not a missing feature.");
  process.exit(1);
}
