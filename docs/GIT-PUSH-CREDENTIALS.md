# Git push credentials for the sandbox (mechanism 2)

Mechanism 2 lets a sandboxed agent push its work out. That needs a credential
inside the untrusted sandbox, which contradicts the "no repository credentials
in the sandbox" posture. This scopes the credential so what it can do is
bounded, and states plainly what remains.

## The grant

The runtime controls a bare repo. `createScopedPushGrant({ repoDir, ref, ttlMs })`
installs a `pre-receive` hook and writes a grant for exactly one ref.

The hook rejects any push that is not **exactly one new ref** matching an
unexpired grant; it forbids deletes and force/overwrite; and it consumes the
grant, so it is **one-shot**. The credential the sandbox carries is only the
transport secret (a per-run SSH key or bearer token); the authorization is the
grant plus the hook, so even a stolen credential can create the granted ref once
and nothing else.

## What an escaped agent can do with what remains

- **Can**: push arbitrary commit content to the one granted ref
  (`refs/synth/<agent>/<run>`), once, before expiry. That is the intended
  capability.
- **Cannot**: push to any other ref, delete or force-update a ref, replay the
  grant, or (with a per-run credential) authenticate again after the run.

## Residual risk, stated

- **The scoping is only as strong as the hook and the credential's transport
  scope.** If the transport credential grants broader server access — e.g. a
  shared SSH key valid for every repo — a misconfigured server could allow other
  pushes and the hook would not run. Use a per-run key restricted with
  `command="git-receive-pack '<repo>'"`, or a dedicated per-run repo.
- **The pushed content is untrusted.** The runtime must treat it as data (read
  the tree, diff, digest) and never execute hooks or build scripts from it.
  `ingestBundle`/`treeDigest` already read rather than execute.
- **Exfiltration.** A bearer token could be copied out and used once from
  elsewhere within the TTL; one-shot plus a short TTL bound the damage to a
  single push to the allowed ref.
- **Read access.** The credential must not grant read access to other repos; a
  push-only, single-repo credential is required.

## What this does not cover

The transport credential's exact form (SSH key vs bearer token) is
deployment-specific. This repo provides the authorization mechanism (grant plus
hook) and its tests against real git, not the secret distribution.
