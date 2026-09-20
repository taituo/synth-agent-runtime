import test from "node:test";
import assert from "node:assert/strict";
import he from "../he.js";

// The requirement the agent is told to satisfy. The held-out test covers the
// cases this one does not (default hex, astral symbols), so a constant stub or
// a partial fix cannot pass both.
test("encode honours the decimal option", () => {
  assert.equal(he.encode("€", { decimal: true }), "&#8364;");
});
