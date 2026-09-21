/**
 * The shared `replace_in_file` / `workspace.replace` matching contract.
 *
 * The exact-match-only behaviour lost a live real-model durable attempt: the
 * model indented `old_text` with two tabs where the file has four, the match
 * occurred zero times, and the attempt finished with no edit. These pin the
 * tolerant fallback, its uniqueness requirement, and that an exact match is
 * still used unchanged when there is one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { replaceInText } from "../src/index.js";
test("replaceInText: an exact, unique match is replaced unchanged", () => {
    const result = replaceInText("a\nb\nc\n", "b", "\tB");
    assert.equal(result.ok, true);
    assert.equal(result.content, "a\n\tB\nc\n");
    assert.equal(result.tolerant, undefined);
});
test("replaceInText: an exact but non-unique match is refused, never guessed", () => {
    const result = replaceInText("x\nx\n", "x", "y");
    assert.equal(result.ok, false);
    assert.equal(result.occurrences, 2);
    assert.match(result.error ?? "", /occurs 2 times/);
});
test("replaceInText: a missing old_text is refused", () => {
    const result = replaceInText("a\nb\n", "not-present", "x");
    assert.equal(result.ok, false);
    assert.equal(result.occurrences, 0);
});
test("replaceInText: empty old_text is refused", () => {
    const result = replaceInText("a\n", "", "x");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /must not be empty/);
});
test("replaceInText: wrong leading indentation falls back to an indent-tolerant match", () => {
    // The file uses four tabs; the model's old_text uses two (the live failure).
    const content = ["function f() {", "\t\t\t\tif ($6) {", "\t\t\t\t\tparseError('x');", "\t\t\t\tcodePoint = parseInt(hexDigits, 10);", "\t\t\t}"].join("\n");
    const oldText = ["\t\tif ($6) {", "\t\t\tparseError('x');", "\t\tcodePoint = parseInt(hexDigits, 10);", "\t\t}"].join("\n");
    const newText = ["\t\tif ($6) {", "\t\t\tparseError('x');", "\t\tcodePoint = parseInt(hexDigits, 16);", "\t\t}"].join("\n");
    const result = replaceInText(content, oldText, newText);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.tolerant, true);
    // Every replacement line is based on the file block's indentation, so the edit
    // lands where the code actually is; the content change is exact.
    assert.ok(result.content.includes("\t\t\t\tcodePoint = parseInt(hexDigits, 16);"), result.content);
    assert.ok(!result.content.includes("parseInt(hexDigits, 10)"), result.content);
    assert.equal(result.content, ["function f() {", "\t\t\t\tif ($6) {", "\t\t\t\t\tparseError('x');", "\t\t\t\tcodePoint = parseInt(hexDigits, 16);", "\t\t\t\t}"].join("\n"));
});
test("replaceInText: a single-line old_text with the wrong indent re-indents to the file", () => {
    const content = "\t\t\t\tcodePoint = parseInt(hexDigits, 10);\n";
    const result = replaceInText(content, "\t\tcodePoint = parseInt(hexDigits, 10);", "\t\tcodePoint = parseInt(hexDigits, 16);");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.content, "\t\t\t\tcodePoint = parseInt(hexDigits, 16);\n");
});
test("replaceInText: an ambiguous indent-tolerant match is still refused", () => {
    const content = "\tfoo();\n\t\tfoo();\n";
    const result = replaceInText(content, "\t\t\tfoo();", "bar();");
    assert.equal(result.ok, false);
    assert.equal(result.occurrences, 0);
    assert.match(result.error ?? "", /occurs 0 times/);
});
