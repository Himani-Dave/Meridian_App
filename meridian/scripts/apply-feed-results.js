#!/usr/bin/env node
/**
 * apply-feed-results.js — apply the output of scripts/validate-feeds.ps1.
 *
 * The cloud session cannot reach news domains (host allowlist), so feed checking
 * happens on a real machine via the PowerShell script and comes back as JSON.
 * This applies that JSON to config/sources.json and writes config/feed-report.md.
 *
 * It flips "verified" to true ONLY where the run recorded an actual successful
 * fetch. Failures are recorded with their reason, never quietly dropped — a
 * silently missing right-leaning feed is the exact skew the roster exists to
 * prevent, so a lean bucket with zero working feeds exits non-zero.
 *
 * Usage:
 *   node scripts/apply-feed-results.js path/to/meridian-feed-results.json
 *   node scripts/apply-feed-results.js results.json --dry-run
 *
 * Node 18+. No dependencies.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(__dirname, "..", "config", "sources.json");
const REPORT = join(__dirname, "..", "config", "feed-report.md");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const input = args.find(a => !a.startsWith("--"));

if (!input) {
  console.error("Usage: node scripts/apply-feed-results.js <meridian-feed-results.json> [--dry-run]");
  process.exit(2);
}

const payload = JSON.parse(await readFile(input, "utf8"));
const results = payload.results ?? payload;
if (!Array.isArray(results)) {
  console.error("Unrecognised results file: expected a `results` array.");
  process.exit(2);
}

const config = JSON.parse(await readFile(CONFIG, "utf8"));
const today = (payload.run ?? new Date().toISOString()).slice(0, 10);
const byId = new Map(results.map(r => [r.id, r]));

const changes = [];

const apply = list => list.map(entry => {
  const r = byId.get(entry.id);
  if (!r) return entry;

  const next = { ...entry };
  next.feed_checked = today;

  if (r.ok) {
    const replacement = r.suggested ?? r.redirected ?? null;
    if (replacement && replacement !== entry.feed) {
      changes.push({ id: entry.id, name: entry.name, from: entry.feed, to: replacement, why: r.note || "" });
      next.feed = replacement;
    }
    next.verified = true;
    next.feed_items = r.items ?? null;
    delete next.feed_error;
  } else {
    next.verified = false;
    next.feed_error = r.note || `HTTP ${r.status ?? "?"}`;
  }
  return next;
});

config.outlets = apply(config.outlets);
config.primary = apply(config.primary);

// --- report ---------------------------------------------------------------

const ok = results.filter(r => r.ok);
const failed = results.filter(r => !r.ok);

const byLean = {};
for (const r of results.filter(r => r.bucket !== "primary" && r.lean)) {
  byLean[r.lean] ??= { total: 0, ok: 0 };
  byLean[r.lean].total++;
  if (r.ok) byLean[r.lean].ok++;
}

const unmatched = results.filter(r => {
  const all = [...config.outlets, ...config.primary];
  return !all.some(e => e.id === r.id);
});

const report = [
  `# Feed validation report`,
  ``,
  `Checked on: ${payload.host ?? "unknown host"} (PowerShell ${payload.psVersion ?? "?"})`,
  `Run: ${payload.run ?? "unknown"}`,
  `Fallback discovery: ${payload.discover === false ? "off" : "on"}`,
  `Verified: ${ok.length}/${results.length}`,
  ``,
  `This ran on a personal machine, not in the cloud session — that session's network`,
  `reaches an allowlist of hosts and news domains are not on it.`,
  ``,
  `## Balance by lean`,
  ``,
  ...Object.entries(byLean).sort().map(([l, c]) => `- ${l}: ${c.ok}/${c.total} verified`),
  ``,
  `## URL changes applied`,
  ``,
  ...(changes.length
    ? changes.map(c => `- **${c.name}**\n  - was: \`${c.from}\`\n  - now: \`${c.to}\`\n  - ${c.why}`)
    : ["None."]),
  ``,
  `## Still failing`,
  ``,
  ...(failed.length
    ? failed.map(r => `- **${r.name}** (${r.lean ?? r.country ?? "-"}) — ${r.note}\n  - tried: \`${r.url}\``)
    : ["None."]),
  ``,
  ...(unmatched.length
    ? [`## In results but not in the roster`, ``, ...unmatched.map(r => `- ${r.id} (${r.name})`), ``]
    : []),
].join("\n");

if (DRY) {
  console.log(report);
  console.log("\nDry run — config/sources.json not written.");
} else {
  await writeFile(CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
  await writeFile(REPORT, report, "utf8");
  console.log(`config/sources.json updated (${ok.length}/${results.length} verified, ${changes.length} URL changes).`);
  console.log(`config/feed-report.md written.`);
}

const empty = Object.entries(byLean).filter(([, c]) => c.ok === 0 && c.total > 0).map(([l]) => l);
if (empty.length) {
  console.error(`\nBALANCE FAILURE: no working feeds for lean: ${empty.join(", ")}`);
  console.error("Fix these before ingesting. A missing side is a silent bias, not a missing feature.");
  process.exit(1);
}
