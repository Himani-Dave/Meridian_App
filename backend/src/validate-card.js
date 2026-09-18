/**
 * validate-card.js — mechanical enforcement of the rules in CLAUDE.md.
 *
 * The composition step is a writing step, and writing steps drift. Rules that
 * exist only as prose in a spec get followed on a good day and quietly bent on
 * a slow one. Everything here is a rule that can be checked without judgement,
 * so it is checked without judgement, on every card, every run.
 *
 * What this CANNOT check is whether a sentence is true, whether a view fairly
 * represents what an outlet argued, or whether a `disputed` block describes a
 * real disagreement. Those need a reader. Passing validation means a card is
 * well-formed and internally consistent — not that it is accurate.
 *
 * Errors block publication. Warnings are for a human to look at.
 */

const SIDES = ["left", "centre", "right"];

export function validateCard(card, index = 0) {
  const problems = [];
  const at = path => `card[${index}].${path}`;
  const err = (code, message, path) => problems.push({ level: "error", code, message, path: at(path) });
  const warn = (code, message, path) => problems.push({ level: "warn", code, message, path: at(path) });

  // --- sources: everything else indexes into these ------------------------
  const sources = Array.isArray(card.sources) ? card.sources : [];
  if (!sources.length) err("no-sources", "A card with no sources cannot be published.", "sources");

  const urls = new Set();
  sources.forEach((s, i) => {
    if (!s?.n) err("source-unnamed", "Every source needs the outlet name.", `sources[${i}].n`);
    if (!s?.t) err("source-untitled", "Every source needs the headline that was actually retrieved.", `sources[${i}].t`);
    if (!/^https?:\/\//i.test(s?.u ?? "")) err("source-url", "Every source needs an http(s) url.", `sources[${i}].u`);
    if (s?.u) {
      if (urls.has(s.u)) warn("source-duplicate", `Duplicate source url: ${s.u}`, `sources[${i}].u`);
      urls.add(s.u);
    }
    // Rule 11: an MBFC rating ships with its MBFC link or it does not ship.
    const provider = s?.labelSource?.provider;
    if (provider === "mbfc" && !s?.labelSource?.url) {
      err("mbfc-unlinked", "An MBFC rating must link to MBFC (licence condition). Render the link or drop the rating.", `sources[${i}].labelSource.url`);
    }
    if (s?.b && !provider) {
      warn("label-unattributed", `Bias label "${s.b}" has no labelSource — a label must say who assigned it and when.`, `sources[${i}].labelSource`);
    }
  });

  const validIndex = i => Number.isInteger(i) && i >= 0 && i < sources.length;
  const outletOf = i => sources[i]?.n;

  // --- prose that must exist ----------------------------------------------
  for (const field of ["headline", "context", "coverage"]) {
    if (!String(card[field] ?? "").trim()) err("prose-missing", `\`${field}\` is required and must be written from the retrieved text.`, field);
  }
  if (!Array.isArray(card.regions) || !card.regions.length) err("no-regions", "A card needs at least one region.", "regions");

  // --- facts ---------------------------------------------------------------
  const facts = Array.isArray(card.facts) ? card.facts : [];
  if (!facts.length) err("no-facts", "A card with no facts is not a card.", "facts");

  facts.forEach((f, i) => {
    if (!String(f?.t ?? "").trim()) err("fact-empty", "Fact text is empty.", `facts[${i}].t`);

    const cites = Array.isArray(f?.s) ? f.s : [];
    if (!cites.length) {
      err("fact-uncited", "Every fact must cite at least one source index.", `facts[${i}].s`);
    }
    for (const c of cites) {
      if (!validIndex(c)) err("fact-bad-index", `Source index ${c} does not exist (${sources.length} sources).`, `facts[${i}].s`);
    }

    const distinctOutlets = new Set(cites.filter(validIndex).map(outletOf));

    switch (f?.tier) {
      case "multi":
        // Rule 1: 2+ INDEPENDENT outlets. Two articles from one outlet is one outlet.
        if (distinctOutlets.size < 2) {
          err("tier-multi-unsupported",
            `Tier "multi" claims independent corroboration but cites ${distinctOutlets.size} distinct outlet(s): ${[...distinctOutlets].join(", ") || "none"}.`,
            `facts[${i}].tier`);
        }
        break;
      case "primary":
        if (!cites.filter(validIndex).some(c => sources[c]?.kind === "primary")) {
          err("tier-primary-unsupported",
            'Tier "primary" requires a cited source marked kind:"primary".',
            `facts[${i}].tier`);
        }
        break;
      case "single":
        // Legal, but it must be visibly labelled. The app renders the tier, so
        // the only check here is that it is honestly single.
        if (distinctOutlets.size > 1) {
          warn("tier-single-understated", "Labelled single but cites more than one outlet — should this be `multi`?", `facts[${i}].tier`);
        }
        break;
      default:
        err("tier-missing", 'Every fact needs tier: "primary" | "multi" | "single".', `facts[${i}].tier`);
    }
  });

  // --- views (rules 4 and 5) ----------------------------------------------
  const views = Array.isArray(card.views) ? card.views : [];
  const seenSides = new Set();

  for (const side of SIDES) {
    if (!views.some(v => v?.side === side)) {
      err("view-missing", `No entry for the ${side} side. Absence must be rendered as "not sourced", not omitted.`, "views");
    }
  }

  views.forEach((v, i) => {
    if (!SIDES.includes(v?.side)) {
      err("view-side", `Unknown side "${v?.side}".`, `views[${i}].side`);
      return;
    }
    if (seenSides.has(v.side)) err("view-duplicate", `Two entries for the ${v.side} side.`, `views[${i}].side`);
    seenSides.add(v.side);

    const notSourced = v.status === "not sourced" || (!v.outlet && !String(v.text ?? "").trim());

    if (notSourced) {
      if (String(v.text ?? "").trim()) {
        err("view-synthesised",
          "A side marked `not sourced` carries view text. Never synthesise a viewpoint nobody published.",
          `views[${i}].text`);
      }
      return;
    }

    if (!String(v.text ?? "").trim()) err("view-empty", "A sourced view needs text written from what that outlet published.", `views[${i}].text`);
    if (!String(v.outlet ?? "").trim()) err("view-unattributed", "A sourced view must name the outlet.", `views[${i}].outlet`);

    const cites = Array.isArray(v.s) ? v.s : [];
    if (!cites.length) {
      err("view-uncited", "A sourced view must cite the source indices it was read from.", `views[${i}].s`);
    }
    for (const c of cites) {
      if (!validIndex(c)) err("view-bad-index", `Source index ${c} does not exist.`, `views[${i}].s`);
    }

    // Rule 4: never attribute a position to an outlet that did not take it.
    // The named outlet must appear among the sources this view cites.
    const citedOutlets = cites.filter(validIndex).map(outletOf).filter(Boolean);
    const named = String(v.outlet ?? "");
    const namedIsCited = citedOutlets.some(o => named.toLowerCase().includes(String(o).toLowerCase()));
    if (citedOutlets.length && !namedIsCited) {
      err("view-outlet-mismatch",
        `View names "${named}" but cites ${citedOutlets.join(", ")}. A view may only be attributed to an outlet it was read from.`,
        `views[${i}].outlet`);
    }
  });

  // --- rule 5: the axis ----------------------------------------------------
  if (card.axis && card.axis.applies === false) {
    if (!String(card.axis.name ?? "").trim()) {
      err("axis-unnamed",
        "The left-right axis is marked inapplicable, so the card must name the axis that does apply.",
        "axis.name");
    }
  }

  // --- rule 3: admitted gaps ----------------------------------------------
  if (card.gaps !== undefined) {
    if (!Array.isArray(card.gaps)) err("gaps-shape", "`gaps` must be an array of strings.", "gaps");
    else card.gaps.forEach((g, i) => {
      if (!String(g ?? "").trim()) err("gap-empty", "Empty gap entry.", `gaps[${i}]`);
    });
  }

  // --- disputed (rule 2) ---------------------------------------------------
  if (card.disputed !== undefined && card.disputed !== null) {
    if (!Array.isArray(card.disputed)) err("disputed-shape", "`disputed` must be an array.", "disputed");
    else card.disputed.forEach((d, i) => {
      if (!String(d?.t ?? "").trim()) err("disputed-empty", "Empty disputed entry.", `disputed[${i}].t`);
    });
  }

  // --- leftovers from the candidate ---------------------------------------
  if (card._prose) warn("candidate-leftover", "`_prose` marker is still present — this looks like an unfinished candidate.", "_prose");
  for (const field of ["headline", "context", "coverage"]) {
    if (card[field] === null) err("prose-null", `\`${field}\` is still null from the candidate stage.`, field);
  }

  return problems;
}

export function validatePayload(cards) {
  const all = [];
  if (!Array.isArray(cards)) {
    return [{ level: "error", code: "payload-shape", message: "Payload must be an array of cards.", path: "payload" }];
  }
  cards.forEach((c, i) => all.push(...validateCard(c, i)));

  // Balance is a property of the run, not of one card.
  const covered = { left: 0, centre: 0, right: 0 };
  for (const card of cards) {
    for (const v of card.views ?? []) {
      if (SIDES.includes(v?.side) && v.status !== "not sourced" && String(v.text ?? "").trim()) covered[v.side]++;
    }
  }
  for (const side of SIDES) {
    if (cards.length && covered[side] === 0) {
      all.push({
        level: "error",
        code: "balance-starved",
        message: `No card in this payload has a sourced ${side} view. A missing side is a silent bias, not a missing feature.`,
        path: "payload",
      });
    }
  }
  return all;
}

export function summarise(problems) {
  const errors = problems.filter(p => p.level === "error");
  const warnings = problems.filter(p => p.level === "warn");
  return { ok: errors.length === 0, errors, warnings };
}
