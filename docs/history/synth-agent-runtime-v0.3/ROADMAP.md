# Roadmap after v0.3

v0.3 closes the main control-plane gaps from the early prototype, but several production layers remain intentionally future work:

- lossless OpenAI Responses API translation for the Pi/OpenCode stack HTTP adapter;
- full Pi monorepo patch/PR integration rather than bundled bridge source;
- database-backed multi-process `WorldStore` with optimistic concurrency;
- Temporal Continue-As-New/message-cursor production hardening;
- native Git `cat-file --batch`, shared content-addressed blob cache, LFS/submodule policy and clean-blob eviction;
- Firecracker/Kata executor implementing the existing `Executor` contract;
- richer ProjectCell service templates (Postgres/Redis/browser/dev server);
- secret broker, scoped egress identities and provider/Kubernetes credential policy;
- transactional treatment of physical/external effects using idempotency and compensation;
- supervisor merge-selection/review policies and canonical artifact promotion;
- runtime-native Desktop/TUI/voice presentation layer.

These are additive. The current public seams (`AgentEngine`, `WorldStore`, `GatewayBackend`, `Executor`, `DurabilityProvider`, `ExecutionEnv`) are intended to let those layers evolve independently.
