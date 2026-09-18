/**
 * bundle.js — turn a cluster into a STORY CANDIDATE.
 *
 * Read this before changing anything here:
 *
 * A candidate is EVIDENCE, not a card. It carries what was actually retrieved —
 * headlines, URLs, timestamps, short excerpts, who covered it, where the numbers
 * disagree — and it leaves every prose field null. `context`, `coverage`,
 * `watch` and each view's `text` are analyst writing. They cannot be derived
 * from RSS, and inventing them from a lean label is precisely what rules 4, 9
 * and 10 forbid. They are written downstream by someone (or something) that has
 * read the retrieved text, and they must be traceable to it.
 *
 * So: this file never produces a sentence that asserts something about the
 * world. If you find yourself writing a template that does, it belongs in the
 * composition step, with the source text in front of it.
 */

import { frameCluster } from "./layers/frame.js";

// --- numeric conflict detection (rule 2) -----------------------------------

const SCALE = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9, trillion: 1e12, tn: 1e12 };

const NUMBER_RE = new RegExp(
  String.raw`([$€£₹]|\bUS\$|\bC\$)?\s?(\d[\d,]*(?:\.\d+)?)\s*` +
  String.raw`(percent|per cent|%|thousand|million|billion|trillion|bn|tn|k|m|b)?`,
  "gi"
);

/** Words near a number that say what it counts. Used to avoid comparing apples to deaths. */
const SUBJECT_WINDOW = 6;

export function extractQuantities(text) {
  const out = [];
  const words = String(text ?? "").split(/\s+/);
  const joined = words.join(" ");
  for (const m of joined.matchAll(NUMBER_RE)) {
    const [, currency, digits, unitRaw] = m;
    const value = Number(String(digits).replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const unit = (unitRaw ?? "").toLowerCase().replace("per cent", "percent").replace("%", "percent");
    if (!currency && !unit && value < 1000) continue; // bare small integers are noise
    const scale = SCALE[unit] ?? 1;
    const before = joined.slice(Math.max(0, m.index - 60), m.index);
    const after = joined.slice(m.index + m[0].length, m.index + m[0].length + 60);
    out.push({
      raw: m[0].trim(),
      value: unit === "percent" ? value : value * scale,
      kind: unit === "percent" ? "percent" : currency ? "currency" : "count",
      currency: currency ?? null,
      subject: subjectWords(before, after),
    });
  }
  return out;
}

function subjectWords(before, after) {
  const words = (after + " " + before).toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return [...new Set(words.slice(0, SUBJECT_WINDOW))];
}

/**
 * Where two outlets give materially different numbers for what looks like the
 * same quantity, that is a conflict the card must SHOW, never average away.
 * This is a heuristic, so its output is `disputedCandidates` — a queue for a
 * human, not a finding.
 */
export function findNumericConflicts(items, { tolerance = 0.05 } = {}) {
  const quantities = [];
  items.forEach((item, index) => {
    for (const q of extractQuantities(`${item.title}. ${item.excerpt}`)) {
      quantities.push({ ...q, index, outlet: item.outlet, url: item.url });
    }
  });

  const conflicts = [];
  for (let a = 0; a < quantities.length; a++) {
    for (let b = a + 1; b < quantities.length; b++) {
      const x = quantities[a], y = quantities[b];
      if (x.outlet === y.outlet) continue;
      if (x.kind !== y.kind) continue;
      if (x.currency && y.currency && x.currency !== y.currency) continue;
      const shared = x.subject.filter(w => y.subject.includes(w));
      if (shared.length < 2) continue; // not obviously the same quantity
      const hi = Math.max(x.value, y.value), lo = Math.min(x.value, y.value);
      if (hi === 0) continue;
      const spread = (hi - lo) / hi;
      if (spread <= tolerance) continue;
      conflicts.push({
        kind: x.kind,
        about: shared.slice(0, 4),
        spread: Number(spread.toFixed(3)),
        readings: [
          { outlet: x.outlet, value: x.raw, url: x.url },
          { outlet: y.outlet, value: y.raw, url: y.url },
        ],
        note: "Automated numeric-disagreement check. Confirm against the sources before this becomes a `disputed` entry.",
      });
    }
  }
  return dedupeConflicts(conflicts);
}

function dedupeConflicts(list) {
  const seen = new Set();
  return list.filter(c => {
    const key = c.readings.map(r => `${r.outlet}:${r.value}`).sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.spread - a.spread).slice(0, 8);
}

// --- candidate assembly ----------------------------------------------------

/** Map a roster entry to the app's source-list shape, honestly labelled. */
function sourceEntry(item, roster, article = null) {
  const outlet = roster.get(item.outletId) ?? {};
  const mbfc = outlet.mbfc ?? null;
  return {
    n: item.outlet,
    // Rule 6: a label describes an outlet. Rule 11: an MBFC rating only ships
    // with its MBFC link, so when there is no link there is no MBFC label.
    b: mbfc?.url ? mbfc.bias : (outlet.lean ?? null),
    labelSource: mbfc?.url ? { provider: "mbfc", url: mbfc.url, fetched: mbfc.fetched } : { provider: "roster", note: "hand-assigned when the roster was built; not a rating service" },
    t: item.title,
    u: item.url,
    publishedAt: item.publishedAt,
    retrievedAt: item.retrievedAt,
    // Rule 10: say what was actually read. These three states are different and
    // the card must be able to tell them apart.
    read: article?.ok ? article.read
        : item.excerpt ? "headline and feed excerpt"
        : "headline only",
    // Bounded extracts from the article, when one was read. The body itself was
    // never stored — see backend/src/layers/fetch-article.js.
    ...(article?.ok ? { quotes: article.quotes, figures: article.figures, wordsRead: article.wordCount } : {}),
    ...(article && !article.ok ? { articleError: article.error } : {}),
  };
}

export function buildCandidate(cluster, roster, { verification = null, articles = null } = {}) {
  const framing = frameCluster(cluster);
  const byUrl = articles instanceof Map ? articles : new Map();
  const sources = cluster.items.map(item => sourceEntry(item, roster, byUrl.get(item.url) ?? null));

  const outletNames = [...new Set(cluster.items.map(i => i.outlet))];
  const tier = verification?.primary?.length ? "primary"
             : cluster.outletCount >= 2 ? "multi"
             : "single";

  return {
    // --- retrieved, verifiable ---------------------------------------------
    id: candidateId(cluster),
    regions: regionsFor(cluster),
    firstSeen: cluster.firstSeen,
    lastSeen: cluster.lastSeen,
    outletCount: cluster.outletCount,
    outlets: outletNames,
    tier,
    tierBasis: tier === "primary"
      ? `confirmed against ${verification.primary.length} primary document(s)`
      : tier === "multi"
        ? `reported independently by ${cluster.outletCount} outlets`
        : "single outlet; must ship labelled `1 source` or not at all",
    clustering: cluster.similarity,
    sources,
    views: framing.views,
    axis: framing.axis,
    offAxis: framing.offAxis,
    verification: verification ?? { attempted: false, reason: "no primary-document source mapped for this topic yet" },
    // Run the disagreement check over the article extracts too when we have
    // them — that is where the contested figures usually live, not the headline.
    disputedCandidates: findNumericConflicts(cluster.items.map(item => {
      const a = byUrl.get(item.url);
      return a?.ok
        ? { ...item, excerpt: [item.excerpt, ...a.quotes, ...a.figures.map(f => f.context)].join(" ") }
        : item;
    })),

    // --- written downstream, from the retrieved text only -------------------
    headline: null,
    sub: null,
    cat: null,
    dateline: null,
    context: null,
    facts: null,
    disputed: null,
    coverage: null,
    watch: null,
    _prose: "unwritten: context, facts, disputed, coverage, watch and each view's text require reading the sources. Do not fill these from the fields above.",
  };
}

function candidateId(cluster) {
  const basis = cluster.items.map(i => i.url).sort().join("|");
  let h = 2166136261;
  for (let i = 0; i < basis.length; i++) { h ^= basis.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "c" + (h >>> 0).toString(36);
}

const REGION_OF_COUNTRY = {
  CA: "Canada", US: "Global", IN: "India", UK: "Europe", DE: "Europe", FR: "Europe",
  EU: "Europe", IL: "Global", QA: "Global", SA: "Global", CN: "Global", TW: "Global",
  HK: "Global", JP: "Global",
};

function regionsFor(cluster) {
  const regions = new Set();
  for (const c of cluster.countries) if (REGION_OF_COUNTRY[c]) regions.add(REGION_OF_COUNTRY[c]);
  if (!regions.size) regions.add("Global");
  return [...regions];
}

export const _internals = { sourceEntry, dedupeConflicts, REGION_OF_COUNTRY };
