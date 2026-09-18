/**
 * Layer 1 (discovery), RSS half — read the roster's feeds and normalise items.
 *
 * Storage convention from CLAUDE.md: headline, URL, timestamp and a SHORT
 * excerpt. Not full article text — syndication covers linking and extracts,
 * not republication. EXCERPT_CHARS enforces that; do not raise it to "make
 * clustering better". Better clustering is not worth republishing someone's
 * article.
 */

import { XMLParser } from "fast-xml-parser";
import { get } from "../http.js";

export const EXCERPT_CHARS = 400;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
  cdataPropName: "__cdata",
});

function text(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === "object") {
    if (node.__cdata != null) return text(node.__cdata);
    if (node["#text"] != null) return String(node["#text"]);
  }
  return "";
}

function stripHtml(s) {
  return String(s ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(s) {
  const clean = stripHtml(s);
  if (clean.length <= EXCERPT_CHARS) return clean;
  const cut = clean.slice(0, EXCERPT_CHARS);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return (lastStop > EXCERPT_CHARS * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd()) + " …";
}

function firstLink(entry) {
  // Atom: <link rel="alternate" href="...">; RSS: <link>text</link> or <guid isPermaLink>
  const link = entry.link;
  if (Array.isArray(link)) {
    const alt = link.find(l => (l["@_rel"] ?? "alternate") === "alternate" && l["@_href"]);
    if (alt) return alt["@_href"];
    const any = link.find(l => l?.["@_href"]);
    if (any) return any["@_href"];
    return text(link);
  }
  if (link && typeof link === "object" && link["@_href"]) return link["@_href"];
  const asText = text(link);
  if (asText) return asText;
  const guid = entry.guid;
  if (guid && (typeof guid === "string" || guid["#text"])) {
    const g = text(guid);
    if (/^https?:\/\//i.test(g)) return g;
  }
  return "";
}

function parseDate(...candidates) {
  for (const c of candidates) {
    const s = text(c);
    if (!s) continue;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** Turn a parsed feed document into normalised items. */
export function itemsFromFeed(doc, outlet, retrievedAt = new Date().toISOString()) {
  const channel = doc?.rss?.channel ?? doc?.["rdf:RDF"] ?? null;
  const atom = doc?.feed ?? null;

  let entries = [];
  if (channel) entries = [].concat(channel.item ?? []);
  else if (atom) entries = [].concat(atom.entry ?? []);

  return entries.map(entry => {
    const title = stripHtml(text(entry.title));
    const url = String(firstLink(entry) || "").trim();
    const published = parseDate(
      entry.pubDate, entry.published, entry.updated,
      entry["dc:date"], entry["dcterms:date"]
    );
    const body = entry.description ?? entry.summary ?? entry.content ?? entry["content:encoded"];
    return {
      outletId: outlet.id,
      outlet: outlet.name,
      lean: outlet.lean ?? null,
      country: outlet.country ?? null,
      title,
      url,
      publishedAt: published,
      excerpt: excerpt(text(body)),
      retrievedAt,
      via: "rss",
    };
  }).filter(i => i.title && i.url);
}

/**
 * Fetch every verified feed in the roster.
 * Returns { items, failures } — failures are values, not exceptions (rule 3).
 *
 * Unverified feeds are skipped by default: sources.json says every URL in it is
 * a conventional guess until an actual fetch proves otherwise, and ingesting
 * from a guessed URL is how a wrong outlet ends up attributed.
 */
export async function discoverRss(outlets, { includeUnverified = false, sinceHours = 72 } = {}) {
  const items = [];
  const failures = [];
  const cutoff = Date.now() - sinceHours * 3600_000;

  const targets = outlets.filter(o => o.feed && (includeUnverified || o.verified));
  const skipped = outlets.filter(o => o.feed && !o.verified && !includeUnverified);
  for (const o of skipped) {
    failures.push({ layer: "discovery", source: o.name, id: o.id, reason: "feed url not verified yet; skipped" });
  }
  for (const o of outlets.filter(o => !o.feed)) {
    failures.push({ layer: "discovery", source: o.name, id: o.id, reason: "no feed url in the roster" });
  }

  for (const outlet of targets) {
    const res = await get(outlet.feed);
    if (!res.ok) {
      failures.push({ layer: "discovery", source: outlet.name, id: outlet.id, url: outlet.feed, reason: res.error });
      continue;
    }
    let doc;
    try {
      doc = parser.parse(res.body);
    } catch (err) {
      failures.push({ layer: "discovery", source: outlet.name, id: outlet.id, url: outlet.feed, reason: `unparseable xml: ${err.message}` });
      continue;
    }
    const parsed = itemsFromFeed(doc, outlet, new Date().toISOString());
    if (!parsed.length) {
      failures.push({ layer: "discovery", source: outlet.name, id: outlet.id, url: outlet.feed, reason: "feed parsed but contained no usable items" });
      continue;
    }
    const fresh = parsed.filter(i => !i.publishedAt || new Date(i.publishedAt).getTime() >= cutoff);
    items.push(...fresh);
  }

  return { items, failures };
}

export const _internals = { stripHtml, excerpt, parseDate, firstLink, parser };
