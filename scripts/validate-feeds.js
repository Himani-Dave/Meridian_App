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

/**
 * ONE http client, shared with the ingestion pipeline.
 *
 * This file used to carry its own fetch: a different User-Agent, a 15s timeout,
 * six concurrent requests with no per-host gap, no retry, and — the damaging
 * one — no robots.txt check at all. The pipeline's client differs on every one
 * of those points.
 *
 * So "verified: true" meant "reachable by a client that does not exist in this
 * system", and that single divergence produced most of this project's failures:
 * fourteen feeds that validated and were then refused at ingest by robots.txt,
 * a Toronto Star url that passed with no retry and then 429'd, and 403s that
 * moved between runs because the two clients sent different agents.
 *
 * Validation must exercise the client that will do the reading. If this file
 * grows its own fetch again, test/integrity.test.js fails.
 */
import { get as politeGet } from "../backend/src/http.js";

const CONCURRENCY = 6;   // across hosts; http.js serialises per host itself

const FALLBACKS = [
  "/feed", "/feed/", "/rss", "/rss.xml", "/index.xml", "/atom.xml",
  // Patterns common on Indian news sites, which is where the gaps are.
  "/feed/rss", "/rss/", "/rssfeeds", "/?feed=rss2", "/feeds/posts/default",
  "/section/india/feed/", "/rss/india", "/latest/feed",
];

// ---------------------------------------------------------------------------

/** Adapt the pipeline client's result into the shape this script works in. */
async function get(url) {
  const res = await politeGet(url);
  if (res.ok) {
    return { ok: true, status: res.status, finalUrl: res.finalUrl, type: res.contentType ?? "", body: res.body };
  }
  return {
    ok: false,
    status: res.status ?? 0,
    finalUrl: res.finalUrl ?? url,
    type: "",
    body: "",
    blockedBy: res.blockedBy ?? null,
    // A robots refusal and an HTTP error are different facts and must read
    // differently in the report.
    error: res.blockedBy
      ? "refused by robots.txt — the ingest pipeline will refuse it too"
      : (res.error ?? `HTTP ${res.status ?? "?"}`),
  };
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
    if (!res.ok) {
      result.note = res.error;
      if (res.blockedBy) result.blockedBy = res.blockedBy;
      if (DISCOVER) {
        const found = await discover(entry.feed, null, entry.id).catch(() => null);
        if (found) {
          result.ok = true; result.suggested = found.url; result.items = found.items;
          result.note = `original failed (${res.error}); found ${found.how}`;
        }
      }
      return result;
    }
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
    result.note = String(err.message ?? err);
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
/**
 * Discovery is now polite (one request per host at a time, 1.2s apart), so it
 * is also slow: ~15 requests per failing outlet. Bounded so a pathological
 * roster can never run the job into its timeout.
 */
const MAX_PROBES_PER_OUTLET = 10;

async function discover(originalUrl, firstResponse, entryId = null) {
  const origin = new URL(originalUrl).origin;
  const tried = new Set([originalUrl]);

  const attempt = async (candidate, how) => {
    if (!candidate || tried.has(candidate)) return null;
    if (tried.size > MAX_PROBES_PER_OUTLET) return null;
    tried.add(candidate);
    const r = await get(candidate).catch(() => null);
    if (!r?.ok) return null;
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
  if (home?.ok && home.body) {
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
      next.feed_items = r.items ?? null;
      // A passing feed must not keep a failure note from an earlier run.
      // Haaretz and Focus Taiwan both carried verified:true alongside a stale
      // "HTTP 404", which is a record that contradicts itself.
      delete next.feed_error;
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
