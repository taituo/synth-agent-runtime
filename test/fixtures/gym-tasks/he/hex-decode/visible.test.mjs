import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const he = require("../he.js");

test("decodes a hexadecimal character reference", () => {
  assert.equal(he.decode("&#x41;"), "A");
});
