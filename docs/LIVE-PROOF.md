# Live proof

`npm run live:proof` runs every proof available in the current environment and prints PASS/SKIP separately.

In a bare environment with no external infrastructure or credentials configured, the result legitimately looks like this:

```text
PASS core build + unit/contracts
PASS integration syntax
PASS process SIGKILL recovery
PASS Responses contracts
SKIP live Postgres — SYNTH_POSTGRES_URL not set
SKIP Pi E2E — PI_REPO not set
SKIP live Kubernetes Pod kill — SYNTH_K8S_LIVE != 1
SKIP live gateway probe — SYNTH_GATEWAY_URL not set
```

This is by design, not a gap: a SKIP is not evidence of correctness, and the harness deliberately refuses to report PASS for a check it cannot actually run. The external contracts remain in the package so CI or a real deployment environment can promote them to PASS by supplying the relevant environment variables/credentials.

## This RC was independently verified live

Separately from the repeatable `npm run live:proof` harness above, `v1.0.0-rc.1` was independently verified with all four infrastructure-dependent checks live and passing, outside a bare CI/sandbox environment:

- **Real PostgreSQL** — concurrency and fencing proven under 16 concurrent workers, including deliberate database-clock skew and a two-generation hard agent takeover (see `docs/POSTGRES.md`).
- **Real pinned Pi checkout E2E** — see `docs/PI-E2E.md`.
- **Real Kubernetes + gVisor pod-kill** — 3/3 green on a real cluster (see `docs/KUBERNETES-RUN.md`).
- **A real external provider matrix** — abort-survival, `previous_response_id` continuations, tool calls, and 3-way concurrency against a live subscription-backed gateway.

Exact figures and the full test list are in `README.md`'s "Tests executed for this artifact" section and in `CHANGELOG.md`; this document intentionally does not restate the numbers to avoid them drifting out of sync.

Useful environment variables are documented by the scripts and integration READMEs. No provider credentials or cluster credentials are bundled in this artifact.
