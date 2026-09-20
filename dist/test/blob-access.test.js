/**
 * Blob-store access control and lifecycle. The store is content-addressed, so
 * within one trust domain the digest is the capability; across tenants it is
 * not, and that boundary is enforced and tested.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemBlobStore, GuardedBlobStore, SharedTrustDomainPolicy, TenantBlobPolicy, TenantWriteQuota, } from "../src/index.js";
test("tenant policy: the owner reads, another tenant cannot, and existence is not leaked", async () => {
    const root = await mkdtemp(join(tmpdir(), "blob-acl-"));
    try {
        const store = new GuardedBlobStore(new FileSystemBlobStore(root), new TenantBlobPolicy());
        const alice = store.forPrincipal({ tenantId: "alice" });
        const bob = store.forPrincipal({ tenantId: "bob" });
        const ref = await alice.put(new TextEncoder().encode("alice's report"), { mediaType: "text/plain" });
        assert.equal(ref.tenantId, "alice");
        assert.equal(new TextDecoder().decode(await alice.get(ref.digest)), "alice's report");
        await assert.rejects(bob.get(ref.digest), /BLOB_FORBIDDEN:read/);
        assert.equal(await bob.stat(ref.digest), undefined, "a denied stat must not reveal existence");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("shared-trust-domain policy allows any principal to read by digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "blob-shared-"));
    try {
        const store = new GuardedBlobStore(new FileSystemBlobStore(root), new SharedTrustDomainPolicy());
        const ref = await store.put(new TextEncoder().encode("shared"));
        const other = store.forPrincipal({ tenantId: "someone-else" });
        assert.equal(new TextDecoder().decode(await other.get(ref.digest)), "shared");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("a policy that denies writes blocks put", async () => {
    const root = await mkdtemp(join(tmpdir(), "blob-deny-"));
    try {
        const readOnly = { authorize: (request) => request.op !== "write" };
        const store = new GuardedBlobStore(new FileSystemBlobStore(root), readOnly, { tenantId: "t" });
        await assert.rejects(store.put(new TextEncoder().encode("nope")), /BLOB_FORBIDDEN:write/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("prune removes unreferenced objects and keeps the reachable ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "blob-prune-"));
    try {
        const store = new FileSystemBlobStore(root);
        const keep = await store.put(new TextEncoder().encode("keep me"));
        const drop = await store.put(new TextEncoder().encode("drop me"));
        const result = await store.prune({ keep: [keep.digest] });
        assert.deepEqual(result.removed, [drop.digest]);
        assert.equal(result.freedBytes, drop.size);
        assert.equal(new TextDecoder().decode(await store.get(keep.digest)), "keep me");
        await assert.rejects(store.get(drop.digest), /ENOENT|BLOB/);
        // A fresh object is younger than the threshold and survives.
        const young = await store.put(new TextEncoder().encode("young"));
        const agePrune = await store.prune({ olderThanMs: 60_000, keep: [keep.digest] });
        assert.equal(agePrune.removed.includes(young.digest), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("write quota: per-blob ceiling, per-tenant ceiling, and dedup does not charge twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "blob-quota-"));
    try {
        const quota = new TenantWriteQuota({ maxBytesPerBlob: 5, maxBytesPerTenant: 8 });
        const store = new GuardedBlobStore(new FileSystemBlobStore(root), new SharedTrustDomainPolicy(), { tenantId: "t" }, { quota });
        const four = new TextEncoder().encode("aaaa");
        await store.put(four);
        await store.put(four);
        assert.equal(quota.usage("t"), 4, "identical content is deduplicated and charged once");
        await assert.rejects(store.put(new TextEncoder().encode("bbbbbb")), /BLOB_QUOTA_EXCEEDED:blob/);
        await store.put(new TextEncoder().encode("bbbb"));
        assert.equal(quota.usage("t"), 8);
        await assert.rejects(store.put(new TextEncoder().encode("c")), /BLOB_QUOTA_EXCEEDED:tenant/);
        assert.equal(quota.usage("t"), 8, "a rejected write must not be charged");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("read auditing records allowed, denied and not-found reads with the principal", async () => {
    const root = await mkdtemp(join(tmpdir(), "blob-audit-"));
    try {
        const events = [];
        const store = new GuardedBlobStore(new FileSystemBlobStore(root), new TenantBlobPolicy(), undefined, {
            audit: (event) => events.push(event),
        });
        const alice = store.forPrincipal({ tenantId: "alice" });
        const ref = await alice.put(new TextEncoder().encode("report"));
        await alice.get(ref.digest);
        await assert.rejects(store.forPrincipal({ tenantId: "bob" }).get(ref.digest), /BLOB_FORBIDDEN:read/);
        await assert.rejects(alice.get(`sha256:${"0".repeat(64)}`), /BLOB_NOT_FOUND/);
        const reads = events.filter((event) => event.op === "read");
        assert.deepEqual(reads.map((event) => event.outcome), ["allowed", "denied", "not-found"]);
        assert.equal(reads[0]?.principal?.tenantId, "alice", "the audit event names who read");
        assert.equal(reads[1]?.principal?.tenantId, "bob");
        assert.ok(reads.every((event) => typeof event.digest === "string" && typeof event.at === "number"));
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
