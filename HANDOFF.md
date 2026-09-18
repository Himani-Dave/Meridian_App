# Handoff — what carries over and what doesn't

Written at the end of the Cowork session that built this. Claude Code starts with a fresh
context window and cannot read that conversation, so anything load-bearing had to become
a file. This note says what made it across and what didn't.

## Carried over

- **The rules** — `CLAUDE.md`, loaded into every session.
- **The source roster and access tiers** — `config/sources.json`, including the sources
  that were considered and *rejected*, with reasons (see the `rejected` block: NewsAPI was
  ruled out on a dev-only free tier and a $449/month commercial tier).
- **The full verification trail** — `app/meridian.html` is not just a UI. Its `STORIES`
  array holds all 8 cross-verified stories: per-fact source links, confirmation tiers,
  the `disputed` blocks recording where outlets conflicted or a fetch failed, and per-card
  notes on coverage skew. That array is the research record. Don't regenerate it casually.
- **The ratings design** — `src/ratings.js`, with rationale in comments.
- **Setup steps** — `SETUP.md`.

## Did NOT carry over

- **The conversation itself.** Reasoning not written into a file is gone.
- **Personal preferences from claude.ai memory.** Claude Code keeps its own separate
  per-project memory and does not read claude.ai memory. If you want a standing preference
  honoured here — e.g. direct, evidence-based assessments over agreeable ones, and
  ingredient-level analysis over marketing claims — write it into `~/.claude/CLAUDE.md`
  yourself. It won't arrive on its own.
- **Ability to publish the artifact.** Claude Code can edit `app/meridian.html`; it cannot
  push to the artifact URL. That step happens from a claude.ai / Cowork session.

## Known state, honestly

- Every `feed` URL in `config/sources.json` is a guess (`"verified": false`). Several will
  be dead. Validating them is task one.
- `src/ratings.js` is pure functions plus the Wikidata fallback. No provider fetchers are
  wired; `resolveOutletLabel` takes them by injection.
- No backend exists yet. The app's stories are hardcoded.
- No tests exist. The ratings comparison was verified by hand against five cases
  (agree / disagree / single_source / unplaced / unrated); those should become real tests.
- The Gaza card is knowingly unbalanced: an Israeli response to the specific UN allegations
  could not be retrieved (jpost.com redirect-looped). The card says so. Fixing that is a
  content task, not a bug.
- Ratings appearing in any prior test output were illustrative examples, not real AllSides
  or MBFC ratings. Nothing in this repo contains real rating data yet.
