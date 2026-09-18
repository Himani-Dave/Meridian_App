# Setup

Written after the architecture was settled against what the platform actually
permits. The constraints below were verified, not assumed — the reasons are in
`CLAUDE.md` under "Where network calls can and cannot run".

## The shape of it

```
GitHub Actions          open network. Validates feeds, ingests, reads articles,
(07:00 Toronto)         commits candidates.json + run-report.json

Cowork scheduled task   reads those over raw.githubusercontent.com, writes the
(08:00 Toronto)         cards, validates, republishes the artifact, notifies
```

Two machines, and neither of them is yours — nothing has to be awake at 07:00
except GitHub.

Why split it: a Cowork session's network reaches an allowlist that excludes news
domains, so retrieval can't happen there. It reaches GitHub and it can publish
artifacts, which Claude Code cannot. Each half runs where it is able to.

---

## 1. Put the repo on GitHub

Create a repository — private is fine — and get these files into it.

**If you have git:**

```bash
cd meridian
git init && git add -A
git commit -m "Meridian: front end, backend, workflows"
git branch -M main
git remote add origin https://github.com/<you>/meridian.git
git push -u origin main
```

**If you don't:** on the new repository page choose *uploading an existing
file*, then drag the whole unzipped folder in. Keep the folder structure —
`.github/workflows/` must land at the repository root or the workflows won't
register.

Then: **Settings → Actions → General → Workflow permissions → Read and write
permissions → Save.** Both workflows commit their results, and without this they
fail at the last step having done all the work.

## 2. Validate the feeds

**Actions → Validate feeds → Run workflow.**

Takes a few minutes. It fetches all 52 feeds, confirms each parses as RSS/Atom
and has items, probes fallback paths for the ones that fail, flips `verified` to
true only on a real successful fetch, and commits the updated roster.

Read the run summary. Expect several failures — every URL in the roster was a
conventional guess. The job fails deliberately if any lean bucket ends up with
zero working feeds, because a roster that quietly loses its right-leaning
outlets reintroduces the exact skew it exists to prevent.

`scripts/validate-feeds.ps1` does the same thing from PowerShell. It's a
fallback now, not the main path.

## 3. First ingestion

**Actions → Daily ingestion → Run workflow.** Manual runs skip the clock gate.

It writes `backend/data/candidates.json` and `backend/data/run-report.json` and
commits them. Check the run summary for candidate count, side coverage, and
retrieval failures.

The first run will need tuning. Look for clusters that merged two different
stories — over-merging is the dangerous direction, because it manufactures
corroboration nobody gave. Adjust `threshold` in `backend/src/layers/cluster.js`
(default 0.30; higher splits more).

## 4. The daily task

Once step 3 produces candidates worth reading, the 08:00 scheduled task gets
created from a Cowork session. It follows `backend/COMPOSE.md`.

---

## Keys

Copy `.env.example` to `.env` and fill in what you have. `.gitignore` already
covers `.env`.

Nothing in the pipeline needs a key today: RSS, GDELT, and the Federal Register
are all keyless. Keys matter when the remaining primary-document sources get
wired, and for the rating providers.

Never put a key in `app/meridian.html`. That file is published; anything in it
is readable by anyone who opens the page.

For Actions, keys go in **Settings → Secrets and variables → Actions**, not in
`.env` — `.env` is gitignored, so the runner never sees it.

## Ratings

`config/sources.json` documents MBFC's API: one endpoint, no search, returns
every rated source in a single response. `scripts/join-mbfc.js` matches it
against the roster — exact domain matches apply automatically, everything else
goes to `config/mbfc-review.md` for you to confirm, because a wrong domain match
silently mislabels an outlet's bias.

One provider is not the design. The app compares two rating services and surfaces
disagreement; AllSides is still contact-form-only. Until a second provider
exists, render the single MBFC rating with its required link and leave the
agreement UI out — a comparison widget with one input is worse than no widget.
