/**
 * Every test here is a rule from CLAUDE.md expressed as a card that must be
 * rejected. If one of these starts passing, a rule has stopped being enforced.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { validateCard, validatePayload, summarise } from "../src/validate-card.js";

const SOURCES = [
  { n: "Northwind Wire", t: "Dock fees rise 12%", u: "https://northwind.example/a", b: "lean_left", labelSource: { provider: "roster" } },
  { n: "Southport Register", t: "Dock fee rise confirmed", u: "https://southport.example/b", b: "right", labelSource: { provider: "roster" } },
  { n: "The Meridianer", t: "Council splits on dock fees", u: "https://meridianer.example/c", b: "centre", labelSource: { provider: "roster" } },
];

function goodCard(overrides = {}) {
  return {
    cat: "policy",
    sub: "Municipal · Harbour",
    regions: ["Canada"],
    dateline: "Northport · Sept 16, 2026",
    headline: "Harbour authority raised dock fees 12% after a split budget vote",
    context: "The harbour authority sets fees annually; this year's vote divided the council.",
    facts: [
      { t: "Dock fees rise 12% from October.", s: [0, 1], tier: "multi" },
      { t: "The council vote was split.", s: [2], tier: "single" },
    ],
    disputed: [{ t: "Operators' cost estimates differ: $20m (Northwind) vs $28m (Meridianer)." }],
    views: [
      { side: "left", label: "Left", outlet: "Northwind Wire", s: [0], text: "Foregrounds the effect on small operators." },
      { side: "centre", label: "Centre", outlet: "The Meridianer", s: [2], text: "Treats it as a budget arithmetic problem." },
      { side: "right", label: "Right", outlet: "Southport Register", s: [1], text: "Frames the rise as a spending failure." },
    ],
    coverage: "All three outlets report the same 12% figure and differ on the cost to operators.",
    watch: ["Whether the fee schedule is published."],
    sources: SOURCES,
    ...overrides,
  };
}

const errorsOf = card => summarise(validateCard(card)).errors.map(e => e.code);

test("a well-formed card passes", () => {
  const { ok, errors } = summarise(validateCard(goodCard()));
  assert.ok(ok, `unexpected errors: ${JSON.stringify(errors, null, 2)}`);
});

test("rule 1: `multi` citing two articles from ONE outlet is rejected", () => {
  const card = goodCard({
    sources: [SOURCES[0], { ...SOURCES[0], t: "Dock fees rise 12% (updated)", u: "https://northwind.example/a2" }, SOURCES[1], SOURCES[2]],
    facts: [{ t: "Dock fees rise 12%.", s: [0, 1], tier: "multi" }],
    views: [
      { side: "left", label: "Left", outlet: "Northwind Wire", s: [0], text: "x" },
      { side: "centre", label: "Centre", status: "not sourced" },
      { side: "right", label: "Right", outlet: "Southport Register", s: [2], text: "y" },
    ],
  });
  assert.ok(errorsOf(card).includes("tier-multi-unsupported"));
});

test("a fact citing a source index that does not exist is rejected", () => {
  const card = goodCard({ facts: [{ t: "Something.", s: [7], tier: "single" }] });
  assert.ok(errorsOf(card).includes("fact-bad-index"));
});

test("an uncited fact is rejected", () => {
  const card = goodCard({ facts: [{ t: "Something nobody reported.", s: [], tier: "single" }] });
  assert.ok(errorsOf(card).includes("fact-uncited"));
});

test('rule 4: a side marked `not sourced` may not carry view text', () => {
  const card = goodCard({
    views: [
      { side: "left", label: "Left", outlet: "Northwind Wire", s: [0], text: "ok" },
      { side: "centre", label: "Centre", outlet: "The Meridianer", s: [2], text: "ok" },
      { side: "right", label: "Right", status: "not sourced", text: "Conservatives would likely argue the fees are a tax." },
    ],
  });
  assert.ok(errorsOf(card).includes("view-synthesised"));
});

test("rule 4: a view may not be attributed to an outlet it was not read from", () => {
  const card = goodCard({
    views: [
      { side: "left", label: "Left", outlet: "Northwind Wire", s: [0], text: "ok" },
      { side: "centre", label: "Centre", outlet: "The Meridianer", s: [2], text: "ok" },
      { side: "right", label: "Right", outlet: "Southport Register", s: [2], text: "Attributed to the wrong outlet." },
    ],
  });
  assert.ok(errorsOf(card).includes("view-outlet-mismatch"));
});

test("rule 4: a missing side must be present as `not sourced`, not omitted", () => {
  const card = goodCard({
    views: [
      { side: "left", label: "Left", outlet: "Northwind Wire", s: [0], text: "ok" },
      { side: "centre", label: "Centre", outlet: "The Meridianer", s: [2], text: "ok" },
    ],
  });
  assert.ok(errorsOf(card).includes("view-missing"));
});

test("rule 5: an inapplicable left-right axis must name the axis that applies", () => {
  const card = goodCard({ axis: { applies: false } });
  assert.ok(errorsOf(card).includes("axis-unnamed"));

  const named = goodCard({ axis: { applies: false, name: "government vs diaspora" } });
  assert.ok(!errorsOf(named).includes("axis-unnamed"));
});

test("rule 11: an MBFC label without its MBFC link is rejected", () => {
  const card = goodCard({
    sources: [
      { ...SOURCES[0], b: "Left-Center", labelSource: { provider: "mbfc", url: null } },
      SOURCES[1], SOURCES[2],
    ],
  });
  assert.ok(errorsOf(card).includes("mbfc-unlinked"));
});

test("an unfinished candidate is not mistaken for a card", () => {
  const card = goodCard({ headline: null, context: null, coverage: null, _prose: "unwritten" });
  const codes = errorsOf(card);
  assert.ok(codes.includes("prose-missing") || codes.includes("prose-null"));
  assert.ok(summarise(validateCard(card)).warnings.some(w => w.code === "candidate-leftover"));
});

test("payload-level: a run where no card has a sourced right view is blocked", () => {
  const oneSided = goodCard({
    views: [
      { side: "left", label: "Left", outlet: "Northwind Wire", s: [0], text: "ok" },
      { side: "centre", label: "Centre", outlet: "The Meridianer", s: [2], text: "ok" },
      { side: "right", label: "Right", status: "not sourced" },
    ],
  });
  const { errors } = summarise(validatePayload([oneSided]));
  assert.ok(errors.some(e => e.code === "balance-starved" && e.message.includes("right")));
});

test("payload-level: a balanced run passes", () => {
  const { ok } = summarise(validatePayload([goodCard(), goodCard()]));
  assert.ok(ok);
});
