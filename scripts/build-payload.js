#!/usr/bin/env node
/**
 * build-payload.js — splice validated cards into app/meridian.html.
 *
 * The published artifact cannot fetch anything at runtime, so the payload is
 * baked into the file at build time. This replaces the `const STORIES = [...]`
 * array and touches nothing else.
 *
 * It refuses to write if validation fails. That refusal is the point: the last
 * gate before something reaches the published page is a mechanical check of
 * the rules, not a judgement call at the end of a long run.
 *
 * Usage:
 *   node scripts/build-payload.js cards.json
 *   node scripts/build-payload.js cards.json --out app/meridian.next.html
 *   node scripts/build-payload.js cards.json --check     # validate only
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePayload, summarise } from "../backend/src/validate-card.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, "..", "app", "meridian.html");

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes("--check");
const outIndex = argv.indexOf("--out");
const OUT = outIndex >= 0 ? resolve(argv[outIndex + 1]) : APP;
const input = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out");

if (!input) {
  console.error("Usage: node scripts/build-payload.js <cards.json> [--out file] [--check]");
  process.exit(2);
}

const cards = JSON.parse(await readFile(input, "utf8"));
const problems = validatePayload(cards);
const { ok, errors, warnings } = summarise(problems);

for (const w of warnings) console.warn(`WARN  ${w.path}  ${w.code}: ${w.message}`);
for (const e of errors) console.error(`ERROR ${e.path}  ${e.code}: ${e.message}`);

if (!ok) {
  console.error(`\n${errors.length} error(s). Nothing written — the payload does not satisfy the rules in CLAUDE.md.`);
  process.exit(1);
}
console.log(`${cards.length} cards validated${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`);

if (CHECK_ONLY) {
  console.log("--check: validation only, nothing written.");
  process.exit(0);
}

// --- splice --------------------------------------------------------------

const html = await readFile(APP, "utf8");

const marker = /const\s+STORIES\s*=\s*\[/.exec(html);
if (!marker) {
  console.error("Could not find `const STORIES = [` in app/meridian.html. Refusing to guess where the payload goes.");
  process.exit(2);
}

const arrayStart = html.indexOf("[", marker.index);
let depth = 0, i = arrayStart, inString = null, escaped = false;
for (; i < html.length; i++) {
  const ch = html[i];
  if (inString) {
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === inString) inString = null;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
  if (ch === "[") depth++;
  else if (ch === "]") { depth--; if (depth === 0) break; }
}
if (depth !== 0) {
  console.error("Could not find the end of the STORIES array. Refusing to write a half-spliced file.");
  process.exit(2);
}

const next = html.slice(0, arrayStart)
  + JSON.stringify(cards, null, 2)
  + html.slice(i + 1);

// Cheap sanity checks: the file should stay recognisably itself.
const sizeDelta = Math.abs(next.length - html.length) / html.length;
if (!next.includes("const REGIONS")) {
  console.error("Post-splice file is missing code that was there before. Refusing to write.");
  process.exit(2);
}
if (sizeDelta > 0.9) {
  console.warn(`WARN  file size changed by ${(sizeDelta * 100).toFixed(0)}% — check the output before publishing.`);
}

await writeFile(OUT, next, "utf8");
console.log(`Wrote ${OUT} (${(next.length / 1024).toFixed(1)} KB, ${cards.length} stories).`);
console.log("Publish it to the existing artifact URL from a Cowork session — a new publish creates a second artifact.");
