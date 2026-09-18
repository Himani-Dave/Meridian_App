/**
 * Layer 3 (framing) — which side of the spectrum actually covered this story.
 *
 * The rules this implements, verbatim from CLAUDE.md:
 *
 *   4. Three views (left / centre / right), each tied to a named outlet. If a
 *      side was not found, render `not sourced`. Never synthesise a viewpoint
 *      nobody published, and never attribute a position to an outlet that did
 *      not take it.
 *   5. Where the left–right axis does not apply, say so on the card and name
 *      the real axis instead.
 *
 * So this module assigns outlets to sides and reports absence. It does not
 * write the view text. Nothing here may produce a sentence describing what an
 * outlet argued — that requires reading the outlet, which happens downstream
 * from retrieved text, never from a lean label.
 */

/** Roster lean -> spectrum side. Anything absent from this map is off-axis. */
const SIDE_OF_LEAN = {
  left: "left",
  lean_left: "left",
  centre: "centre",
  center: "centre",
  lean_right: "right",
  right: "right",
};

const SIDE_LABEL = {
  left: "Left / progressive",
  centre: "Centre",
  right: "Right / conservative",
};

/** Leans that are a position but not a left-right position. */
const OFF_AXIS_LEANS = new Set(["state", "varies", "pro_sovereignty"]);

export function sideOf(lean) {
  return SIDE_OF_LEAN[String(lean ?? "").toLowerCase()] ?? null;
}

/**
 * @param cluster  a cluster from clusterItems()
 * @returns {{ views, axis, offAxis }}
 *   views:  one entry per side, always all three, with outlets[] possibly empty
 *   axis:   { applies, reason } — when applies is false the card must name the
 *           real axis, and that naming is a human/composition decision
 *   offAxis: outlets that carry a position the left-right axis does not capture
 */
export function frameCluster(cluster) {
  const bySide = { left: [], centre: [], right: [] };
  const offAxis = [];

  cluster.items.forEach((item, index) => {
    const side = sideOf(item.lean);
    const entry = {
      outlet: item.outlet,
      outletId: item.outletId,
      lean: item.lean,
      country: item.country,
      evidenceIndex: index,
      headline: item.title,
      url: item.url,
    };
    if (side) bySide[side].push(entry);
    else offAxis.push({ ...entry, reason: OFF_AXIS_LEANS.has(item.lean) ? `lean "${item.lean}" is not a left-right position` : `unmapped lean "${item.lean}"` });
  });

  const onAxisSides = Object.entries(bySide).filter(([, list]) => list.length).map(([s]) => s);

  // The axis stops applying when almost nobody on it covered the story — a
  // Taiwan/PRC story carried by state and diaspora outlets is the usual case.
  const onAxisItems = onAxisSides.reduce((n, s) => n + bySide[s].length, 0);
  const applies = onAxisItems >= 2 && onAxisSides.length >= 2;

  const views = ["left", "centre", "right"].map(side => ({
    side,
    label: SIDE_LABEL[side],
    // Every outlet on this side that actually published, named. Empty means
    // exactly one thing: nobody on this side was found in this run.
    outlets: bySide[side],
    status: bySide[side].length ? "sourced" : "not sourced",
    // Written downstream from the retrieved text. Never from the lean label.
    text: null,
  }));

  return {
    views,
    axis: applies
      ? { applies: true, name: "left-right" }
      : {
          applies: false,
          name: null, // must be filled in by whoever can read the coverage
          reason: onAxisItems < 2
            ? `only ${onAxisItems} of ${cluster.items.length} items come from outlets placed on the left-right axis`
            : `coverage sits on one side only (${onAxisSides.join(", ")})`,
        },
    offAxis,
  };
}

export const _internals = { SIDE_OF_LEAN, OFF_AXIS_LEANS, SIDE_LABEL };
