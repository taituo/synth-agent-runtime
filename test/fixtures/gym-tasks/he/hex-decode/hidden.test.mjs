import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const he = require("./he.js");

test("hex references decode at every code point size", () => {
  assert.equal(he.decode("&#x41;"), "A");
  assert.equal(he.decode("&#x20AC;"), "\u20AC");
  assert.equal(he.decode("&#x1F600;"), "\u{1F600}");
  assert.equal(he.decode("&#x1D306;"), "\u{1D306}");
});

test("a constant stub cannot satisfy every case", () => {
  assert.notEqual(he.decode("&#x41;"), he.decode("&#x20AC;"));
});
