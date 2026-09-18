/**
 * ratings.js — compare bias ratings from two independent providers.
 *
 * Design intent: two rating services using different methods will sometimes
 * disagree about an outlet. That disagreement is INFORMATION, not an error to
 * resolve. When AllSides and MBFC can't agree on where a source sits, that
 * tells the reader more than either label alone.
 *
 * Hard rules (see CLAUDE.md):
 *   - A rating LABELS a source. It never filters, reorders, or weights the
 *     credibility of a fact.
 *   - Always store which provider said it, and when. These get revised.
 *   - Outlets neither provider covers are common (regional, non-Western,
 *     party-affiliated). Fall back to ownership facts, never to a guess.
 *
 * Pure functions plus one fetch for the Wikidata fallback. No API keys here —
 * the caller injects fetched provider payloads.
 */

// ---------------------------------------------------------------------------
// Normalisation. The providers use different scales, so a naive numeric
// comparison manufactures disagreement. Everything maps to one axis:
//   -3 strongly left ... 0 centre ... +3 strongly right
// null means "rated, but not on a left-right axis" (e.g. AllSides "Mixed").
// ---------------------------------------------------------------------------

export const ALLSIDES_SCALE = {
  "left": -2,
  "lean left": -1,
  "center": 0,
  "centre": 0,
  "lean right": 1,
  "right": 2,
  "mixed": null
};

export const MBFC_SCALE = {
  "extreme left": -3,
  "left": -2,
  "left-center": -1,
  "least biased": 0,
  "right-center": 1,
  "right": 2,
  "extreme right": 3
};

/**
 * MBFC attaches these as SEPARATE tags alongside a bias rating — they are not
 * positions on the left-right axis. Confirmed by hand: Organiser carries
 * "RIGHT BIAS" *and* a CONSPIRACY tag simultaneously, so a single-field model
 * would have to throw one of them away.
 *
 * These are credibility signals. Per CLAUDE.md rule 6, they are DISPLAYED and
 * never used to filter, downrank or exclude a source. The 2-sources-or-primary
 * -document threshold already prevents any single outlet's claim from standing
 * alone, so exclusion would buy nothing and cost transparency.
 */
export const MBFC_FLAGS = new Set([
  "conspiracy-pseudoscience", "conspiracy", "questionable",
  "pro-science", "satire"
]);

/** Ad Fontes publishes a continuous bias coordinate, roughly -42..+42. */
export function adFontesToScale(bias) {
  if (bias == null || Number.isNaN(bias)) return null;
  return Math.max(-3, Math.min(3, Math.round(bias / 14)));
}

const norm = s => String(s ?? "").trim().toLowerCase();

/**
 * MBFC returns a bare domain in "Source URL" — "nytimes.com", no protocol,
 * no www. Normalise both sides before matching or lookups silently miss.
 */
export const normaliseDomain = u =>
  String(u ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");

/**
 * Parse a live MBFC record into the internal shape.
 *
 * Real payload (confirmed against the API, not guessed):
 *   { "Source": "The New York Times",
 *     "MBFC URL": "https://mediabiasfactcheck.com/new-york-times/",
 *     "Bias": "Left-Center", "Country": "USA",
 *     "Factual Reporting": "High", "Media Type": "Newspaper",
 *     "Source URL": "nytimes.com", "Credibility": "High",
 *     "Source ID#": 1001 }
 *
 * Note the field names carry spaces and a '#', so bracket access throughout.
 *
 * If "Bias" holds a non-axis value such as "Conspiracy-Pseudoscience", score
 * comes back null and the value lands in flags instead — which routes the
 * outlet to the `unplaced` branch rather than being coerced to centre.
 */
export function parseMbfc(record) {
  const raw = String(record?.["Bias"] ?? "").trim();
  const key = norm(raw);
  return {
    provider: "mbfc",
    mbfc_id: record?.["Source ID#"] ?? null,   // stable integer — key on this, not the name
    name: record?.["Source"] ?? null,
    domain: normaliseDomain(record?.["Source URL"]),
    raw,
    score: MBFC_SCALE[key] ?? null,
    flags: MBFC_FLAGS.has(key) ? [key] : [],
    factual: record?.["Factual Reporting"] ?? null,
    credibility: record?.["Credibility"] ?? null,
    country: record?.["Country"] ?? null,
    mediaType: record?.["Media Type"] ?? null,
    reportUrl: record?.["MBFC URL"] ?? null,
    // MBFC returns no rating date, so "when was this rated" is unavailable.
    // Only the fetch time is knowable — don't pass it off as the rating date.
    rated_at: null,
    fetched_at: new Date().toISOString()
  };
}

export function normalise(provider, raw) {
  if (raw == null) return null;
  switch (provider) {
    case "allsides": return ALLSIDES_SCALE[norm(raw)] ?? null;
    case "mbfc":     return MBFC_SCALE[norm(raw)] ?? null;
    case "adfontes": return adFontesToScale(Number(raw));
    default:         return null;
  }
}

const LABELS = {
  "-3": "strongly left", "-2": "left", "-1": "leans left", "0": "centre",
  "1": "leans right", "2": "right", "3": "strongly right"
};
export const scaleLabel = n => (n == null ? "unplaced" : LABELS[String(n)]);

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * @param {string} outletId
 * @param {Array<{provider, raw, flags?, factual?, rated_at?}>} inputs
 * @param {string|null} rosterLean  the roster's hand-assigned lean, treated as
 *   ONE MORE OPINION and never as ground truth. Verified by hand that these
 *   disagree with raters: the roster calls Le Devoir "lean_left" while MBFC
 *   rates it "Least Biased". Surfacing that disagreement is the same feature as
 *   surfacing disagreement between two raters — silently trusting my own label
 *   would be the one unaudited bias in the system.
 * @returns {object} verdict with a `status` the UI switches on
 *
 * status is one of:
 *   agree          — providers within one step; show as a single line
 *   disagree       — two or more steps apart; show BOTH, flag the divergence
 *   single_source  — only one provider covers it; label as unconfirmed
 *   unplaced       — rated, but not on a left-right axis
 *   unrated        — nobody covers it; caller should use ownership fallback
 */
export const ROSTER_LEAN_SCALE = {
  "left": -2, "lean_left": -1, "centre": 0, "center": 0,
  "lean_right": 1, "right": 2,
  // Axes that are not left-right. The Taiwan card already makes this point:
  // MBFC rates Taipei Times "Left-Center", but the meaningful axis there is
  // proximity to Beijing vs Taipei. Keep these unplaced rather than coerced.
  "state": null, "varies": null, "pro_sovereignty": null
};

export function compareRatings(outletId, inputs = [], rosterLean = null) {
  const ratings = inputs.map(r => ({
    provider: r.provider,
    raw: r.raw,
    score: normalise(r.provider, r.raw),
    // Credibility tags ride alongside the bias rating, never inside it.
    flags: (r.flags ?? []).filter(f => MBFC_FLAGS.has(String(f).toLowerCase())),
    factual: r.factual ?? null,
    credibility: r.credibility ?? null,
    rated_at: r.rated_at ?? null,
    fetched_at: r.fetched_at ?? null
  }));

  const flags = [...new Set(ratings.flatMap(r => r.flags))];
  const rosterScore = rosterLean ? (ROSTER_LEAN_SCALE[rosterLean] ?? null) : null;
  const scored = ratings.filter(r => r.score !== null);

  const base = { outletId, ratings, flags, rosterLean };

  if (ratings.length === 0) {
    return { ...base, status: "unrated", rosterDisagrees: false, fallback: "ownership" };
  }
  if (scored.length === 0) {
    // Rated, but on no left-right axis — e.g. a source carrying only a
    // credibility tag. Still not a reason to hide it.
    return { ...base, status: "unplaced", rosterDisagrees: false, fallback: "ownership" };
  }
  if (scored.length === 1) {
    const only = scored[0];
    const disagrees = rosterScore !== null && Math.abs(only.score - rosterScore) >= 2;
    return {
      ...base,
      status: "single_source",
      consensus: only.score,
      rosterDisagrees: disagrees,
      rosterNote: disagrees
        ? `Roster labels this "${rosterLean}"; ${only.provider} rates it "${only.raw}".`
        : null,
      display: `${only.provider}: ${only.raw} (unconfirmed by a second rater)`
    };
  }

  const scores = scored.map(r => r.score);
  const spread = Math.max(...scores) - Math.min(...scores);

  // The roster's own label is checked against the raters, not exempt from them.
  const rosterDisagrees = rosterScore !== null &&
    scored.some(r => Math.abs(r.score - rosterScore) >= 2);

  return {
    outletId,
    status: spread <= 1 ? "agree" : "disagree",
    spread,
    ratings,
    flags,
    rosterLean,
    rosterDisagrees,
    rosterNote: rosterDisagrees
      ? `Roster labels this "${rosterLean}"; raters place it elsewhere. Shown as a third opinion, not corrected silently.`
      : null,
    // Midpoint is for sorting/grouping only. Never present it as "the" rating
    // when providers disagree — show both labels instead.
    consensus: spread <= 1
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : null,
    display: scored.map(r => `${r.provider}: ${r.raw}`).join("  ·  "),
    note: spread >= 2
      ? "Rating services disagree on this outlet. Both labels shown; neither is treated as settled."
      : null
  };
}

// ---------------------------------------------------------------------------
// Ownership fallback (Wikidata) — free, no key.
// For outlets neither rater covers, ownership and funding are more useful than
// a left-right label anyway. "Alibaba-owned" and "Qatari state-funded" did more
// work in the briefing cards than any bias score would have.
// ---------------------------------------------------------------------------

const WD_SEARCH = "https://www.wikidata.org/w/api.php";
const WD_SPARQL = "https://query.wikidata.org/sparql";

async function findQid(outletName, fetchImpl = fetch) {
  const url = `${WD_SEARCH}?action=wbsearchentities&format=json&language=en` +
              `&limit=1&origin=*&search=${encodeURIComponent(outletName)}`;
  const res = await fetchImpl(url, { headers: { "User-Agent": "Meridian/0.1" } });
  if (!res.ok) throw new Error(`Wikidata search failed: ${res.status}`);
  const data = await res.json();
  return data?.search?.[0]?.id ?? null;
}

/**
 * P127 = owned by, P749 = parent organization, P17 = country.
 * Deliberately does NOT try to classify "state media" from a class QID —
 * report the owner and let the roster's `funding` field carry that judgement,
 * rather than inferring a label from an unverified property.
 */
export async function fetchOwnership(outletName, fetchImpl = fetch) {
  const qid = await findQid(outletName, fetchImpl);
  if (!qid) return { outletName, qid: null, owners: [], parents: [], country: null };

  const query = `
    SELECT ?ownerLabel ?parentLabel ?countryLabel WHERE {
      OPTIONAL { wd:${qid} wdt:P127 ?owner. }
      OPTIONAL { wd:${qid} wdt:P749 ?parent. }
      OPTIONAL { wd:${qid} wdt:P17  ?country. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } LIMIT 20`;

  const res = await fetchImpl(`${WD_SPARQL}?format=json&query=${encodeURIComponent(query)}`, {
    headers: { "Accept": "application/sparql-results+json", "User-Agent": "Meridian/0.1" }
  });
  if (!res.ok) throw new Error(`Wikidata SPARQL failed: ${res.status}`);

  const rows = (await res.json())?.results?.bindings ?? [];
  const pick = k => [...new Set(rows.map(r => r[k]?.value).filter(Boolean))];

  return {
    outletName,
    qid,
    owners: pick("ownerLabel"),
    parents: pick("parentLabel"),
    country: pick("countryLabel")[0] ?? null,
    source: `https://www.wikidata.org/wiki/${qid}`
  };
}

// ---------------------------------------------------------------------------
// Cache. Ratings change on the order of months, so there is no reason to hit
// the providers per request — and the paid tiers are metered.
// ---------------------------------------------------------------------------

const DEFAULT_TTL_DAYS = 30;

export function makeCache(store = new Map(), ttlDays = DEFAULT_TTL_DAYS) {
  const ttl = ttlDays * 86_400_000;
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (Date.now() - hit.at > ttl) { store.delete(key); return null; }
      return hit.value;
    },
    set(key, value) {
      store.set(key, { value, at: Date.now() });
      return value;
    },
    async wrap(key, producer) {
      const hit = this.get(key);
      if (hit) return hit;
      return this.set(key, await producer());
    }
  };
}

// ---------------------------------------------------------------------------
// MBFC dataset index.
//
// The API has exactly ONE endpoint — GET /fetch-data — which returns EVERY
// rated source (9,000+) as a single array. There are no query parameters and
// no per-source lookup. So the access pattern is: fetch the whole dataset once,
// index it in memory, and resolve every outlet locally. Per-outlet API calls
// would be both impossible and pointless.
//
// Practical consequence: one request covers the entire roster. On the $10
// Researcher tier (100 requests/month) that is roughly 100 refreshes a month
// of capacity against a need of about one.
// ---------------------------------------------------------------------------

const MBFC_HOST = "media-bias-fact-check-ratings-api2.p.rapidapi.com";

/** Fetch the full dataset. One call. Cache the result to disk, not this process. */
export async function fetchMbfcDataset(apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(`https://${MBFC_HOST}/fetch-data`, {
    headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": MBFC_HOST }
  });
  if (!res.ok) throw new Error(`MBFC fetch-data failed: ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("MBFC fetch-data did not return an array");
  return rows;
}

/** Index the dataset by normalised domain and by Source ID#. */
export function buildMbfcIndex(rows) {
  const byDomain = new Map();
  const byId = new Map();
  for (const row of rows) {
    const parsed = parseMbfc(row);
    if (parsed.domain) byDomain.set(parsed.domain, parsed);
    if (parsed.mbfc_id != null) byId.set(parsed.mbfc_id, parsed);
  }
  return {
    byDomain, byId, size: rows.length,
    lookup(outlet) {
      if (outlet.mbfc_id != null && byId.has(outlet.mbfc_id)) return byId.get(outlet.mbfc_id);
      const d = normaliseDomain(outlet.domain ?? outlet.site ?? outlet.feed ?? "");
      return d ? byDomain.get(d) ?? null : null;
    }
  };
}

/**
 * ATTRIBUTION IS A LICENCE CONDITION, not a courtesy.
 *
 * MBFC's terms: "Users in the Researcher & Developer tiers must link to MBFC
 * when displaying source information." The $10 and $40 tiers both carry it;
 * only the $200 Business tier does not.
 *
 * Every rendered rating must carry this link. The payload's "MBFC URL" field is
 * the per-source link to use. Render this or do not render the rating.
 */
export function attributionFor(parsed) {
  return {
    text: "Rating: Media Bias/Fact Check",
    href: parsed?.reportUrl ?? "https://mediabiasfactcheck.com/",
    required: true
  };
}

/**
 * Top level: resolve an outlet's label for display.
 * `providers` maps provider id -> either a prebuilt index (MBFC) or an async
 * fetcher (a provider that does offer per-source lookup, e.g. AllSides).
 */
export async function resolveOutletLabel(outlet, providers = {}, cache = makeCache()) {
  return cache.wrap(`label:${outlet.id}`, async () => {
    const inputs = [];

    for (const [provider, source] of Object.entries(providers)) {
      try {
        // A dataset index resolves locally; a fetcher hits the network.
        const hit = typeof source?.lookup === "function"
          ? source.lookup(outlet)
          : await source(outlet);
        if (hit == null) continue;

        inputs.push(typeof hit === "object" && "raw" in hit
          ? { ...hit, provider }
          : { provider, raw: hit, fetched_at: new Date().toISOString() });
      } catch (err) {
        // A provider outage must never block the card. Record and continue.
        inputs.push({ provider, raw: null, error: String(err.message ?? err) });
      }
    }

    const verdict = compareRatings(outlet.id, inputs, outlet.lean ?? null);

    // Carry the attribution link for any MBFC rating that made it in.
    const mbfc = inputs.find(i => i.provider === "mbfc" && i.reportUrl);
    if (mbfc) verdict.attribution = attributionFor(mbfc);

    if (verdict.fallback === "ownership") {
      try {
        verdict.ownership = await fetchOwnership(outlet.name);
        verdict.display = verdict.ownership.owners.length
          ? `Ownership: ${verdict.ownership.owners.join(", ")}`
          : (outlet.funding ? `Funding: ${outlet.funding}` : "Unrated; ownership unknown");
      } catch {
        verdict.display = outlet.funding ? `Funding: ${outlet.funding}` : "Unrated";
      }
    }

    // Roster-declared funding always rides along — it is hand-verified and
    // often the most decision-relevant fact about a source.
    verdict.funding = outlet.funding ?? null;
    verdict.declared_lean = outlet.lean ?? null;
    return verdict;
  });
}
