#!/usr/bin/env node
/**
 * run.js — one ingestion run.
 *
 *   discovery (RSS + GDELT) -> clustering -> framing -> verification -> candidates
 *
 * Output is two files in ./data:
 *
 *   candidates.json  story candidates: evidence only, prose fields null
 *   run-report.json  every retrieval that failed or was skipped, and why
 *
 * run-report.json is not a log. CLAUDE.md rule 3 makes retrieval failure part
 * of the product: "I could not load X" belongs in the card. A run that quietly
 * drops half the roster and ships a balanced-looking briefing is the exact
 * failure this app exists to prevent, so the balance section below is checked
 * on every run and a lost side is a loud non-zero exit.
 *
 * Usage:
 *   node run.js                       # verified feeds only
 *   node run.js --include-unverified  # ignore the roster's verified flag (noisy)
 *   node run.js --no-gdelt
 *   node run.js --since 48            # lookback hours (default 72)
 *   node run.js --min-outlets 2       # candidates below this ship labelled single
 *   node run.js --dry-run             # print the summary, write nothing
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverRss } from "./src/layers/discover-rss.js";
import { queryGdelt, buildQuery, matchToRoster } from "./src/layers/discover-gdelt.js";
import { clusterItems } from "./src/layers/cluster.js";
import { verifyCluster } from "./src/layers/verify.js";
import { distilCluster } from "./src/layers/fetch-article.js";
import { buildCandidate } from "./src/bundle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(__dirname, "..", "config", "sources.json");
const DATA = join(__dirname, "data");

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OPTS = {
  includeUnverified: flag("include-unverified"),
  gdelt: !flag("no-gdelt"),
  sinceHours: Number(value("since", 72)),
  minOutlets: Number(value("min-outlets", 2)),
  // Reading the articles is what makes a card more than a headline rewrite.
  // It is also the only step that touches outlets' own pages, so it runs on
  // selected clusters only and is capped. --no-articles turns it off.
  articles: !flag("no-articles"),
  maxStories: Number(value("max-stories", 12)),
  dryRun: flag("dry-run"),
};

/** Standing GDELT queries: the beat, not the news. Edit these deliberately. */
const STANDING_QUERIES = [
  { label: "Canada federal", terms: ["Canada"], country: "CA" },
  { label: "India policy", terms: ["India"], country: "IN" },
  { label: "European Union", terms: ["European Union"], country: null },
];

async function main() {
  const started = new Date().toISOString();
  const config = JSON.parse(await readFile(CONFIG, "utf8"));
  const roster = new Map(config.outlets.map(o => [o.id, o]));

  const failures = [];
  const notes = [];

  // --- layer 1: discovery --------------------------------------------------
  const rss = await discoverRss(config.outlets, {
    includeUnverified: OPTS.includeUnverified,
    sinceHours: OPTS.sinceHours,
  });
  failures.push(...rss.failures);
  let items = rss.items;

  console.log(`RSS: ${items.length} items from ${new Set(items.map(i => i.outletId)).size} outlets (${rss.failures.length} sources unavailable)`);

  if (OPTS.gdelt) {
    for (const q of STANDING_QUERIES) {
      const res = await queryGdelt(buildQuery(q), { timespanHours: OPTS.sinceHours });
      if (!res.ok) {
        failures.push({ layer: "discovery", source: `GDELT: ${q.label}`, reason: res.error });
        continue;
      }
      const matched = matchToRoster(res.items, roster);
      const known = matched.filter(i => i.outletId);
      const unknown = matched.length - known.length;
      items = items.concat(known);
      notes.push(`GDELT "${q.label}": ${matched.length} articles, ${known.length} from roster outlets, ${unknown} from outlets not in the roster (discovery only, not ingested).`);
    }
  } else {
    notes.push("GDELT discovery skipped (--no-gdelt).");
  }

  items = dedupeByUrl(items);
  console.log(`Total after GDELT + dedupe: ${items.length} items`);

  // --- clustering ----------------------------------------------------------
  const clusters = clusterItems(items, { windowHours: OPTS.sinceHours });
  const multi = clusters.filter(c => c.outletCount >= OPTS.minOutlets);
  console.log(`Clusters: ${clusters.length} total, ${multi.length} with >= ${OPTS.minOutlets} independent outlets`);

  // --- layers 2-4 ----------------------------------------------------------
  // Only the clusters that will actually become candidates get the expensive
  // treatment: one primary-document lookup and one article fetch per source.
  const selected = multi.slice(0, OPTS.maxStories);
  if (multi.length > selected.length) {
    notes.push(`${multi.length - selected.length} multi-outlet clusters were left out by --max-stories ${OPTS.maxStories}.`);
  }

  const candidates = [];
  let articlesRead = 0;
  for (const cluster of selected) {
    const verification = await verifyCluster(cluster);

    let articles = null;
    if (OPTS.articles) {
      const distilled = await distilCluster(cluster);
      failures.push(...distilled.failures);
      articlesRead += distilled.results.length;
      articles = new Map(distilled.results.map(r => [r.url, r]));
    }

    candidates.push(buildCandidate(cluster, roster, { verification, articles }));
  }
  if (OPTS.articles) console.log(`Articles read: ${articlesRead} (extracts kept, bodies discarded)`);

  // --- balance guardrail ---------------------------------------------------
  const balance = { left: 0, centre: 0, right: 0, none: 0 };
  for (const c of candidates) {
    for (const v of c.views) {
      if (v.outlets.length) balance[v.side]++;
    }
    if (c.views.every(v => !v.outlets.length)) balance.none++;
  }

  const starved = ["left", "centre", "right"].filter(side => balance[side] === 0 && candidates.length > 0);

  const report = {
    startedAt: started,
    finishedAt: new Date().toISOString(),
    options: OPTS,
    counts: {
      rssItems: rss.items.length,
      totalItems: items.length,
      clusters: clusters.length,
      candidates: candidates.length,
      articlesRead,
    },
    balance,
    starvedSides: starved,
    notes,
    failures,
  };

  console.log("\nSide coverage across candidates (how many stories have an outlet on each side):");
  for (const side of ["left", "centre", "right"]) console.log(`  ${side.padEnd(8)} ${balance[side]}/${candidates.length}`);
  if (failures.length) console.log(`\n${failures.length} retrieval failures recorded in run-report.json`);

  if (OPTS.dryRun) {
    console.log("\nDry run — nothing written.");
  } else {
    await mkdir(DATA, { recursive: true });
    await writeFile(join(DATA, "candidates.json"), JSON.stringify(candidates, null, 2) + "\n", "utf8");
    await writeFile(join(DATA, "run-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`\nWrote data/candidates.json (${candidates.length}) and data/run-report.json`);
  }

  if (starved.length) {
    console.error(`\nBALANCE FAILURE: no candidate in this run has an outlet on the ${starved.join(" or ")} side.`);
    console.error("Do not publish this run. A missing side is a silent bias, not a missing feature.");
    process.exitCode = 1;
  }
}

function dedupeByUrl(items) {
  const seen = new Map();
  for (const item of items) {
    const key = canonical(item.url);
    const existing = seen.get(key);
    // Prefer the RSS copy: it carries an excerpt and a known outlet identity.
    if (!existing || (existing.via === "gdelt" && item.via === "rss")) seen.set(key, item);
  }
  return [...seen.values()];
}

function canonical(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|cmpid|smid)/i.test(p)) u.searchParams.delete(p);
    }
    return u.origin + u.pathname.replace(/\/$/, "") + (u.search || "");
  } catch {
    return String(url);
  }
}

main().catch(err => {
  console.error("Run failed:", err);
  process.exit(2);
});
