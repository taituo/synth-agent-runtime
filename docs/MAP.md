# Plain-language map: what each layer is, and what it is NOT

> **Runtime consolidation (2026-09-20).** Temporal is the single durable engine
> and the shared `GatewayAgentEngine` is the one turn body. The homegrown
> `AgentRuntime`, `DurableTurn`/`transactional-turn`, `TemporalDurabilityProvider`,
> `EffectReconciler`, `AgentRunner`/`LeasedAgentRunner`, `CommandCoordinator`,
> `EffectPolicy` and orchestration `Supervisor` were deleted (`CHANGELOG.md`,
> Unreleased); the in-memory/JSON durability stores, the world implementations
> and the chaos modules were quarantined to `docs/history/museum/`. References
> below to those APIs are historical. The root `README.md`, `docs/TEMPORAL.md`,
> `docs/HARNESS.md` and `docs/KNOWN-OPEN.md` describe the current shape.

Written because the vocabulary had drifted and several distinct things were being discussed
as if they were one. Each section names the thing, says what it does, and names what it is
often confused with. Verified against the code on 2026-09-20.

## Three INDEPENDENT axes

The most important thing: these are three separate questions, and a change to one does not
imply anything about the others.

1. **Which brain answers?** (model / provider / gateway)
2. **Where does the work physically happen?** (execution rung: memory vs sandbox)
3. **What keeps it alive across failures?** (the runtime: leases, mailbox, receipts)

Confusion mostly comes from treating these as one stack. They are not. An agent can run on a
cheap model, inside a real sandbox, with full durability — or any other combination.

---

## Axis 1: which brain answers

**Model** — the thing that actually does inference. `deepseek-v4-pro`, `kimi-k2.7-code`,
`grok-4.6`, and so on. 27 are available on the current subscription (measured live; see
below).

**Provider** — who serves models and owns the account, the authentication and the quota.
OpenCode Go is one provider. OpenRouter is another. A local model would be a third.
*Not the same as a model*: one provider serves many models.

**Gateway** — OUR OpenAI-compatible HTTP front door (`src/inference/gateway/server.ts`,
normally on :8787). Anything that speaks the OpenAI protocol can call it without knowing what
is behind it.
*Not a provider*: the gateway serves no models of its own. It is a door, not a room.

**Backend** — what the gateway calls to fulfil a request. The interface is two methods:
`listModels()` and `handle(request, model)` (`src/inference/gateway/types.ts`).
Implementations:
- `http-upstream.ts` — any OpenAI-compatible endpoint. This is what makes the whole thing
  provider-agnostic.
- `profile-router-backend.ts` — picks among several profiles, with failover, cooldown and
  sticky affinity.
- `integrations/opencode-http-gateway/adapter.ts` — exposes Pi's model runtime as a backend.

**Profile** — one virtual model in the router plus the ordered routes that can serve it, each
route naming a backend, with per-route health/cooldown state. A profile is NOT "an account" —
that was a narrow reading. Profiles can span providers, so routing across providers needs no
new accounts.

### The visibility trap that caused real confusion
The probe host `/tmp/opencode/audit/pi/ogw-host.mts` passed
`modelIds: ["muse-spark-1.3-contributor"]`. That option was a FILTER, not a definition: it
narrowed `listModels()` to one id. One hardcoded line made 27 models look like one, and every
accuracy and latency number recorded up to that point is that single model's number.
Lesson: when a list looks surprisingly short, look for the filter before believing it.

The filter is gone: `listModels()` never filters discovery now (authorization belongs in the
gateway's tenant policy), and `npm run models:list` prints the catalog with provider/profile.
The live unfiltered list is 27 models, all `provider: opencode-go`.

---

## Axis 2: where the work physically happens

**Execution rung** — where an agent's effects actually land. Two of them:
- **synthetic** (`src/execution/synthetic.ts`): an in-memory workspace, no filesystem,
  fidelity 0. Fast and free. `process.exec` returns `ESCALATION_REQUIRED`, so it escalates.
- **real** (`src/execution/kubernetes/`): a gVisor sandbox with a real filesystem and real
  processes.

**ExecutionBroker** (`src/execution/broker.ts`) picks the rung PER EFFECT (fidelity floor,
then `canExecute`) and escalates when needed, so a single turn can be part in-memory and part
sandboxed. Receipts record which rung ran what.

*This is what "isolation" means in our conversations.* It has nothing to do with models or
providers. Changing the model does not change the rung, and vice versa.

---

## Axis 3: what keeps it alive

**The runtime (synth)** — durability: leases with fencing tokens, the durable mailbox,
effect receipts, the CAS world store. This is the part being tested by killing things.

**Temporal** — one durability backend for the runtime, used by the integration. It is not the
runtime itself, and not a model or a provider.

*The control arm in the gym milestone removes THIS axis only* — same model, same rung, no
durability — so the comparison measures durability rather than something else.

---

## Pi — a fourth thing, on none of those axes

**Pi** is a separate agent harness: it runs an agent's loop, prompts and tools. It is not
ours and it is not inference.

- `pi-opencode-stack-router` makes several OpenCode Go accounts look like ONE ordinary
  provider to Pi.
- `pi-runtime-bridge` is the seam between our `AgentRuntime` and Pi's harness.
- `pi-synthetic-git-prototype` runs Pi's real tools against a fully in-memory workspace —
  i.e. Pi on the synthetic rung. This is why rung parity matters: if the synthetic rung lies,
  that prototype teaches something false.

"Harness" is the most overloaded word in this project: Pi's `AgentHarness` runs agents, while
our `live:*` scripts are test harnesses. Different things entirely.

---

## Artifacts — how results leave and travel onward

**Egress** (getting out of the sandbox): bounded inline snapshot, git transport, patch
extraction, content-addressed blob store.
**Handoff** (reaching the next reader): a reference with provenance, never the bytes — proven
by a 4 MB artifact moving workflow history by **12–23 bytes** across two live runs (the
measured band; the earlier "17 bytes" figure was inside the band but not any single run's
number).

---

## One-line summary
A **provider** serves **models**; our **gateway** fronts them through a **backend**, choosing
among **profiles**. An agent's effects land on a **rung** (memory or sandbox). The
**runtime** keeps all of it alive across failures. **Pi** is a separate harness that runs
agents. **Artifacts** are how results get out and travel onward.
