/**
 * Article distillation — the depth bridge.
 *
 * The problem this solves: a card built from a headline and a 400-character RSS
 * blurb is thin. The hand-built cards in the app came from reading whole
 * articles, and they read like it.
 *
 * The constraint it respects: the storage convention is headlines, URLs,
 * timestamps and short excerpts — not full article text. Syndication covers
 * linking and extracting, not republication.
 *
 * Those are only in tension if you assume "read" means "store". So this module
 * reads the article in memory, pulls out a small, bounded distillate — a few
 * short quotes, the figures, the attributed statements — and **discards the
 * body**. The article text is never returned to the caller, never written to
 * candidates.json, never committed. What survives is roughly a tweet's worth
 * per source, which is what an extract is.
 *
 * Budgets are hard limits, not guidelines:
 *   - at most MAX_QUOTES quotes per article
 *   - at most MAX_QUOTE_WORDS words per quote
 *   - at most MAX_TOTAL_CHARS characters of quoted material per article
 *
 * If you raise these, you are no longer extracting.
 */

import { get } from "../http.js";

export const MAX_QUOTES = 3;
export const MAX_QUOTE_WORDS = 30;
export const MAX_TOTAL_CHARS = 450;

/**
 * The proportional cap, and the one that actually matters.
 *
 * Fixed caps alone are not enough: three 30-word quotes is a reasonable extract
 * from a 2,000-word investigation and a quarter of a 400-word wire story. An
 * extract has to stay small RELATIVE to the piece, so total quoted material is
 * also capped at this share of the article's word count, whichever binds first.
 */
export const MAX_QUOTED_SHARE = 0.10;

const BLOCK_TAGS = /<\/?(p|div|section|article|main|h[1-6]|li|br|blockquote)[^>]*>/gi;
const DROP_BLOCKS = /<(script|style|nav|footer|aside|form|noscript|figure|header)[^>]*>[\s\S]*?<\/\1>/gi;

function decode(s) {
  return s
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;/gi, "'").replace(/&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"').replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Extract readable paragraphs. Deliberately simple: no DOM, no dependency.
 * It keeps blocks that look like prose (enough words, ends like a sentence)
 * and drops navigation, captions and boilerplate by the same test.
 */
export function paragraphsFrom(html) {
  const body = String(html ?? "")
    .replace(DROP_BLOCKS, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  return body
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map(line => decode(line).replace(/\s+/g, " ").trim())
    .filter(line => {
      const words = line.split(/\s+/).length;
      if (words < 12) return false;                       // nav, bylines, captions
      if (!/[.!?"'”]$/.test(line)) return false;     // fragments
      if (/^(share|subscribe|sign up|read more|advertisement|cookie)/i.test(line)) return false;
      return true;
    });
}

/** Sentences that attribute something to someone — the useful kind for a card. */
const ATTRIBUTION = /\b(said|says|told|according to|wrote|announced|confirmed|denied|warned|argued|stated|testified)\b/i;
const QUOTED = /["“][^"”]{25,}["”]/;

function sentences(paragraphs) {
  const out = [];
  for (const p of paragraphs) {
    for (const s of p.split(/(?<=[.!?][”"']?)\s+(?=[A-Z"“])/)) {
      const t = s.trim();
      if (t.split(/\s+/).length >= 6) out.push(t);
    }
  }
  return out;
}

function trimToWords(sentence, max) {
  const words = sentence.split(/\s+/);
  if (words.length <= max) return sentence;
  return words.slice(0, max).join(" ").replace(/[,;:]$/, "") + " …";
}

/** Figures worth cross-checking between outlets. */
export function figuresFrom(text) {
  const out = [];
  const re = /([$€£₹]|\bUS\$|\bC\$)?\s?(\d[\d,]*(?:\.\d+)?)\s*(percent|per cent|%|thousand|million|billion|trillion|bn|tn)?/gi;
  for (const m of String(text).matchAll(re)) {
    const [whole, currency, digits, unit] = m;
    if (!currency && !unit) continue;
    const context = String(text).slice(Math.max(0, m.index - 50), m.index + whole.length + 50).trim();
    out.push({ value: whole.trim(), context: trimToWords(context, 20) });
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Pick the quotes worth keeping: prefer directly quoted speech, then
 * attributed statements, then the opening of the piece.
 */
export function distil(paragraphs) {
  const all = sentences(paragraphs);
  const scored = all.map((s, i) => ({
    s,
    score: (QUOTED.test(s) ? 3 : 0) + (ATTRIBUTION.test(s) ? 2 : 0) + (i < 3 ? 1 : 0) + (/\d/.test(s) ? 1 : 0),
    i,
  }));

  const articleWords = paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  const wordAllowance = Math.floor(articleWords * MAX_QUOTED_SHARE);

  const quotes = [];
  let charBudget = MAX_TOTAL_CHARS;
  let wordBudget = wordAllowance;

  for (const { s } of scored.sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (quotes.length >= MAX_QUOTES) break;
    if (wordBudget <= 0) break;

    // Trim to whichever cap binds first: the per-quote cap or what is left of
    // the article's proportional allowance.
    const q = trimToWords(s, Math.min(MAX_QUOTE_WORDS, wordBudget));
    const words = q.split(/\s+/).length;
    if (words < 5) continue;                       // a 4-word stub quotes nobody usefully
    if (q.length > charBudget) continue;
    if (quotes.some(existing => existing.slice(0, 40) === q.slice(0, 40))) continue;

    quotes.push(q);
    charBudget -= q.length;
    wordBudget -= words;
  }

  return {
    quotes,
    quotedWords: quotes.join(" ").split(/\s+/).filter(Boolean).length,
    figures: figuresFrom(paragraphs.slice(0, 6).join(" ")),
    paragraphCount: paragraphs.length,
    wordCount: articleWords,
  };
}

/**
 * Fetch one article and return its distillate. The body is local to this
 * function and goes out of scope when it returns — that is the whole design.
 *
 * Returns { ok, read, quotes, figures, wordCount } or { ok:false, error }.
 * A failure is a value: rule 3 means it reaches the run report, not /dev/null.
 */
export async function distilArticle(url) {
  const res = await get(url, { timeoutMs: 20_000 });
  if (!res.ok) {
    return { ok: false, url, error: res.blockedBy ? `${res.blockedBy}: ${res.error}` : res.error };
  }
  if (!/html/i.test(res.contentType ?? "")) {
    return { ok: false, url, error: `not an html page (${res.contentType || "unknown type"})` };
  }

  const paragraphs = paragraphsFrom(res.body);
  if (paragraphs.length < 2) {
    return { ok: false, url, error: "no readable article text found (paywall, JS-rendered, or an unusual layout)" };
  }

  const { quotes, figures, wordCount, paragraphCount } = distil(paragraphs);
  return {
    ok: true,
    url,
    finalUrl: res.finalUrl,
    read: "full article read; short extracts retained",
    quotes,
    figures,
    wordCount,        // provenance only: how much was read, not what it said
    paragraphCount,
    retrievedAt: new Date().toISOString(),
  };
  // res.body and paragraphs are unreachable from here on. Keep it that way.
}

/**
 * Distil the articles behind one cluster, politely and with a budget.
 * Only clusters that survived selection get here — this is the expensive layer.
 */
export async function distilCluster(cluster, { maxArticles = 6 } = {}) {
  const results = [];
  const failures = [];
  for (const item of cluster.items.slice(0, maxArticles)) {
    const d = await distilArticle(item.url);
    if (d.ok) results.push({ outletId: item.outletId, outlet: item.outlet, ...d });
    else failures.push({ layer: "article", source: item.outlet, url: item.url, reason: d.error });
  }
  return { results, failures };
}

export const _internals = { sentences, trimToWords, decode };
