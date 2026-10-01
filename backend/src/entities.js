/**
 * entities.js — ONE HTML entity decoder.
 *
 * There used to be two: one in discover-rss.js and one in fetch-article.js.
 * I fixed hex references (`&#x27;`) in the first and not the second, so feed
 * titles came out clean while article quotes still read
 * "Trump&#x27;s comments". Exactly the failure mode as the two HTTP clients —
 * a fix applied to one copy and not the other.
 *
 * If a third decoder appears, test/integrity.test.js fails.
 */

const NAMED = {
  nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  mdash: "—", ndash: "–", hellip: "…",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç",
  uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß",
  laquo: "«", raquo: "»", deg: "°", pound: "£", euro: "€",
};

function safeChar(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/** Decimal AND hex numeric references, plus the named entities above. */
export function decodeEntitiesOnce(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

/**
 * Feeds are routinely double-encoded: the source carries `&amp;#8217;`, the XML
 * parser decodes that once to `&#8217;`, and the literal entity lands in the
 * stored value. So decoding runs twice.
 */
export function decodeEntities(s) {
  return decodeEntitiesOnce(decodeEntitiesOnce(s));
}

/**
 * Decode a URL taken from a feed.
 *
 * Feed URLs are HTML-escaped inside the XML, so `&` arrives as `&amp;` or
 * `&#038;`. Left undecoded, the query string breaks — a real run stored
 * `?utm_source=RSS_Feed&#038;utm_medium=RSS`, which is not the article's
 * address. Cards link to these, so a mangled url is a broken card.
 */
export function decodeUrl(u) {
  const decoded = decodeEntities(String(u ?? "").trim());
  try {
    // Only accept something that still parses; never invent a url.
    new URL(decoded);
    return decoded;
  } catch {
    return String(u ?? "").trim();
  }
}

export function stripHtml(s) {
  const withoutTags = String(s ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags)
    .replace(/<[^>]+>/g, " ")     // entities can reveal further markup
    .replace(/\s+/g, " ")
    .trim();
}
