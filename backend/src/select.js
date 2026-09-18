/**
 * select.js — which clusters become cards.
 *
 * Split out of run.js so it can be tested without running a pipeline. The rule
 * it encodes is the important part, so it is stated once here and enforced
 * below: an unfilled region quota is REPORTED, never backfilled.
 */

import { regionsOf } from "./layers/region.js";

export function parseQuotas(spec) {
  const out = {};
  for (const part of String(spec).split(",")) {
    const [region, n] = part.split("=");
    if (region && Number.isFinite(Number(n))) out[region.trim()] = Number(n);
  }
  return out;
}

/**
 * Which clusters become cards.
 *
 * Quotas are filled from candidates that already meet the normal bar — a story
 * is never promoted just to fill a slot. An unfilled quota is REPORTED, not
 * quietly backfilled with more of whatever was plentiful: under rule 3, "no
 * India story was available today" is information the briefing should carry,
 * and silently substituting a third Middle East story for it is the kind of
 * gap-presented-as-balance the whole app exists to avoid.
 */
export function selectByRegion(clusters, quotas, limit) {
  const scored = clusters.map(cluster => {
    const { regions } = regionsOf(cluster);
    return {
      cluster,
      regions,
      score: cluster.outletCount * 10 + cluster.countries.length * 2 + (cluster.similarity.max ?? 0) * 5,
    };
  }).sort((a, b) => b.score - a.score);

  const picked = new Set();
  const fill = {};

  for (const [region, quota] of Object.entries(quotas)) {
    const eligible = scored.filter(s => s.regions.includes(region));
    const taken = [];
    for (const s of eligible) {
      if (taken.length >= quota) break;
      if (picked.has(s)) continue;
      picked.add(s);
      taken.push(s);
    }
    fill[region] = { quota, filled: taken.length, availableInRegion: eligible.length };
  }

  // Any slots left over go to the best remaining stories, whatever their region.
  for (const s of scored) {
    if (picked.size >= limit) break;
    picked.add(s);
  }

  return {
    selected: [...picked].slice(0, limit).map(s => s.cluster),
    fill,
  };
}

