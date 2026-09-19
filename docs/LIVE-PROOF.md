# Live proof

`npm run live:proof` runs every proof available in the current environment and prints PASS/SKIP separately.

For the packaged artifact the result was:

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

A SKIP is not evidence of correctness. The external contracts remain in the package so CI or a real deployment environment can promote them to PASS.

Useful environment variables are documented by the scripts and integration READMEs. No provider credentials or cluster credentials are bundled in this artifact.
