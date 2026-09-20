import test from "node:test";
import assert from "node:assert/strict";
import { check, complete } from "./gym-hidden-harness.mjs";

// Capture the real assert before importing the agent-controlled module, so a
// patch that replaces assert.equal cannot win. Import the module dynamically
// for the same reason (its top-level side effects run after this line, and
// after the harness has read and deleted the per-run key).
const equal = assert.equal.bind(assert);
const he = (await import("./he.js")).default;

test("hidden: decimal and hex encodings for BMP and astral symbols", () => {
  // Cases the visible test does not cover.
  check("default is hexadecimal", () => equal(he.encode("€"), "&#x20AC;"));
  check("decimal option", () => equal(he.encode("€", { decimal: true }), "&#8364;"));
  check("decimal astral symbol", () => equal(he.encode("😀", { decimal: true }), "&#128512;"));
  check("hex astral symbol", () => equal(he.encode("😀"), "&#x1F600;"));
  complete();
});
