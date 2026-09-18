# Meridian — verified world briefing

A personal news briefing app. One story per screen. Every fact traces to a source,
cross-verified across outlets of differing ideology, with primary/official documents
treated as the highest tier of evidence.

Owner: Himani (Brampton, ON). Regions of interest: Canada, India, Europe, Global.

## The non-negotiable rules

These are the product. Do not relax them for convenience or velocity.

1. **A fact is not publishable until it is either (a) confirmed by a primary/official
   document, or (b) reported independently by 2+ outlets.** Single-sourced claims ship
   labelled `1 source`, never unlabelled.
2. **When sources conflict, show the conflict.** Never average, never pick the more
   plausible number, never silently drop the outlier. The `disputed` block is a
   first-class feature, not an error state.
3. **When a retrieval fails, say so in the output.** "I could not load X" belongs in the
   card. A gap presented as balance is worse than an admitted gap.
4. **Three views (left / centre / right), each tied to a named outlet.** If a side was
   not found, render `not sourced`. Never synthesise a viewpoint nobody published, and
   never attribute a position to an outlet that did not take it.
5. **Where the left–right axis does not apply, say so on the card** and name the real
   axis instead (e.g. proximity to Beijing/Taipei/Washington; government vs diaspora).
6. **Bias labels describe an outlet, never a claim.** A lean is not evidence a fact is
   false. Ratings label; they never filter, reorder, or weight credibility.
7. **The only removal criterion is a tracked record of failed primary-document
   verification**, logged per source, visible in the app, applied identically across the
   spectrum. Never drop a source for its ideology.
8. **State and party-aligned outlets belong in the roster, labelled.** When a government
   asserts something, its own outlet is primary evidence of the assertion.
9. **No invented data, ever.** An earlier version of this app shipped fabricated
   "public sentiment" readings. They were removed. If data isn't wired, the feature
   doesn't render.
10. **Attribute only what was actually read.** If only a headline was retrieved, the card
    says "headline only".
11. **Every displayed MBFC rating must link to MBFC.** This is a licence condition of the
    Researcher ($10) and Developer ($40) tiers, not a courtesy — only the $200 Business
    tier is exempt. Use the per-source `MBFC URL` field from the payload. Render the link
    or do not render the rating. `attributionFor()` in `src/ratings.js` supplies it.

## Architecture

Four layers. Keep them separate in code — conflating them is how bias leaks back in.

| Layer | Job | Sources |
|---|---|---|
| 1. Discovery | what happened at all | GDELT DOC 2.0 (no key), RSS |
| 2. Verification | the official document proving it | government/institutional APIs + scrapers |
| 3. Framing | the three views | balanced outlet RSS roster |
| 4. Metadata | bias labels, fact-checks | 2 rating providers + Wikidata ownership |

Layer 2 is the differentiator. It caught the real find so far: Indian outlets reported
Canada's CSIS 2025 report as naming Khalistani extremists a security threat (true) while
omitting that the *same report* names India a foreign-interference actor conducting
transnational repression. Neither country's press covered both halves. Reading the
primary document was the only way to see it.

## Repo layout

```
app/meridian.html               the front end (published artifact; self-contained, no build step)
config/sources.json             source roster: tiers, access method, lean, funding, rating ids
src/ratings.js                  dual-provider bias rating comparison + Wikidata ownership fallback

backend/run.js                  one ingestion run
backend/COMPOSE.md              the contract the 08:00 composition session follows
backend/src/http.js             the only module that touches the network
backend/src/layers/             discover-rss, discover-gdelt, fetch-article, cluster, frame, verify
backend/src/bundle.js           cluster -> story candidate (evidence; prose fields null)
backend/src/validate-card.js    the rules as code; blocks publication on violation
backend/test/                   37 offline tests, no network

scripts/build-payload.js        validates cards and splices them into app/meridian.html
scripts/join-mbfc.js            attaches MBFC ratings + builds a review queue
scripts/validate-feeds.js       feed checker (runs on the Actions runner)
scripts/validate-feeds.ps1      PowerShell fallback; feed list baked in
scripts/apply-feed-results.js   applies the PowerShell output to config/sources.json
scripts/filter-mbfc.ps1         PowerShell fallback; trims the MBFC dump to the roster

.github/workflows/validate-feeds.yml   manual + weekly feed verification
.github/workflows/ingest.yml           07:00 Toronto daily ingestion
```

## Storing vs reading (the extract rule)

The pipeline reads whole articles and keeps almost none of them. `fetch-article.js`
pulls the page, extracts a few short quotes and the figures, and discards the
body — it never returns article text to its caller, so nothing long can reach
`candidates.json` or the repo.

Three caps, whichever binds first: at most 3 quotes, at most 30 words each, and
at most **10% of the article's word count**. The proportional cap is the one that
matters — three 30-word quotes is a fair extract from a 2,000-word investigation
and a quarter of a 400-word wire story. Tests enforce all three. Raising them
turns extracting into republishing.

## Where network calls can and cannot run

The Cowork cloud session reaches only an allowlisted set of hosts. News domains are
not on it — `fetch("https://feeds.bbci.co.uk/...")` returns `403 Host not in allowlist`.
So `scripts/validate-feeds.js` cannot run from a cloud session, and neither can any
ingestion code. That is an egress limit, not a content restriction.

Verified, not assumed (2026-09-18): news domains, GDELT and government APIs all
answer `403 Host not in allowlist` from a Cowork session. `raw.githubusercontent.com`
and `api.github.com` work. Changing the cloud environment's **Network access**
setting at claude.ai/code did not lift this for Cowork sessions — that setting
governs Claude Code cloud sessions.

So all retrieval runs on a GitHub Actions runner, which has open network, and the
Cowork side does only what it alone can do: read the committed results over
`raw.githubusercontent.com`, compose, and publish the artifact.

`scripts/validate-feeds.ps1` and `scripts/filter-mbfc.ps1` still work and are kept
as fallbacks for when Actions is unavailable. Regenerate the `.ps1` if the roster
changes — its feed list is baked in.

## Front-end constraints

`app/meridian.html` is published as a Claude artifact at:

    https://claude.ai/artifact/S4nCxu1mrWTLUr2CzrvjPz

Keep that URL. Republishing must target it explicitly, or a second, separate artifact is
created instead of a new version. **Claude Code cannot publish to it** — publishing happens
from a claude.ai / Cowork session. Claude Code edits the file; someone then republishes.

Artifact publishing imposes real limits on this file:

- Single file. Inline all CSS/JS. Images as data URIs.
- **No external fetches at runtime** except Google Fonts. The page cannot call the news
  APIs directly — that is why a backend exists. The page consumes a prebuilt JSON payload.
- No `<html>`/`<head>`/`<body>` tags — the platform wraps the content.
- Light and dark themes both required, defined as `:root` tokens.
- Must work at 390px wide with no horizontal scroll.
- Navigation is native CSS scroll-snap on a horizontal track. Do not replace this with a
  JS carousel; the snap behaviour is why swiping feels right.

## Status

Done: front end (8 cross-verified stories hardcoded), region filter, verification tiers,
disputed blocks, three-view rendering, per-card source lists with bias labels.

In progress: the daily loop.

```
07:00 Toronto  GitHub Actions   backend/run.js -> commits candidates.json + run-report.json
08:00 Toronto  Cowork task      reads them over raw.githubusercontent.com, writes the cards
                                (backend/COMPOSE.md), validates, splices, republishes, notifies
```

Retrieval cannot run in a Cowork session: that network reaches an allowlist and
news domains are not on it. GitHub raw is reachable, which is what makes the
split work — and means no laptop has to be awake.

Built and tested (29 offline tests): discovery, clustering, framing, verification
layer with one wired source, candidate assembly, card validation, payload splice,
the Actions workflow.

Next, in order:
1. Verify every RSS feed URL in `config/sources.json` (all `"verified": false`).
   The backend skips unverified feeds, so this gates the first real run.
2. Push to GitHub, enable Actions, run the workflow manually once.
3. Tune the clustering threshold against what actually comes back.
4. First composition pass by hand, then schedule it.
5. Wire `src/ratings.js` to live MBFC + AllSides data; currently pure functions with no fetch.

## Conventions

- Store headlines, URLs, timestamps and short excerpts from RSS. **Not full article text** —
  syndication covers linking and extracts, not republication.
- Record the rating provider *and date* with every bias label; these get revised.
- Respect published rate limits: api.data.gov 1,000/hr; StatCan 25 req/sec per IP;
  poll StatCan once daily (it updates 08:30 ET on business days).
- One request per scraped source per run. Honour robots.txt. Real User-Agent.
