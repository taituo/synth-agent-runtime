# Spec: getting artifacts out of a sandboxed agent run

Repo: /home/tiny/projects/pisynth/synth-agent-runtime. Push to origin/main.
Position in the roadmap: after priority lanes and the symlink decision, BEFORE the gym
milestone — the gym needs provable egress, since "the agent did the work" is worthless if
the result cannot be got out and verified.

Decisions are made below. Implement them; do not re-open them unless you find evidence they
are wrong, in which case say so with the evidence.

## The hard constraint that shapes everything

Content above a small, explicit ceiling must NEVER flow through Temporal workflow history.
History has a size limit and base64 attachments burn it fast — an agent that returns a 5 MB
build output would kill its own workflow. So: **content above the ceiling travels out of
band and the workflow carries only a reference; content below it may be inline.**

(An earlier version of this spec said "NEVER", full stop, and then kept a bounded inline
mechanism and called a patch a handoff. A reviewer correctly pointed out that the absolute
prohibition and the retained mechanisms cannot both hold. The ceiling rule is what was
actually meant: a 200-byte report should not need a round trip, and a 5 MB build output must
not be inline. Pick the ceiling deliberately, write the number down, and enforce it with a
loud failure rather than silent truncation.)
Every effect receipt that produces an artifact records its `sha256` digest, size and the
egress mechanism used. That digest is what makes "what did the agent actually produce?"
answerable after the fact, which is the whole point.

Today's only path is `src/workspace/snapshot-codec.ts`, which base64-encodes the entire
changed overlay inline. That is mechanism 1 below and it is the weakest one.

## Four mechanisms, all of them, each with its own test

### 1. Inline snapshot (exists) — keep, but bound it
Keep for small structured results only. Add an explicit size ceiling; above it, fail loudly
with a clear error telling the caller to use a different mechanism. A silent 20 MB base64
blob is the failure mode to prevent. Test the boundary on both sides.

### 2. Git as the transport — the primary path for code work
The agent commits inside the sandbox and pushes to a bare repo the runtime controls; the
runtime then reads the result from that repo.

Why this is primary: it is the only mechanism that preserves file modes and symlinks
correctly for free, because git stores the type in the tree (mode 120000 for a symlink,
100755 for an executable). The measured sandbox return path flattens symlinks into regular
files; git does not. It is also atomic, auditable, deduplicating and gives history.
`src/workspace/git-batch.ts` and `NativeGitSource` already exist — build on them.

Test against the Track 1 pinned real repos: round-trip a repo through a sandbox exec that
modifies it, push, read back, and assert the resulting tree hash is exactly what git
computes — including a symlink, an executable bit, and a file with an unusual name.

### 3. Patch extraction — for change proposals
`git diff` / `git format-patch` out as text. Small, reviewable, mergeable by a human, and
the right shape when the artifact IS a proposed change rather than a finished product.
Assert the patch applies cleanly to the base commit it names, on a clean checkout.

### 4. Content-addressed blob store — for everything that is not a repo
Build outputs, logs, binaries. Store by `sha256`, return the digest. Does not exist yet;
this is the missing piece. Keep it deliberately small: put, get, stat, and a digest in the
receipt. A local filesystem-backed implementation is enough — do not build a service.
Test: identical content stored twice yields one object; a corrupted object is detected on
read; a digest in a receipt resolves to exactly the bytes the sandbox produced.

## Decision on the symlink question (roadmap 2b)

**Preserve symlinks; validate the target.** A link whose target resolves inside the
workspace is kept as a link; one that escapes is rejected with the shared
`WORKSPACE_PATH_ESCAPES` error, exactly as a traversing write already is.

Reasoning: Track 1 proved real repositories genuinely contain symlinks, and silently
flattening them corrupts a repo in a way git will report as a mode change (120000 → 100644)
— a wrong answer that looks like success, which is the failure class this project keeps
finding and fixing. Safety against `/etc/passwd`-style escapes is achieved by validating the
target, not by destroying the information. Flattening trades a real correctness loss for a
safety property we can get another way.

Note the interaction: with mechanism 2 this matters less for code work, since git carries
the type itself. Fix it anyway — the workspace path is used by the synthetic rung and by
`pi-synthetic-git-prototype`, and it should not lie there either.

## Part two: handing an artifact ONWARD, for others to examine

Getting an artifact out of the sandbox is only half of it. The other half is passing it to
whoever looks at it next — another agent, a human reviewer, or a frontier model acting as a
judge. That is a different problem: it needs ADDRESSABILITY and PROVENANCE, not just bytes.

This is the plumbing the gym's evaluation step will need. To be precise, because the roadmap
and this spec appeared to contradict each other on it: the gym's PASS/FAIL needs **no judge**
— a planted test either goes green or it does not, and that is the whole point of choosing an
objectively checkable task. What does need judging is everything downstream of pass/fail:
ranking findings, triaging which are worth a human's attention, and comparing two solutions
that both pass. Roadmap item 6 is about that second thing, not about deciding correctness.

### The rule, same as before
A handoff passes a REFERENCE, never content. Concretely: `{digest, size, mediaType, producedBy,
producedFrom, mechanism}`. `producedFrom` is the digest(s) of the inputs, so a chain of agents
produces a chain you can walk backwards. Without that, "which run produced this?" is
unanswerable the moment more than one agent is running — and the whole point of the swarm is
that many are.

### Mechanisms, in the order they should be built

1. **Temporal signal / child workflow carrying the reference.** The natural fit for
   agent-to-agent handoff inside one run: the producer's workflow signals the consumer's
   with the digest. Cheap, durable, ordered, and it already fits the existing signal model.
   Hard constraint unchanged: the signal carries the reference, never the bytes.
2. **The blob store as the shared rendezvous.** Both sides read the same content-addressed
   store, so a handoff is just a digest plus read access. This is why the blob store is
   first in the order of work — it is the substrate for everything else here.
3. **Git refs for review-shaped handoffs.** The producer pushes to a ref
   (e.g. `refs/synth/<agent>/<run>`); a reviewer fetches it, diffs it, comments on it. For a
   human this is the only mechanism on this list they already know how to use, which matters
   more than elegance. A patch from mechanism 3 above is the same thing in email shape.
4. **A small artifact index.** A queryable record of what exists: digest, producer, inputs,
   time, and where the content lives. Not a service — a table. Without it, discovery means
   knowing a digest in advance, which no human ever does.

### Deliberately NOT now
Cross-cluster or cross-namespace handoff (Temporal Nexus and similar). It is the right answer
eventually, but there is one cluster today and building for a second one we do not have is
how specs rot. Note it and move on.

### What to prove
An end-to-end chain: agent A produces an artifact in the sandbox, hands the reference onward,
agent B (a different workflow) reads exactly those bytes by digest and nothing else, and the
provenance chain from B's output back to A's input is walkable. Assert the bytes are
identical and that no content crossed the workflow boundary — check the workflow history size
stays flat as the artifact grows. That last assertion is the one that actually tests the rule.

## Correction: the blackboard already exists, and it conflicts with the rule above

I wrote the rule "a handoff passes a reference, never content" and then found that the shared
structure this would land in already exists and violates it. Read this before building
anything new.

`src/world/` IS a blackboard: a shared store of projects, tasks and artifacts, each with its
own per-record compare-and-swap (`compareAndSwapArtifact` and friends). Per-record CAS means
the classic blackboard contention problem — everyone writing one structure — is already
partitioned. Do not build a second one.

But `Artifact` in `src/core/types.ts:48` is:

    { id, revision?, type: "workspace-diff"|"patch"|"report"|"build"|"custom",
      taskId?, workspaceId?, createdAt, data: unknown, metadata? }

`data: unknown` carries the CONTENT inline. Its `type` values already map almost exactly onto
the egress mechanisms in this spec, which is a good sign the model is right — but if
artifacts land on the blackboard with their bytes, the world store becomes the thing that
bloats and the rule has merely moved the problem from Temporal to here.

So the work is to fix the existing blackboard, not to invent one:
- `data` becomes a reference (`digest`, `size`, `mediaType`, `mechanism`), with content in
  the blob store. Keep a small-inline escape hatch with the same explicit ceiling as
  mechanism 1, since a 200-byte report should not need a round trip.
- add `producedFrom` (input digests) so the provenance chain is walkable.
- add the index from part two, keyed by producer and by input digest.
- this is a breaking change to a published type: bump it properly, note it in CHANGELOG, and
  check every existing writer and reader of `Artifact` before changing the shape.

## Related patterns worth knowing (context, not tasks)

- **Append-only event log** — already present via the event consumer and watermarks. The
  blackboard holds current state; the log holds how it got there. The judge step needs the
  latter: "why does this finding exist" is not answerable from final state alone.
- **Contract net** — announce a task, agents bid, one is awarded. This is the mechanism for
  letting a mass of cheap agents self-select work rather than pre-assigning it.
- **Stigmergy** — coordination through marks left in a shared environment rather than
  agent-to-agent messages. That is what the blackboard is, and it is why it scales: no
  O(n²) chatter.
- **Quorum / voting** — for the judge step: several cheap models produce findings, an
  aggregation decides what is worth a frontier model's scarce quota.

## Order of work
Blob store (4) first — it is small and the receipts need it. Then git transport (2), which
is the largest piece. Then patch extraction (3), which builds on 2. Then bound the inline
path (1). The symlink decision can land with whichever piece you do first.

## Report back
Per mechanism: what it does, its test, what it costs (size/latency), and when NOT to use it.
A short decision table an engineer can read in a minute. Plus the commit SHAs.
