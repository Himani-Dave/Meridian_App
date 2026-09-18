/**
 * Clustering — group articles from different outlets into one story.
 *
 * This is the step that decides what "reported independently by 2+ outlets"
 * means in practice (CLAUDE.md rule 1), so its failure modes matter:
 *
 *   - Over-merging is the dangerous one. Two different stories fused into one
 *     cluster produce a "confirmed by 2 outlets" fact that no two outlets
 *     actually reported. The threshold is deliberately conservative.
 *   - Under-merging is merely lossy: a story ships labelled `1 source`, which
 *     is honest, or does not ship at all.
 *
 * So when in doubt this splits rather than joins, and every cluster records
 * the similarity that produced it so a human can audit the borderline ones.
 *
 * Method: TF-IDF over title + excerpt, cosine similarity, single-link
 * agglomeration within a time window. No model, no embedding service — the
 * pipeline stays inspectable and runs offline.
 */

const STOPWORDS = new Set(`
a an and are as at be been but by for from has have he her his how i in is it its
of on or our over said say says she that the their them they this to was were what
when where which who will with would you your not no new after before more most
says up down out about against during under while than then there here been being
us u.s its it's amid ahead top live update updates video watch photos opinion
`.trim().split(/\s+/));

/** Outlet suffixes that arrive glued to headlines: "Story - BBC News". */
const TITLE_TAIL = /\s+[-–—|·]\s+[^-–—|·]{2,40}$/;

export function normaliseTitle(title) {
  return String(title ?? "").replace(TITLE_TAIL, "").trim();
}

export function tokenise(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9$%.' -]/g, " ")
    .split(/[\s'-]+/)
    .map(t => t.replace(/^[.$%]+|[.$%]+$/g, ""))
    .filter(t => t.length >= 3 || /^\d+$/.test(t))
    .filter(t => !STOPWORDS.has(t));
}

/**
 * Title carries more signal than the excerpt (an excerpt is often boilerplate),
 * so title tokens are weighted up rather than concatenated flat.
 */
function termFrequencies(item, titleWeight = 3) {
  const tf = new Map();
  for (const t of tokenise(normaliseTitle(item.title))) tf.set(t, (tf.get(t) ?? 0) + titleWeight);
  for (const t of tokenise(item.excerpt)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function buildVectors(items) {
  const tfs = items.map(i => termFrequencies(i));
  const df = new Map();
  for (const tf of tfs) for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);

  const n = items.length || 1;
  return tfs.map(tf => {
    const vec = new Map();
    let norm = 0;
    for (const [term, count] of tf) {
      const idf = Math.log((n + 1) / ((df.get(term) ?? 0) + 1)) + 1;
      const w = (1 + Math.log(count)) * idf;
      vec.set(term, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, w] of vec) vec.set(term, w / norm);
    return vec;
  });
}

export function cosine(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, w] of small) {
    const other = large.get(term);
    if (other) sum += w * other;
  }
  return sum;
}

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[rb] = ra; }
}

/**
 * @param items  normalised discovery items
 * @param opts.threshold      cosine above which two items are the same story
 * @param opts.windowHours    max publication gap for two items to be compared
 * @param opts.maxBlockSize   ignore terms appearing in more than this many items
 *                            when building candidate pairs (they carry no signal
 *                            and blow up the pair count)
 */
export function clusterItems(items, opts = {}) {
  const { threshold = 0.30, windowHours = 72, maxBlockSize = 120 } = opts;
  if (!items.length) return [];

  const vectors = buildVectors(items);
  const times = items.map(i => (i.publishedAt ? new Date(i.publishedAt).getTime() : NaN));
  const windowMs = windowHours * 3600_000;

  // Inverted index over terms -> candidate pairs only. Avoids comparing every
  // article against every other one while still catching any real overlap.
  const index = new Map();
  vectors.forEach((vec, i) => {
    for (const term of vec.keys()) {
      if (!index.has(term)) index.set(term, []);
      index.get(term).push(i);
    }
  });

  const uf = new UnionFind(items.length);
  const edges = [];
  const seen = new Set();

  for (const [, bucket] of index) {
    if (bucket.length < 2 || bucket.length > maxBlockSize) continue;
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const i = bucket[a], j = bucket[b];
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (items[i].outletId === items[j].outletId) continue; // same outlet re-running itself is not corroboration
        if (Number.isFinite(times[i]) && Number.isFinite(times[j]) && Math.abs(times[i] - times[j]) > windowMs) continue;

        const sim = cosine(vectors[i], vectors[j]);
        if (sim >= threshold) {
          uf.union(i, j);
          edges.push({ i, j, sim });
        }
      }
    }
  }

  const groups = new Map();
  items.forEach((_, i) => {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });

  return [...groups.values()].map(idxs => {
    const members = idxs.map(i => items[i]);
    const outletIds = new Set(members.map(m => m.outletId));
    const inner = edges.filter(e => idxs.includes(e.i) && idxs.includes(e.j));
    const sims = inner.map(e => e.sim);
    const stamps = members.map(m => m.publishedAt).filter(Boolean).sort();
    return {
      items: members,
      outletCount: outletIds.size,
      countries: [...new Set(members.map(m => m.country).filter(Boolean))],
      leans: [...new Set(members.map(m => m.lean).filter(Boolean))],
      firstSeen: stamps[0] ?? null,
      lastSeen: stamps[stamps.length - 1] ?? null,
      similarity: {
        min: sims.length ? Math.min(...sims) : null,
        max: sims.length ? Math.max(...sims) : null,
        pairs: sims.length,
      },
    };
  }).sort((a, b) => b.outletCount - a.outletCount || b.items.length - a.items.length);
}

export const _internals = { STOPWORDS, buildVectors, termFrequencies };
