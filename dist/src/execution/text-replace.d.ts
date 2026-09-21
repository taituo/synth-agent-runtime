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
/** Apply the shared matching contract; exact-unique first, then indent-tolerant. */
export declare function replaceInText(content: string, oldText: string, newText: string): TextReplaceResult;
