# Inference gateway and routing

The gateway is a normal OpenAI-compatible front door. `ProfileRouterBackend` maps stable logical model IDs to ordered backend routes and retries another route on pre-response HTTP failures such as 429/5xx.

`HttpGatewayBackend` proxies to another OpenAI-compatible service. The optional `OpenCodeStackGatewayBackend` translates Chat Completions into Pi context and runs them through `OpenCodeStackModels`, preserving client system/developer messages and tools.

Account stacking and logical-model routing are intentionally distinct: the account stack chooses among equivalent OpenCode Go credentials; the profile router chooses among backend/model policies.
