/**
 * The `replace_in_file` / `workspace.replace` matching contract, shared by every
 * implementation (the gym's local tool, the synthetic rung, the sandbox pod) so
 * both arms of an experiment edit identically.
 *
 * The contract was exact-substring-only, and a live real-model run showed the
 * failure mode: the model indented a multi-line `old_text` with two tabs where
 * the file uses four, the exact match occurred zero times, the tool refused, and
 * the durable attempt reached `finish` with no edit. A code-editing tool should
 * not lose the task to leading whitespace.
 *
 * So: exact, unique match first, unchanged. Only when the exact match is absent
 * (never to override ambiguity) fall back to a line-based match that ignores
 * leading indentation, and re-indent the replacement to the matched block. A
 * tolerant match must also be unique, or the edit is still refused.
 */
export interface TextReplaceResult {
  ok: boolean;
  /** The rewritten text when the edit applied. */
  content?: string;
  /** Exact occurrences of `oldText` (for the refusal message). */
  occurrences: number;
  /** True when the match succeeded by ignoring leading indentation. */
  tolerant?: boolean;
  error?: string;
}

const LEADING_WHITESPACE = /^[ \t]+/;

function leadingWhitespace(line: string): string {
  return line.match(LEADING_WHITESPACE)?.[0] ?? "";
}

function withoutIndentation(line: string): string {
  return line.replace(LEADING_WHITESPACE, "");
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** Re-indent a replacement so its base indent matches the matched block's. */
function reindent(newText: string, targetIndent: string): string {
  const lines = newText.split("\n");
  const firstNonBlank = lines.find((line) => !isBlank(line));
  const sourceIndent = firstNonBlank ? leadingWhitespace(firstNonBlank) : "";
  return lines
    .map((line) => {
      if (isBlank(line)) return "";
      if (line.startsWith(sourceIndent)) return targetIndent + line.slice(sourceIndent.length);
      return targetIndent + withoutIndentation(line);
    })
    .join("\n");
}

/**
 * Match `oldText` as a contiguous block whose lines equal the file's lines after
 * leading whitespace is stripped. Returns the new text only on a UNIQUE block.
 */
function replaceIgnoringIndentation(content: string, oldText: string, newText: string): string | undefined {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  if (oldLines.length > 1 && oldLines[oldLines.length - 1] === "") oldLines.pop();
  if (oldLines.length === 0) return undefined;

  const starts: number[] = [];
  for (let start = 0; start + oldLines.length <= contentLines.length; start++) {
    let matches = true;
    for (let offset = 0; offset < oldLines.length; offset++) {
      if (withoutIndentation(contentLines[start + offset]!) !== withoutIndentation(oldLines[offset]!)) {
        matches = false;
        break;
      }
    }
    if (matches) starts.push(start);
  }
  if (starts.length !== 1) return undefined;

  const start = starts[0]!;
  const block = contentLines.slice(start, start + oldLines.length);
  const baseLine = block.find((line) => !isBlank(line));
  const targetIndent = baseLine ? leadingWhitespace(baseLine) : "";
  const replacement = reindent(newText, targetIndent).split("\n");
  contentLines.splice(start, oldLines.length, ...replacement);
  return contentLines.join("\n");
}

/** Apply the shared matching contract; exact-unique first, then indent-tolerant. */
export function replaceInText(content: string, oldText: string, newText: string): TextReplaceResult {
  if (oldText.length === 0) return { ok: false, occurrences: 0, error: "old_text must not be empty" };
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 1) return { ok: true, occurrences: 1, content: content.replace(oldText, newText) };
  if (occurrences === 0) {
    const tolerant = replaceIgnoringIndentation(content, oldText, newText);
    if (tolerant !== undefined) return { ok: true, occurrences: 1, content: tolerant, tolerant: true };
  }
  return { ok: false, occurrences, error: `old_text occurs ${occurrences} times; it must occur exactly once` };
}
