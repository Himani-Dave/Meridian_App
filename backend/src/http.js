/**
 * http.js — the only place in the backend that touches the network.
 *
 * Everything here exists to keep Meridian a well-behaved client of other
 * people's servers, and to make failures visible instead of silent:
 *
 *   - one request per host at a time, with a minimum gap between them
 *   - robots.txt fetched once per host and honoured
 *   - a real, identifying User-Agent with a contact URL
 *   - a hard timeout, and a single retry only on 429/5xx with Retry-After
 *   - every failure returned as a value, never thrown away
 *
 * CLAUDE.md rule 3: when a retrieval fails, that failure belongs in the output.
 * So `get()` never throws for network reasons — it returns {ok:false, error}
 * and the caller records it in the run report.
 */

const UA = "Meridian/0.1 (personal news briefing; +https://claude.ai/artifact/S4nCxu1mrWTLUr2CzrvjPz)";

const DEFAULTS = {
  timeoutMs: 20_000,
  minGapMs: 1_200,        // per host
  maxRetries: 1,
  respectRobots: true,
};

const hostState = new Map();   // host -> { last: epochMs, chain: Promise }
const robotsCache = new Map(); // host -> { rules: [...], fetchedAt }

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

/** Serialise per host and space requests out. */
function schedule(host, minGapMs, fn) {
  const state = hostState.get(host) ?? { last: 0, chain: Promise.resolve() };
  const run = state.chain.then(async () => {
    const wait = Math.max(0, state.last + minGapMs - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      state.last = Date.now();
    }
  });
  state.chain = run.catch(() => {});
  hostState.set(host, state);
  return run;
}

// --- robots.txt ------------------------------------------------------------

/**
 * Deliberately small: group-less parse of User-agent/Disallow/Allow, matching
 * the '*' group and any group naming Meridian. Longest-match wins, Allow beats
 * Disallow at equal length. This is the common subset every major crawler
 * implements; it is not a full RFC 9309 implementation and does not pretend to
 * be. When robots.txt cannot be fetched, we allow — absence is not prohibition.
 */
function parseRobots(text) {
  const rules = [];
  let applies = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      applies = value === "*" || /meridian/i.test(value);
      continue;
    }
    if (!applies) continue;
    if (key === "disallow" || key === "allow") {
      if (value === "" && key === "disallow") continue; // empty Disallow = allow all
      rules.push({ allow: key === "allow", path: value });
    }
  }
  return rules;
}

/**
 * robots.txt patterns are not plain prefixes: `*` matches any sequence and a
 * trailing `$` anchors the end. Truncating at the first `*` — which this used
 * to do — turns the very common `Disallow: /*?` ("no query strings") into
 * `Disallow: /`, a site-wide ban. That silently refused fourteen verified
 * feeds, skewing the roster toward whichever publishers happened not to use
 * wildcard rules.
 */
export function robotsPatternToRegex(pattern) {
  let p = pattern;
  const anchored = p.endsWith("$");
  if (anchored) p = p.slice(0, -1);
  const body = p
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")   // escape regex metacharacters
    .replace(/\*/g, ".*");                   // then restore robots wildcards
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

function robotsAllows(rules, pathname) {
  // Longest matching pattern wins; Allow beats Disallow at equal length.
  let best = null;
  for (const rule of rules) {
    if (!rule.path) continue;
    let re;
    try { re = robotsPatternToRegex(rule.path); } catch { continue; }
    if (!re.test(pathname)) continue;
    const len = rule.path.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) {
      best = { allow: rule.allow, len };
    }
  }
  return best ? best.allow : true;
}

async function loadRobots(origin, opts) {
  const host = hostOf(origin);
  if (robotsCache.has(host)) return robotsCache.get(host).rules;
  let rules = [];
  try {
    const res = await rawFetch(new URL("/robots.txt", origin).href, opts);
    if (res.status === 200 && res.body) rules = parseRobots(res.body);
  } catch {
    rules = []; // unreachable robots.txt does not mean "forbidden"
  }
  robotsCache.set(host, { rules, fetchedAt: Date.now() });
  return rules;
}

// --- fetch -----------------------------------------------------------------

async function rawFetch(url, { timeoutMs, headers } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULTS.timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8",
        "Accept-Language": "en",
        ...headers,
      },
    });
    const body = await res.text();
    return {
      status: res.status,
      finalUrl: res.url,
      contentType: res.headers.get("content-type") ?? "",
      retryAfter: res.headers.get("retry-after"),
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET a URL politely.
 * Returns { ok, status, finalUrl, contentType, body, error, blockedBy }.
 * Never throws for network or HTTP reasons.
 */
export async function get(url, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const host = hostOf(url);
  if (!host) return { ok: false, error: `not a url: ${url}` };

  if (opts.respectRobots) {
    const origin = new URL(url).origin;
    const rules = await schedule(host, opts.minGapMs, () => loadRobots(origin, opts));
    if (!robotsAllows(rules, new URL(url).pathname)) {
      return { ok: false, blockedBy: "robots.txt", error: `robots.txt disallows ${url}` };
    }
  }

  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await schedule(host, opts.minGapMs, () => rawFetch(url, opts));
    } catch (err) {
      const msg = err?.name === "AbortError" ? `timeout after ${opts.timeoutMs}ms` : String(err?.message ?? err);
      if (attempt++ < opts.maxRetries) { await sleep(2_000); continue; }
      return { ok: false, error: msg };
    }

    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (retryable && attempt++ < opts.maxRetries) {
      const after = Number(res.retryAfter);
      await sleep(Number.isFinite(after) ? Math.min(after * 1000, 30_000) : 3_000);
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, finalUrl: res.finalUrl, error: `HTTP ${res.status}` };
    }
    return { ok: true, ...res };
  }
}

export async function getJson(url, options = {}) {
  const res = await get(url, options);
  if (!res.ok) return res;
  try {
    return { ...res, json: JSON.parse(res.body) };
  } catch (err) {
    return { ok: false, status: res.status, error: `response was not JSON: ${String(err.message).slice(0, 120)}` };
  }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export const _internals = { parseRobots, robotsAllows };
export { UA };
