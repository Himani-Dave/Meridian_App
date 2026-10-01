#!/usr/bin/env node
/**
 * ============================================================================
 * DIAGNOSTIC — NOT PART OF THE PIPELINE. Read-only. It changes nothing.
 * ============================================================================
 *
 * Nothing in backend/ imports this file, and `node run.js` never reaches it.
 * It writes exactly one artefact, config/feed-diagnosis.md, and never touches
 * config/sources.json or backend/data.
 *
 * Why it exists: some outlets in the roster are unverified and I had been
 * guessing at why. Several return HTTP 403, which no feed URL can fix — the
 * site is refusing the client, not the address. This tests that directly
 * instead of theorising, by fetching each candidate URL under each candidate
 * User-Agent and printing what happened. The target list is derived from the
 * roster at run time, so it is however many are unverified today.
 *
 * It does NOT write to the roster, does NOT change the pipeline, and honours
 * robots.txt exactly as the pipeline does — a diagnostic that bypassed robots
 * would be measuring something we would never be allowed to do anyway.
 *
 *   node scripts/diagnose-feeds.js                 # the known failures
 *   node scripts/diagnose-feeds.js --id cbc --id torstar
 *   node scripts/diagnose-feeds.js --url https://example.com/feed
 *
 * Writes config/feed-diagnosis.md.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { get, UA } from "../backend/src/http.js";
import { inspect, sniffAllFeeds } from "./feed-discovery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(__dirname, "..", "config", "sources.json");
const REPORT = join(__dirname, "..", "config", "feed-diagnosis.md");

const argv = process.argv.slice(2);
const argList = name => argv.reduce((acc, a, i) => (a === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

/**
 * The agents under test.
 *
 * On `browser`: it is included to ANSWER A QUESTION, not as a proposal. If an
 * outlet accepts only a string claiming to be Chrome, then what we have learned
 * is that the outlet does not want automated clients — and the honest response
 * is to drop it or reach it another way, not to dress up as a browser. Shipping
 * that would misrepresent what Meridian is to the people whose servers it uses.
 * `compatible` is the one I would actually deploy: it names the project, links
 * to it, and merely leads with the token most WAF rules look for.
 */
const AGENTS = [
  {
    key: "current",
    note: "what the pipeline sends today",
    // Imported, never retyped. A hardcoded copy would keep reporting on a
    // string the pipeline had stopped sending — the diagnostic would lie about
    // the one thing it exists to measure.
    ua: UA,
  },
  {
    key: "compatible",
    note: "standard bot form: identifies itself, leads with the Mozilla token",
    ua: "Mozilla/5.0 (compatible; Meridian/0.1; +https://github.com/Himani-Dave/Meridian_App)",
  },
  {
    key: "browser",
    note: "DIAGNOSTIC ONLY — would misrepresent a bot as a person's browser",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  },
];

/**
 * Targets default to every outlet the roster marks unverified — derived, not
 * typed. A hardcoded list drifts: my first draft said "business-standard" where
 * the roster says "bstandard", which is the same silent no-op as the
 * "torontostar"/"torstar" mistake in the candidate list. Deriving it means the
 * diagnostic always matches the roster's actual state.
 */
function unverifiedIds(config) {
  return config.outlets.filter(o => !o.verified).map(o => o.id);
}

async function probe(url, agent) {
  const started = Date.now();
  const res = await get(url, { headers: { "User-Agent": agent.ua } });
  const ms = Date.now() - started;
  if (!res.ok) {
    return { ok: false, note: res.blockedBy ? `robots.txt` : (res.error ?? `HTTP ${res.status}`), ms };
  }
  const { isFeed, items } = inspect(res.body, res.contentType ?? "");
  if (!isFeed) return { ok: false, note: "200, not a feed", ms, body: res.body, contentType: res.contentType };
  if (!items) return { ok: false, note: "feed, 0 items", ms };
  return { ok: true, note: `${items} items`, ms };
}

// ---------------------------------------------------------------------------

const config = JSON.parse(await readFile(CONFIG, "utf8"));
const byId = new Map(config.outlets.map(o => [o.id, o]));

const ids = argList("id").length ? argList("id") : unverifiedIds(config);
const extraUrls = argList("url");

const targets = [
  ...ids.filter(id => byId.has(id)).map(id => byId.get(id)),
  ...extraUrls.map(u => ({ id: "(--url)", name: u, feed: u, country: "", lean: "" })),
];

const missing = ids.filter(id => !byId.has(id));
if (missing.length) console.log(`(no roster entry for: ${missing.join(", ")})\n`);

const rows = [];

for (const outlet of targets) {
  console.log(`\n=== ${outlet.name} ===`);

  // Candidate urls: the roster's, plus whatever the site declares about itself.
  const candidates = [];
  if (outlet.feed) candidates.push({ url: outlet.feed, origin: "roster" });

  // `feed_index` is the outlet's own page listing its feeds. This used to read
  // `outlet.homepage`, a field no roster entry has ever carried, so the branch
  // was dead and a feedless outlet was simply skipped.
  if (outlet.feed_index) candidates.push({ url: outlet.feed_index, origin: "feed_index (a page, probed as-is)" });

  const origin = outlet.feed ? new URL(outlet.feed).origin
               : outlet.feed_index ? new URL(outlet.feed_index).origin : null;

  if (origin) {
    // Sniff the homepage under the agent most likely to be served, so a 403 on
    // the homepage does not hide the feeds the site publishes.
    for (const agent of AGENTS) {
      const home = await get(origin + "/", { headers: { "User-Agent": agent.ua } });
      if (home.ok && home.body) {
        for (const u of sniffAllFeeds(home.body, origin).slice(0, 3)) {
          if (!candidates.some(c => c.url === u)) candidates.push({ url: u, origin: `declared (seen as ${agent.key})` });
        }
        break;
      }
    }
  }

  if (!candidates.length) {
    // Reachable for an outlet with neither a feed url nor a feed_index — the
    // Toronto Star, for instance. Guessing a homepage is how the invented
    // Toronto Star search endpoint got into the roster in the first place, so
    // say what is missing and stop rather than inventing one.
    console.log("  SKIPPED: no feed url and no feed_index in the roster.");
    console.log("           Add a feed_index, or probe one now: --url https://<the outlet's site>/");
    rows.push({ outlet: outlet.name, url: "(none)", origin: "-", results: {} });
    continue;
  }

  for (const cand of candidates) {
    const results = {};
    for (const agent of AGENTS) {
      results[agent.key] = await probe(cand.url, agent);
      const r = results[agent.key];
      console.log(`  ${agent.key.padEnd(11)} ${(r.ok ? "OK  " : "FAIL")} ${r.note.padEnd(22)} ${cand.url.slice(0, 68)}`);
    }
    rows.push({ outlet: outlet.name, url: cand.url, origin: cand.origin, results });
  }
}

// --- report -----------------------------------------------------------------

const verdictFor = row => {
  const r = row.results;
  if (!Object.keys(r).length) return "no candidate url";
  if (r.current?.ok) return "works today — no change needed";
  if (r.compatible?.ok) return "**fixed by the compatible agent** — safe to deploy";
  if (r.browser?.ok) return "only a browser string works — the outlet is refusing automated clients";
  if (Object.values(r).every(x => x.note === "robots.txt")) return "robots.txt forbids it — not ours to take";
  if (Object.values(r).every(x => x.note.startsWith("200, not a feed"))) return "url is wrong, not a client problem";
  return "fails under every agent — not a User-Agent problem";
};

const lines = [
  "# Feed diagnosis",
  "",
  `Run: ${new Date().toISOString()}`,
  "",
  "Read-only. Nothing in the roster or the pipeline was changed by this run.",
  "",
  "## Agents tested",
  "",
  ...AGENTS.map(a => `- **${a.key}** — ${a.note}\n  \`${a.ua}\``),
  "",
  "`browser` is here to identify the cause, not as a proposal. If an outlet",
  "accepts only a string claiming to be Chrome, the finding is that it does not",
  "want automated clients, and the honest response is to drop it or reach it",
  "another way.",
  "",
  "## Results",
  "",
  "| Outlet | URL | source | current | compatible | browser | verdict |",
  "|---|---|---|---|---|---|---|",
  ...rows.map(r => {
    const cell = k => r.results[k] ? (r.results[k].ok ? `OK (${r.results[k].note})` : r.results[k].note) : "-";
    return `| ${r.outlet} | \`${r.url.slice(0, 60)}\` | ${r.origin} | ${cell("current")} | ${cell("compatible")} | ${cell("browser")} | ${verdictFor(r)} |`;
  }),
  "",
  "## What to do with this",
  "",
  "- **fixed by the compatible agent** — change the one User-Agent in `backend/src/http.js`.",
  "- **url is wrong** — the working url from the `source` column goes in the roster.",
  "- **robots.txt forbids it** — the outlet has said no. Drop it from the roster.",
  "- **only a browser string works** — treat as a refusal; do not impersonate a browser.",
  "- **fails under every agent** — something else: IP blocking, JS challenge, or the feed is gone.",
  "",
];

await writeFile(REPORT, lines.join("\n"), "utf8");
console.log(`\nWritten to config/feed-diagnosis.md`);

const fixable = rows.filter(r => verdictFor(r).includes("compatible")).length;
const refusing = rows.filter(r => verdictFor(r).includes("refusing")).length;
console.log(`\n${fixable} would be fixed by the compatible agent; ${refusing} are refusing automated clients.`);
