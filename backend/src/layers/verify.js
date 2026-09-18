/**
 * Layer 2 (verification) — the official document proving it.
 *
 * This is the layer that differentiates Meridian. It is also the layer where
 * pretending is most tempting and most damaging, so the contract is strict:
 *
 *   - A source that is not wired returns { attempted: false, reason }. It does
 *     NOT return an empty success. Rule 3: an unattempted check appears in the
 *     output as unattempted.
 *   - A wired source that finds nothing returns { attempted: true, found: [] }.
 *     "Looked and found nothing" and "never looked" are different facts and the
 *     card must be able to say which happened.
 *   - Nothing here summarises a document. It returns the document's identity —
 *     title, publisher, date, URL — so a human or the composition step can
 *     read it. A primary-source tier granted on the basis of a title match
 *     would be worse than no tier at all.
 *
 * The registry below is mostly `planned`. That is the honest state of this
 * layer: one fetcher works, the rest are named so the gap is visible.
 */

import { getJson } from "../http.js";

/** Terms worth taking to a document registry, pulled from a cluster's headlines. */
function keyTerms(cluster, limit = 6) {
  const counts = new Map();
  for (const item of cluster.items) {
    // Proper nouns and multi-word capitalised runs carry the document-findable
    // terms: agency names, bill numbers, place names.
    const runs = String(item.title).match(/\b([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})\b/g) ?? [];
    for (const r of runs) {
      const term = r.trim();
      if (term.length < 4) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([term]) => term);
}

// --- wired sources ---------------------------------------------------------

/**
 * US Federal Register — full-text search over rules, notices and proclamations.
 * No key, documented rate limits, stable JSON. Good first wiring because a
 * large share of US policy stories turn on a document that lives here.
 */
async function federalRegister(terms, { sinceDays = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString().slice(0, 10);
  const url = new URL("https://www.federalregister.gov/api/v1/documents.json");
  url.searchParams.set("conditions[term]", terms.join(" "));
  url.searchParams.set("conditions[publication_date][gte]", since);
  url.searchParams.set("per_page", "5");
  url.searchParams.set("order", "relevance");
  url.searchParams.set("fields[]", "title");
  url.searchParams.append("fields[]", "html_url");
  url.searchParams.append("fields[]", "publication_date");
  url.searchParams.append("fields[]", "document_number");
  url.searchParams.append("fields[]", "type");
  url.searchParams.append("fields[]", "agencies");

  const res = await getJson(url.href, { respectRobots: false, minGapMs: 1_500 });
  if (!res.ok) return { attempted: true, found: [], error: res.error };

  const docs = Array.isArray(res.json?.results) ? res.json.results : [];
  return {
    attempted: true,
    found: docs.map(d => ({
      title: d.title,
      url: d.html_url,
      published: d.publication_date,
      publisher: (d.agencies ?? []).map(a => a.name).join(", ") || "US Federal Register",
      docType: d.type,
      ref: d.document_number,
      // Explicitly NOT read. A hit is a lead, not a confirmation.
      read: "metadata only — document not retrieved or read",
    })),
  };
}

export const REGISTRY = [
  {
    id: "federal-register",
    name: "US Federal Register",
    country: "US",
    status: "wired",
    appliesTo: c => c.countries.includes("US") || c.items.some(i => /\b(U\.?S\.?|Washington|White House|Congress|Federal)\b/.test(i.title)),
    run: federalRegister,
  },
  // Named, not wired. Each one is a real endpoint from config/sources.json's
  // primary tier; leaving them declared keeps the gap countable instead of
  // invisible.
  { id: "csis-canada",   name: "CSIS public reports",            country: "CA", status: "planned", note: "scrape tier; PDF" },
  { id: "statcan",       name: "Statistics Canada WDS",          country: "CA", status: "planned", note: "no key; 25 req/sec; poll once daily at 08:30 ET" },
  { id: "boc-valet",     name: "Bank of Canada Valet",           country: "CA", status: "planned", note: "no key" },
  { id: "egazette",      name: "India eGazette",                 country: "IN", status: "planned", note: "scrape tier" },
  { id: "pib",           name: "Press Information Bureau",       country: "IN", status: "planned", note: "scrape tier" },
  { id: "mea-india",     name: "India Ministry of External Affairs", country: "IN", status: "planned", note: "scrape tier" },
  { id: "eur-lex",       name: "EUR-Lex CELLAR",                 country: "EU", status: "planned", note: "no key; SPARQL" },
  { id: "eurostat",      name: "Eurostat",                       country: "EU", status: "planned", note: "no key" },
  { id: "congress-gov",  name: "Congress.gov",                   country: "US", status: "planned", note: "needs API_DATA_GOV_KEY" },
  { id: "reliefweb",     name: "ReliefWeb",                      country: "GLOBAL", status: "planned", note: "no key" },
];

/**
 * Attempt primary-document verification for one cluster.
 * Always returns a record of what was and was not tried.
 */
export async function verifyCluster(cluster) {
  const terms = keyTerms(cluster);
  const attempts = [];
  const primary = [];

  for (const source of REGISTRY) {
    if (!source.appliesTo?.(cluster)) {
      attempts.push({ source: source.id, name: source.name, attempted: false, reason: "does not apply to this story's countries or terms" });
      continue;
    }
    if (source.status !== "wired") {
      attempts.push({ source: source.id, name: source.name, attempted: false, reason: `not wired yet${source.note ? ` (${source.note})` : ""}` });
      continue;
    }
    const result = await source.run(terms);
    attempts.push({ source: source.id, name: source.name, ...result, terms });
    for (const doc of result.found ?? []) primary.push({ ...doc, source: source.name });
  }

  const unwired = REGISTRY.filter(s => s.status !== "wired").length;

  return {
    attempted: true,
    terms,
    attempts,
    primary,
    // Rule 3, made unavoidable: this string is meant to be rendered.
    gap: primary.length
      ? null
      : `No primary document found. ${unwired} of ${REGISTRY.length} document sources are not wired yet, so absence here is not evidence of absence.`,
  };
}

export const _internals = { keyTerms, federalRegister };
