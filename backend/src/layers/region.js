/**
 * What a story is ABOUT, geographically.
 *
 * This replaces a mistake. Region used to be derived from the nationality of
 * the outlets that covered a story, which meant the Globe and Mail reporting on
 * the US Federal Reserve was filed under Canada, and a story about India
 * covered by the BBC and Al Jazeera was filed under Europe and Global. Meridian
 * exists to brief one person on Canada, India, Europe and the world; that has
 * to mean subject matter, not who happened to publish.
 *
 * Method: a weighted gazetteer over the titles and retrieved extracts. No
 * model, no geocoding service — the same reason the rest of the pipeline uses
 * TF-IDF. It is inspectable, it runs offline, and when it is wrong you can see
 * exactly which term fooled it, because every assignment records its evidence.
 *
 * It will be wrong sometimes. `matched` exists so that is auditable rather than
 * mysterious.
 */

/** weight 3: naming this is close to decisive. */
const STRONG = {
  Canada: ["canada", "canadian government", "ottawa", "parliament hill", "bank of canada",
           "statistics canada", "carney", "poilievre", "csis", "rcmp", "quebec", "ontario",
           "alberta", "british columbia", "manitoba", "saskatchewan", "nova scotia"],
  India: ["india", "new delhi", "indian government", "modi", "lok sabha", "rajya sabha",
          "reserve bank of india", "bjp", "congress party", "gujarat", "maharashtra",
          "tamil nadu", "kerala", "uttar pradesh", "karnataka", "mumbai", "bengaluru",
          "kolkata", "chennai", "ahmedabad", "hyderabad"],
  Europe: ["european union", "european commission", "european parliament", "brussels",
           "von der leyen", "eurozone", "european central bank", "eur-lex", "schengen",
           "germany", "france", "italy", "spain", "poland", "netherlands", "sweden",
           "denmark", "finland", "norway", "ireland", "portugal", "greece", "austria",
           "belgium", "hungary", "czech", "slovakia", "romania", "bulgaria", "croatia",
           "kosovo", "serbia", "ukraine", "berlin", "paris", "madrid", "rome", "warsaw",
           "stockholm", "strasbourg", "the hague"],
};

/** weight 1: suggestive on its own, decisive in combination. */
const WEAK = {
  Canada: ["canadians", "toronto", "vancouver", "montreal", "calgary", "edmonton", "winnipeg",
           "brampton", "loonie", "provincial"],
  India: ["indians", "delhi", "pune", "jaipur", "lucknow", "rupee", "crore", "lakh", "adani", "ambani"],
  Europe: ["europe", "european", "eurostat", "brexit", "nato", "member state", "member states",
           "eurosceptic", "commissioner"],
};

const REGIONS = ["Canada", "India", "Europe"];
const THRESHOLD = 3;

function compile(map) {
  const out = {};
  for (const [region, terms] of Object.entries(map)) {
    out[region] = terms.map(term => ({
      term,
      re: new RegExp(`(?<![a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i"),
    }));
  }
  return out;
}

const STRONG_RE = compile(STRONG);
const WEAK_RE = compile(WEAK);

/**
 * The text a region decision may look at: headlines, feed excerpts, and the
 * short article extracts. Never the article body — it is not retained.
 */
export function textOf(cluster) {
  const parts = [];
  for (const item of cluster.items ?? []) {
    parts.push(item.title ?? "", item.excerpt ?? "");
  }
  for (const s of cluster.sources ?? []) {
    parts.push(s.t ?? "");
    for (const q of s.quotes ?? []) parts.push(q);
    for (const f of s.figures ?? []) parts.push(f.context ?? "");
  }
  return parts.join(" \n ");
}

/**
 * @returns {{ regions: string[], scores: object, matched: object }}
 *   regions: every region scoring at or above the threshold, else ["Global"]
 *   matched: the terms that produced each score — the audit trail
 */
export function regionsOf(cluster) {
  const text = textOf(cluster);
  const scores = {};
  const matched = {};

  for (const region of REGIONS) {
    let score = 0;
    const hits = [];
    for (const { term, re } of STRONG_RE[region]) {
      if (re.test(text)) { score += 3; hits.push(term); }
    }
    for (const { term, re } of WEAK_RE[region]) {
      if (re.test(text)) { score += 1; hits.push(term); }
    }
    // The publisher's own country is evidence, but weak — a Canadian paper
    // covering the Fed is not a Canada story.
    const countries = new Set((cluster.items ?? []).map(i => i.country).filter(Boolean));
    if ((region === "Canada" && countries.has("CA")) ||
        (region === "India" && countries.has("IN")) ||
        (region === "Europe" && ["EU", "DE", "FR", "UK"].some(c => countries.has(c)))) {
      score += 1;
      hits.push("(an outlet from the region covered it)");
    }
    scores[region] = score;
    if (hits.length) matched[region] = hits.slice(0, 8);
  }

  const regions = REGIONS.filter(r => scores[r] >= THRESHOLD);
  return {
    regions: regions.length ? [...regions, "Global"] : ["Global"],
    scores,
    matched,
  };
}

export const _internals = { STRONG, WEAK, THRESHOLD, REGIONS };
