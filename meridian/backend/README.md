# Meridian backend

Retrieval and evidence assembly. It produces **story candidates**, not cards.

```
discovery (RSS + GDELT) -> clustering -> framing -> verification -> candidates
```

```bash
cd backend
npm install
npm test                 # 17 tests, no network
node run.js --dry-run    # needs open outbound network; see "Where this runs"
```

## The one design decision to understand

The app's story shape has two kinds of field.

**Retrieved** — headlines, URLs, timestamps, short excerpts, which outlets
covered it, where their numbers disagree. The pipeline produces these.

**Written** — `context`, `facts`, `disputed`, `coverage`, `watch`, and each
view's `text`. These are analyst prose. They cannot be derived from an RSS feed,
and generating them from a lean label is exactly what rules 4, 9 and 10 forbid:
it would attribute a position to an outlet on the basis of its bias rating
rather than on what it published.

So every candidate comes out with those fields **null**, and a `_prose` field
saying so. Filling them is a separate step that reads the retrieved text — in
Claude Code, against `CLAUDE.md`, with the sources in front of it. The pipeline
hands over evidence; the composition step writes, and only from that evidence.

If you ever find a template in `src/` that emits a sentence asserting something
about the world, that is the bug.

## What each layer does

| File | Layer | Notes |
|---|---|---|
| `src/http.js` | — | The only file that touches the network. Per-host serialisation, 1.2s minimum gap, robots.txt, 20s timeout, one retry on 429/5xx. Failures are returned as values, never thrown away. |
| `src/layers/discover-rss.js` | 1 | Roster feeds. Stores headline, URL, timestamp and a ≤400-char excerpt. **Skips unverified feeds by default** — ingesting from a guessed URL is how a wrong outlet gets attributed. |
| `src/layers/discover-gdelt.js` | 1 | GDELT DOC 2.0, no key. Discovery only: it returns titles, not text, so its hits are `headline only` until a roster outlet is read. Unmatched domains never receive a lean. |
| `src/layers/cluster.js` | — | TF-IDF + cosine, single-link, 72h window. Tuned to **split rather than join**: over-merging manufactures corroboration that no two outlets gave. Same-outlet pairs are excluded, so `outletCount` counts outlets, not articles. |
| `src/layers/verify.js` | 2 | Primary documents. One source wired (US Federal Register, no key); the rest declared `planned` so the gap is countable. Returns *looked and found nothing* and *never looked* as different results. |
| `src/layers/frame.js` | 3 | Assigns outlets to left/centre/right and reports absence as `not sourced`. Marks the axis inapplicable when fewer than two on-axis outlets covered the story — and refuses to name the real axis itself. |
| `src/bundle.js` | 4 | Assembles the candidate. Also runs an automated numeric-disagreement check, whose output is `disputedCandidates` — a queue for a human, not a finding. |

## Output

`data/candidates.json` — the candidates.

`data/run-report.json` — **not a log.** Rule 3 makes retrieval failure part of
the product: every feed that failed, every source skipped as unverified, every
document source not wired. If a run loses a whole side of the spectrum, `run.js`
exits non-zero and says not to publish it.

## Where this runs

Not in a Cowork cloud session. That session's network reaches an allowlist and
news domains are not on it (`403 Host not in allowlist`), which is why the test
suite is fixture-based and runs anywhere. Run the ingestion on a machine with
open outbound network.

Keys live in `../.env`, read server-side only. Nothing in this directory writes
a key into `app/meridian.html` — that file is published and public.

## Not done yet

- Clustering thresholds are untuned against real feeds. Expect to adjust
  `threshold` (0.30) after the first live run and to look hard at anything that
  merged.
- Verification is one wired source out of eleven.
- No persistence between runs, so the same story reappears as a new candidate
  each day. A seen-URL store is the next obvious addition.
- Ratings are not joined here; `sources[].b` falls back to the roster's
  hand-assigned lean and says so in `labelSource`.
