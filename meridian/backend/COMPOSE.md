# The composition step

What the 08:00 session does, every day. This file is the contract — the
scheduled task's prompt points here rather than repeating it, so changing the
behaviour means editing this file, not hunting down a prompt.

Composition is the step that turns **candidates** (evidence, every prose field
null) into **cards** (what the app renders). It is a writing step performed by
Claude, and it is the step where this project's rules are easiest to break, so
the constraints below are not style guidance. They are the product.

## Inputs

Fetched from the repo over `raw.githubusercontent.com` (reachable from a Cowork
session; news domains are not):

- `backend/data/candidates.json` — the evidence
- `backend/data/run-report.json` — what failed to load

**Check freshness first.** `run-report.json` carries `finishedAt`. If it is more
than 6 hours old, the ingestion did not run. Do not republish yesterday's
candidates as today's briefing — say the pipeline did not run and stop.

## The one rule everything else follows from

**Write only what the retrieved text supports.**

Each candidate carries, per source: the headline, a feed excerpt of at most 400
characters, the URL, and timestamps. That is all that was read. It is thin
material, and cards written from it will be thinner than the eight hand-built
ones in the app today, which came from reading whole articles. That is the
honest trade for running daily — do not close the gap by filling it in from
general knowledge.

Concretely:

- A fact that rests on a headline alone gets `tier: "single"` unless another
  outlet's headline says the same thing, and the source's `read` field already
  records `headline only`. Do not restate a headline as though it were reported
  detail.
- Do not add figures, dates, names, or causes that appear in no excerpt.
- Do not resolve a disagreement. `disputedCandidates` in the candidate is an
  automated numeric check; confirm each one against the two excerpts and either
  promote it to `disputed` or drop it. Never average two numbers, never pick the
  more plausible one, never quietly drop the outlier.
- `context` may carry standing background a reader needs (what the body is, what
  the dispute has been about) — but it is the one place for it, it must be
  general and uncontroversial, and it never becomes a `fact` entry.

## Views (rules 4 and 5)

The candidate's `views` array already says which outlets, if any, covered the
story from each side, and cites them by source index.

- Write a view's `text` only from the excerpts of the outlets it cites.
- A side with no outlets stays `status: "not sourced"` with **no text**. Not a
  hedge, not "conservative outlets would likely argue" — nothing. The validator
  rejects a card that does this.
- `outlet` must name an outlet the view actually cites.
- If `axis.applies` is false, name the real axis in `axis.name` — proximity to
  Beijing/Taipei/Washington, government versus diaspora, whatever the coverage
  actually splits on. Do not force it back onto left/right.

## Gaps (rule 3)

Read `run-report.json`. If outlets that would normally cover this story failed
to load, put that in the card's `gaps` array in plain words: "The Hindu and
Indian Express feeds did not load this morning, so Indian coverage of this story
is missing." A gap presented as balance is worse than an admitted gap.

## Selection

Take the strongest candidates, not all of them. Prefer, in order: primary
document found; more independent outlets; coverage spanning more than one
country; a real disagreement between sources. Six to ten cards is a briefing;
thirty is a feed. Leave `outletCount: 1` candidates out unless the story matters
and the card says `1 source` on its face.

## Output and gates

1. Write cards to `cards.json` in the app's shape (see any story in
   `app/meridian.html` for the exact fields).
2. `node scripts/build-payload.js cards.json --check` — fix every error. The
   validator enforces: facts cite real sources; `multi` means two *distinct*
   outlets; no view text on an unsourced side; no view attributed to an outlet
   it does not cite; an inapplicable axis is named; MBFC labels carry MBFC
   links; no side starved across the whole payload.
3. `node scripts/build-payload.js cards.json` to splice the payload in.
4. Publish to the **existing** artifact URL, passing it explicitly:
   `https://claude.ai/artifact/S4nCxu1mrWTLUr2CzrvjPz`. Read it first, then
   publish with that url — a publish without it creates a second artifact and
   the link on Himani's phone stops updating.
5. Notify with what actually happened: story count, and any failure or gap worth
   knowing before opening it. "Briefing updated" alone hides a degraded run.

## When it goes wrong

Say so and publish nothing. A stale briefing that still says today's date is the
worst outcome available — worse than no briefing, because it is not visibly
broken. Specifically, do not publish if: the run report is stale, validation
fails, the balance check is starved, or fewer than three candidates survived
selection.
