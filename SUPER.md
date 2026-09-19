# Supervisor orchestration

`Supervisor` is a graph/orchestration helper above `AgentRuntime`; it is not a special LLM species.

`delegate()` creates a task, forks the supervisor's workspace, spawns a child and records `supervises` and `delegates_to` relations. `fanOut()` creates multiple workers. `assignReviewer()` creates a reviewer and records a `reviews` edge.

A child agent may itself become a supervisor because supervision is represented by relationships, not a fixed hierarchy class.


## v0.8 concurrent supervisors

Supervisor/project mutations should use project revision CAS. If multiple supervisors coordinate the same logical command or agent, use the distributed lease/fencing primitives rather than relying on one process.
