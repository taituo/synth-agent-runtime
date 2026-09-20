import test from "node:test";
import assert from "node:assert/strict";

// Capture the real assert before importing the agent-controlled module, so a
// patch that replaces assert.equal cannot win. Import the module dynamically
// for the same reason (its top-level side effects run after this line).
const equal = assert.equal.bind(assert);
const he = (await import("./he.js")).default;

test("hidden: decimal and hex encodings for BMP and astral symbols", () => {
  // Cases the visible test does not cover.
  equal(he.encode("€"), "&#x20AC;", "default is hexadecimal");
  equal(he.encode("€", { decimal: true }), "&#8364;", "decimal option");
  equal(he.encode("😀", { decimal: true }), "&#128512;", "decimal astral symbol");
  equal(he.encode("😀"), "&#x1F600;", "hex astral symbol");
  // A completing run prints the per-run nonce; the scorer requires it, so an
  // early process.exit(0) or a skipped run is not a pass.
  console.log("GYM_HIDDEN_COMPLETE " + process.env.GYM_HIDDEN_NONCE);
});
