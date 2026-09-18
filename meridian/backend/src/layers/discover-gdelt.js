/**
 * Layer 1 (discovery), GDELT half — "what happened at all", beyond the roster.
 *
 * GDELT DOC 2.0 needs no key. It is a DISCOVERY source only: it tells Meridian
 * a story exists and which domains carried it. It is never a source of fact —
 * GDELT returns titles and metadata, not article text, so anything it surfaces
 * is `headline only` under rule 10 until an outlet in the roster is read.
 *
 * Its value is catching the thing the roster missed: a story every Indian
 * outlet covered and no Canadian one did is invisible to an RSS-only pipeline,
 * and that asymmetry is exactly what this app is for.
 *
 * Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
 */

import { getJson } from "../http.js";

const ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";

/**
 * GDELT's query language: bare terms are ANDed, quotes phrase-match,
 * sourcecountry:/sourcelang: narrow the corpus. Keep queries narrow — a broad
 * one returns the same wire story 250 times.
 */
export function buildQuery({ terms = [], country = null, language = "english", extra = "" } = {}) {
  const parts = [];
  for (const t of terms) parts.push(/\s/.test(t) ? `"${t}"` : t);
  if (country) parts.push(`sourcecountry:${country}`);
  if (language) parts.push(`sourcelang:${language}`);
  if (extra) parts.push(extra);
  return parts.join(" ");
}

export async function queryGdelt(query, { timespanHours = 72, maxRecords = 100 } = {}) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("timespan", `${timespanHours}h`);
  url.searchParams.set("maxrecords", String(Math.min(maxRecords, 250)));
  url.searchParams.set("sort", "hybridrel");

  // GDELT is a public good running on donated infrastructure. Be gentle.
  const res = await getJson(url.href, { minGapMs: 5_000, respectRobots: false });
  if (!res.ok) return { ok: false, query, error: res.error };

  const articles = Array.isArray(res.json?.articles) ? res.json.articles : [];
  return {
    ok: true,
    query,
    items: articles.map(a => ({
      outletId: null,                 // not in the roster unless matched later
      outlet: a.domain ?? null,
      lean: null,                     // unknown: GDELT does not rate outlets
      country: a.sourcecountry ?? null,
      title: String(a.title ?? "").trim(),
      url: a.url,
      publishedAt: parseSeenDate(a.seendate),
      excerpt: "",                    // GDELT returns no text
      retrievedAt: new Date().toISOString(),
      via: "gdelt",
      read: "headline only",
    })).filter(i => i.title && i.url),
  };
}

/** GDELT stamps are "20260917T143000Z". */
export function parseSeenDate(s) {
  const m = String(s ?? "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${sec}Z`;
}

/**
 * Attach roster identity where GDELT's domain matches a roster outlet, so a
 * GDELT hit can contribute to corroboration. Anything unmatched stays
 * unattributed — an unrated domain never gets a lean.
 */
export function matchToRoster(items, roster) {
  const byDomain = new Map();
  for (const outlet of roster.values()) {
    const d = registrable(outlet.feed);
    if (d) byDomain.set(d, outlet);
  }
  return items.map(item => {
    const d = registrable(item.url);
    const outlet = d ? byDomain.get(d) : null;
    if (!outlet) return item;
    return { ...item, outletId: outlet.id, outlet: outlet.name, lean: outlet.lean ?? null, country: outlet.country ?? item.country };
  });
}

const MULTI = new Set(["co.uk", "org.uk", "co.in", "co.il", "com.au", "co.jp", "com.hk", "com.tw", "com.cn", "com.br", "co.kr", "co.za"]);

export function registrable(urlOrHost) {
  if (!urlOrHost) return null;
  let host = String(urlOrHost).toLowerCase();
  if (host.includes("://")) { try { host = new URL(host).hostname; } catch { return null; } }
  host = host.replace(/^www\d?\./, "").split("/")[0];
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const lastTwo = parts.slice(-2).join(".");
  return parts.length >= 3 && MULTI.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}
