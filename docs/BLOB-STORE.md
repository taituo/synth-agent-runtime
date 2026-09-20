# Blob store: access control and lifecycle

The blob store is content-addressed by sha256. This document states the access
model rather than leaving it implicit, and names what is still open.

## The model

**Within one trust domain, the digest is the capability.** A caller that holds a
digest can read the content; a caller that does not cannot (the digest is a
256-bit hash, not a name), and `get` re-hashes the bytes and raises
`BLOB_CORRUPT` on a mismatch, so integrity is verified on every read. Agents in
one deployment collaborate by passing references — that is the intended way for
a producer to hand content to a consumer, and it is why unrestricted read *by
digest* is acceptable here. `SharedTrustDomainPolicy` makes that explicit; it is
the default when no policy is supplied.

**Across tenants it is not acceptable.** `GuardedBlobStore` consults a
`BlobAccessPolicy` and is bound to a principal with `forPrincipal`:

- `TenantBlobPolicy` allows a read when the blob is shared (no `tenantId`) or
  owned by the principal's tenant, and requires a principal with a tenant to
  write. Writes are stamped with the principal's `tenantId` in the sidecar.
- `GuardedBlobStore.stat` returns `undefined` for a blob the principal may not
  read, so a denial does not leak that the blob exists; `get` throws
  `BLOB_FORBIDDEN:read`.
- A policy that denies writes makes `put` throw `BLOB_FORBIDDEN:write`.

The digest itself is never a secret: if a producer shares a reference with the
wrong party, that party can read it. Tenant scoping is the boundary that
prevents this across tenants; sharing inside a tenant is by design.

## Lifecycle

`FileSystemBlobStore.list()` returns every content object with its sidecar
metadata, and `prune({ keep, olderThanMs, now })` deletes objects that are
neither in `keep` nor younger than `olderThanMs`, reporting `removed` and
`freedBytes`. Reachability is the **caller's** job: the artifact index knows
which digests are still referenced (including the `producedFrom` chain), so the
caller supplies `keep`.

## Lifecycle wiring

- **GC from the index's reachable set.** `src/artifacts/retention.ts` exports
  `reachableDigests(index)` (every recorded artifact plus its `producedFrom`
  ancestry, including referenced-but-unrecorded digests, so a missing index
  entry cannot cause a live blob to be deleted) and
  `sweepUnreferencedBlobs({ store, index, olderThanMs })`, which calls
  `prune` with that set. Scheduling is the caller's job; the sweep is
  deterministic and unit-tested.
- **Write quota.** `TenantWriteQuota` enforces a per-blob size ceiling and a
  per-tenant cumulative ceiling; `GuardedBlobStore.put` checks it only when the
  object is new (dedup does not charge twice) and does not charge a rejected
  write. The counter is in-memory and resets on restart; a deployment that needs
  durable accounting persists `usage()`.
- **Read auditing.** `GuardedBlobStore` emits a `BlobAuditEvent`
  (`op`, `digest`, `outcome` allowed/denied/not-found, `principal`, `at`) on
  every `get`, and on `put`, through the optional `audit` sink.
