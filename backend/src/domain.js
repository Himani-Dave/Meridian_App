/**
 * domain.js — ONE registrable-domain function.
 *
 * There were two, with different multi-part suffix lists. The GDELT copy did
 * not know about net.in, org.in, com.sg, com.mx, gov.uk and others, so
 * `z.net.in` normalised to `net.in` — a public suffix, not a domain. Every
 * `.net.in` outlet would collapse to the same identity, which in this project
 * means attributing one outlet's story to another. That is the failure rule 4
 * exists to prevent, arriving through a util function.
 *
 * Third instance of the same class after the HTTP clients and the entity
 * decoders, which is why it now lives in one place with a test that fails if a
 * second copy appears.
 *
 * This is not a full Public Suffix List. It covers the suffixes the roster's
 * countries actually use, and refuses rather than guessing when a host reduces
 * to a bare suffix.
 */

const MULTI_PART_SUFFIXES = new Set([
  // United Kingdom
  "co.uk", "org.uk", "gov.uk", "ac.uk", "net.uk", "sch.uk",
  // India
  "co.in", "net.in", "org.in", "gov.in", "ac.in", "edu.in",
  // Israel
  "co.il", "org.il", "net.il", "ac.il", "gov.il",
  // Australia
  "com.au", "net.au", "org.au", "gov.au", "edu.au",
  // Japan / Korea
  "co.jp", "or.jp", "ne.jp", "go.jp", "ac.jp", "co.kr", "or.kr", "go.kr",
  // Greater China
  "com.hk", "org.hk", "net.hk", "com.tw", "org.tw", "com.cn", "net.cn",
  "org.cn", "gov.cn", "edu.cn",
  // Elsewhere in the roster's reach
  "com.sg", "com.my", "com.br", "com.mx", "com.ar", "com.tr", "com.sa",
  "com.eg", "com.pk", "com.bd", "com.np", "com.lk", "co.za", "co.ke",
  "co.nz", "com.ph", "com.vn", "or.id", "co.id", "com.ua",
]);

/**
 * The registrable domain for a URL or host, or null when it cannot be
 * determined. Null is a real answer: a caller must not fall back to a
 * suffix, because a suffix matches every site under it.
 */
export function registrable(urlOrHost) {
  if (!urlOrHost) return null;

  let host = String(urlOrHost).trim().toLowerCase();
  if (!host) return null;

  if (host.includes("://")) {
    try { host = new URL(host).hostname; } catch { return null; }
  } else {
    host = host.replace(/^\/+/, "").split("/")[0].split("?")[0];
  }

  host = host.replace(/^www\d?\./, "").replace(/\.$/, "");
  if (!host || host.includes(" ")) return null;

  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null;

  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo)) {
    // Needs three labels to be a real domain under this suffix.
    return parts.length >= 3 ? parts.slice(-3).join(".") : null;
  }
  return lastTwo;
}

/** True when two urls/hosts belong to the same registrable domain. */
export function sameDomain(a, b) {
  const x = registrable(a);
  const y = registrable(b);
  return Boolean(x && y && x === y);
}

export const _internals = { MULTI_PART_SUFFIXES };
