# Supervisor orchestration

`Supervisor` is a graph/orchestration helper above `AgentRuntime`; it is not a special LLM species.

`delegate()` creates a task, forks the supervisor's workspace, spawns a child and records `supervises` and `delegates_to` relations. `fanOut()` creates multiple workers. `assignReviewer()` creates a reviewer and records a `reviews` edge.

A child agent may itself become a supervisor because supervision is represented by relationships, not a fixed hierarchy class.
