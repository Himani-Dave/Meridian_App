#!/usr/bin/env node
/**
 * join-mbfc.js — attach MBFC ratings to the 52 outlets in config/sources.json.
 *
 * MBFC's RapidAPI has ONE endpoint and no search: /fetch-data returns every rated
 * source as a single array. The cloud session cannot reach that host, so the fetch
 * happens on a real machine (PowerShell) and the payload arrives here as a file.
 * This script does the join.
 *
 * The join is the risky part, not the fetch. A wrong domain match silently
 * mislabels an outlet's bias, which is the one failure this project cannot ship.
 * So:
 *
 *   - Only an exact registrable-domain match is applied automatically.
 *   - Name-similarity and alias-assisted matches are written to
 *     config/mbfc-review.md for a human to confirm. Nothing lands in
 *     sources.json from a guess.
 *   - A record with no "MBFC URL" is NOT stored at all. CLAUDE.md rule 11:
 *     every displayed rating must link back to MBFC (a licence condition of the
 *     Researcher and Developer tiers). No link, no rating.
 *   - The provider and the fetch date are recorded with every label, because
 *     MBFC revises ratings.
 *
 * Usage:
 *   node scripts/join-mbfc.js path/to/mbfc-payload.json            # apply + report
 *   node scripts/join-mbfc.js path/to/mbfc-payload.json --dry-run  # report only
 *
 * Node 18+. No dependencies.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(__dirname, "..", "config", "sources.json");
const REVIEW = join(__dirname, "..", "config", "mbfc-review.md");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const input = args.find(a => !a.startsWith("--"));

if (!input) {
  console.error("Usage: node scripts/join-mbfc.js <mbfc-payload.json> [--dry-run]");
  process.exit(2);
}

// --- domain normalisation --------------------------------------------------

const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk",
  "co.in", "net.in", "org.in",
  "co.il", "org.il",
  "com.au", "net.au", "org.au",
  "co.jp", "or.jp",
  "com.hk", "com.tw", "org.tw",
  "com.sa", "com.cn", "com.br", "co.kr", "co.za", "com.mx", "com.sg",
]);

function registrable(hostOrUrl) {
  if (!hostOrUrl) return null;
  let host = String(hostOrUrl).trim().toLowerCase();
  if (!host) return null;
  if (host.includes("://")) {
    try { host = new URL(host).hostname; } catch { return null; }
  } else {
    host = host.replace(/^\/+/, "").split("/")[0];
  }
  host = host.replace(/^www\d?\./, "").replace(/\.$/, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const lastTwo = parts.slice(-2).join(".");
  if (parts.length >= 3 && MULTI_PART_TLDS.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}

/**
 * Feed hosts that do not share a registrable domain with the outlet's website.
 * Each one is a deliberate, checkable claim about who owns what — not a guess.
 * Anything matched through this map still goes to the review file.
 */
const DOMAIN_ALIASES = {
  "bbci.co.uk": ["bbc.co.uk", "bbc.com"],        // feeds.bbci.co.uk is the BBC's feed host
  "dj.com": ["wsj.com"],                          // feeds.a.dj.com is Dow Jones' feed host
  "nikkei.com": ["asia.nikkei.com", "nikkei.com"],
  "focustaiwan.tw": ["cna.com.tw", "focustaiwan.tw"],
};

function normaliseName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(the|news|online|daily|post|times|com)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

// --- payload ---------------------------------------------------------------

const raw = JSON.parse(await readFile(input, "utf8"));
const records =
  Array.isArray(raw) ? raw :
  Array.isArray(raw?.data) ? raw.data :
  Array.isArray(raw?.sources) ? raw.sources :
  Array.isArray(raw?.results) ? raw.results :
  null;

if (!records) {
  console.error("Could not find the records array in that file.");
  console.error("Top-level keys:", Object.keys(raw ?? {}).join(", ") || "(not an object)");
  process.exit(2);
}

/** MBFC's field names have spaces and a '#'. Read them case/punctuation-insensitively. */
function field(rec, ...names) {
  const flat = {};
  for (const [k, v] of Object.entries(rec)) flat[k.toLowerCase().replace(/[^a-z]/g, "")] = v;
  for (const n of names) {
    const v = flat[n.toLowerCase().replace(/[^a-z]/g, "")];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

const fetchedOn = (raw?.run ?? raw?.fetched ?? new Date().toISOString()).slice(0, 10);

const byDomain = new Map();
const byName = new Map();
let noUrl = 0;

for (const rec of records) {
  const srcUrl = field(rec, "Source URL", "sourceurl", "url", "domain");
  const dom = registrable(srcUrl);
  if (dom && !byDomain.has(dom)) byDomain.set(dom, rec);
  const nm = normaliseName(field(rec, "Source", "name"));
  if (nm && !byName.has(nm)) byName.set(nm, rec);
  if (!field(rec, "MBFC URL", "mbfcurl")) noUrl++;
}

console.log(`MBFC payload: ${records.length} records, ${byDomain.size} distinct domains.`);
if (noUrl) console.log(`  ${noUrl} records carry no MBFC URL and cannot be displayed (rule 11).`);

// --- join ------------------------------------------------------------------

const config = JSON.parse(await readFile(CONFIG, "utf8"));

const applied = [];
const review = [];
const missed = [];

function ratingFrom(rec, matchedOn) {
  const url = field(rec, "MBFC URL", "mbfcurl");
  if (!url) return null; // rule 11: no link, no rating
  return {
    provider: "mbfc",
    id: field(rec, "Source ID#", "sourceid", "id"),
    url,
    bias: field(rec, "Bias", "bias"),
    factual: field(rec, "Factual Reporting", "factualreporting"),
    credibility: field(rec, "Credibility", "credibility"),
    media_type: field(rec, "Media Type", "mediatype"),
    mbfc_country: field(rec, "Country", "country"),
    mbfc_name: field(rec, "Source", "name"),
    matched_on: matchedOn,
    fetched: fetchedOn,
  };
}

config.outlets = config.outlets.map(outlet => {
  const dom = registrable(outlet.feed) ?? registrable(outlet.site);
  if (!dom) {
    missed.push({ outlet, why: "no feed or site url in the roster to derive a domain from" });
    return outlet;
  }

  // 1. exact registrable-domain match -> apply
  const exact = byDomain.get(dom);
  if (exact) {
    const rating = ratingFrom(exact, `domain ${dom}`);
    if (!rating) {
      missed.push({ outlet, why: `matched ${dom} but that MBFC record has no MBFC URL (rule 11: not stored)` });
      return outlet;
    }
    applied.push({ outlet, rating });
    return { ...outlet, mbfc: rating };
  }

  // 2. curated alias -> review, never auto-applied
  for (const alias of DOMAIN_ALIASES[dom] ?? []) {
    const hit = byDomain.get(registrable(alias) ?? alias);
    if (hit) {
      review.push({ outlet, rec: hit, how: `feed domain ${dom} -> alias ${alias}`, rating: ratingFrom(hit, `alias ${alias}`) });
      return outlet;
    }
  }

  // 3. name match -> review, never auto-applied
  const nameHit = byName.get(normaliseName(outlet.name));
  if (nameHit) {
    review.push({ outlet, rec: nameHit, how: `name match ("${outlet.name}")`, rating: ratingFrom(nameHit, "name") });
    return outlet;
  }

  missed.push({ outlet, why: `no MBFC record for ${dom}` });
  return outlet;
});

// --- report ----------------------------------------------------------------

const lines = [
  `# MBFC join — review queue`,
  ``,
  `Payload: \`${input}\` (${records.length} records, fetched ${fetchedOn})`,
  `Applied automatically: ${applied.length}/${config.outlets.length}`,
  `Needs your confirmation: ${review.length}`,
  `No match: ${missed.length}`,
  ``,
  `Only exact registrable-domain matches were written to sources.json. Everything`,
  `below is a proposal. Confirm or reject each one by hand — a wrong match here`,
  `silently mislabels an outlet's bias, which is the failure this project exists`,
  `to avoid.`,
  ``,
  `## Needs confirmation`,
  ``,
  ...(review.length ? review.flatMap(r => [
    `### ${r.outlet.name} (roster lean: ${r.outlet.lean})`,
    ``,
    `- matched: ${r.how}`,
    `- MBFC record: **${field(r.rec, "Source", "name")}** — ${field(r.rec, "Source URL", "url") ?? "no url"}`,
    `- MBFC bias: ${r.rating?.bias ?? "-"} · factual: ${r.rating?.factual ?? "-"} · credibility: ${r.rating?.credibility ?? "-"}`,
    `- link: ${r.rating?.url ?? "**none — cannot be displayed under rule 11**"}`,
    ``,
  ]) : ["None.", ""]),
  `## No MBFC record found`,
  ``,
  ...(missed.length ? missed.map(m => `- **${m.outlet.name}** (${m.outlet.country}, ${m.outlet.lean}) — ${m.why}`) : ["None."]),
  ``,
  `## Applied`,
  ``,
  ...(applied.length ? applied.map(a =>
    `- **${a.outlet.name}** — MBFC: ${a.rating.bias ?? "-"} / factual ${a.rating.factual ?? "-"} (roster lean: ${a.outlet.lean})`)
    : ["None."]),
  ``,
  `## Roster lean vs MBFC bias — disagreements`,
  ``,
  `The roster's \`lean\` was assigned by hand when the source list was built. Where`,
  `MBFC disagrees, that is worth reading, not auto-resolving. Rule 6: a label`,
  `describes an outlet, never a claim, and never filters or reorders anything.`,
  ``,
  ...(() => {
    const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const map = { left: "left", leftcenter: "lean_left", center: "centre", leastbiased: "centre",
                  rightcenter: "lean_right", right: "right", proscience: "centre" };
    const rows = applied
      .map(a => ({ name: a.outlet.name, roster: a.outlet.lean, mbfc: a.rating.bias, mapped: map[norm(a.rating.bias)] }))
      .filter(r => r.mapped && r.mapped !== r.roster);
    return rows.length
      ? rows.map(r => `- **${r.name}** — roster \`${r.roster}\` vs MBFC \`${r.mbfc}\``)
      : ["None."];
  })(),
].join("\n");

if (DRY) {
  console.log("\n" + lines);
  console.log("\nDry run — config/sources.json not written.");
} else {
  await writeFile(CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
  await writeFile(REVIEW, lines, "utf8");
  console.log(`\nApplied ${applied.length}, queued ${review.length} for review, ${missed.length} unmatched.`);
  console.log("config/sources.json updated; config/mbfc-review.md written.");
}
