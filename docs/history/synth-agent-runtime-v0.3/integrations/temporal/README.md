# Temporal integration

v0.3 adds a real Temporal workflow/client/worker integration as an **optional package**, while keeping the public runtime API Temporal-neutral.

```text
AgentRuntime API
      │
      ├ local mode → LocalMemoryDurability
      │
      └ durable deployment
             │
       Temporal workflow
       lifecycle + mailbox
             │
       runTurn activity
             │
         Pi / tools / K8s
```

The workflow owns durable lifecycle/mailbox state and signals. Model calls, Pi harness work and Kubernetes execution remain activities in normal Node worker processes, where network/filesystem access is allowed.

The optional integration has its own `package.json` because the root prototype intentionally has no hard Temporal SDK dependency.
