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
     * Walk the `producedFrom` chain backwards from `digest`, returning every
     * reachable digest (including the start). Depth-limited and cycle-safe.
     */
    walkProvenance(digest, maxDepth = 32) {
        const seen = new Set();
        const out = [];
        const stack = [{ id: digest, depth: 0 }];
        while (stack.length > 0) {
            const { id, depth } = stack.pop();
            if (seen.has(id) || depth > maxDepth)
                continue;
            seen.add(id);
            out.push(id);
            for (const input of this.#byDigest.get(id)?.ref.producedFrom ?? [])
                stack.push({ id: input, depth: depth + 1 });
        }
        return out;
    }
}
