export class InMemoryArtifactIndex {
    #byDigest = new Map();
    record(ref, at = Date.now()) {
        const record = { ref, at };
        this.#byDigest.set(ref.digest, record);
        return record;
    }
    get(digest) {
        return this.#byDigest.get(digest);
    }
    byProducer(producedBy) {
        return [...this.#byDigest.values()].filter((record) => record.ref.producedBy === producedBy);
    }
    /** Artifacts derived from `digest` (their `producedFrom` includes it). */
    byInput(digest) {
        return [...this.#byDigest.values()].filter((record) => record.ref.producedFrom?.includes(digest));
    }
    list() {
        return [...this.#byDigest.values()];
    }
    /**
     * Walk the `producedFrom` chain backwards from `digest`. Depth-limited and
     * cycle-safe.
     *
     * Returns a report, not a bare digest list: a bare list cannot distinguish an
     * intact chain from a broken one (a digest named by `producedFrom` but never
     * recorded looks identical to a recorded ancestor), nor a known root from an
     * unknown digest — both would silently give false confidence. `gaps` names
     * every referenced-but-unknown digest and `intact` is true only when the walk
     * completed with no gaps.
     */
    walkProvenance(digest, maxDepth = 32) {
        const seen = new Set();
        const nodes = [];
        const gaps = [];
        let truncated = false;
        const stack = [{ id: digest, depth: 0 }];
        while (stack.length > 0) {
            const { id, depth } = stack.pop();
            if (seen.has(id))
                continue;
            if (depth > maxDepth) {
                truncated = true;
                continue;
            }
            seen.add(id);
            const record = this.#byDigest.get(id);
            if (record)
                nodes.push({ digest: id, known: true, record });
            else {
                nodes.push({ digest: id, known: false });
                gaps.push(id);
            }
            for (const input of record?.ref.producedFrom ?? [])
                stack.push({ id: input, depth: depth + 1 });
        }
        return { nodes, gaps, truncated, intact: gaps.length === 0 && !truncated };
    }
}
