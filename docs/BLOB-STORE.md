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

## What is still open

- **Automatic GC wiring.** `prune` exists and is tested, but nothing schedules
  it from the artifact index's reachable set. Closing: a retention job that
  walks the index and prunes on an interval.
- **Write quota / rate limit.** Any caller with a valid principal can write, so
  a runaway producer can fill the disk. Closing: a per-tenant write quota, or a
  size ceiling enforced at `put`.
- **Read auditing.** There is no record of who resolved which digest. Closing:
  emit an audit event on `GuardedBlobStore.get`, if the threat model needs it.
