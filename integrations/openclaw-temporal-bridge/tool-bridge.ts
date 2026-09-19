import { createServer, type Server } from "node:http";

export type BridgeableAgentTool = {
  name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ): Promise<unknown>;
  [key: string]: unknown;
};

export interface TemporalToolBridgeOptions {
  bridgeUrl: string;
  bearerToken?: string;
  callbackHost?: string;
  callbackPort?: number;
  /** URL reachable from the Temporal worker; defaults to the local listener. */
  callbackUrl?: string;
  /** Token the Temporal worker must present to the local callback listener. */
  callbackBearerToken?: string;
  fetchImpl?: typeof fetch;
}

export interface OpenClawTemporalIdentity {
  agentId: string;
  sessionId: string;
}

type PendingInvocation = {
  identity: OpenClawTemporalIdentity;
  tool: BridgeableAgentTool;
  toolCallId: string;
  params: unknown;
  signal?: AbortSignal;
  onUpdate?: unknown;
};

export class OpenClawTemporalToolBridge {
  readonly callbackHost: string;
  readonly callbackPort: number;
  readonly callbackUrl: string;
  #pending = new Map<string, PendingInvocation>();
  #server?: Server;

  constructor(readonly options: TemporalToolBridgeOptions) {
    this.callbackHost = options.callbackHost ?? "127.0.0.1";
    this.callbackPort = options.callbackPort ?? 8792;
    this.callbackUrl =
      options.callbackUrl ?? `http://${this.callbackHost}:${this.callbackPort}/execute`;
  }

  #pendingKey(sessionId: string, toolCallId: string): string {
    return `${sessionId}\0${toolCallId}`;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    this.#server = createServer(async (req, res) => {
      try {
        if (
          this.options.callbackBearerToken &&
          req.headers.authorization !== `Bearer ${this.options.callbackBearerToken}`
        ) {
          res.writeHead(401).end();
          return;
        }
        if (req.method !== "POST" || req.url !== "/execute") {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          agentId: string;
          sessionId: string;
          toolCallId: string;
        };
        const pending = this.#pending.get(this.#pendingKey(body.sessionId, body.toolCallId));
        if (
          !pending ||
          pending.identity.agentId !== body.agentId ||
          pending.identity.sessionId !== body.sessionId
        ) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "tool invocation is not pending on this OpenClaw process" }));
          return;
        }
        pending.signal?.throwIfAborted();
        const result = await pending.tool.execute(
          pending.toolCallId,
          pending.params,
          pending.signal,
          pending.onUpdate as never,
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result }));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.callbackPort, this.callbackHost, resolve);
    });
  }

  wrap(tool: BridgeableAgentTool, identity: OpenClawTemporalIdentity): BridgeableAgentTool {
    const bridge = this;
    const callbacks = {
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
      ) => {
        signal?.throwIfAborted();
        const key = bridge.#pendingKey(identity.sessionId, toolCallId);
        if (bridge.#pending.has(key)) {
          throw new Error(`duplicate pending OpenClaw tool call: ${toolCallId}`);
        }
        const invocation: PendingInvocation = {
          identity,
          tool,
          toolCallId,
          params,
          signal,
          onUpdate,
        };
        bridge.#pending.set(key, invocation);
        try {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (bridge.options.bearerToken) {
            headers.authorization = `Bearer ${bridge.options.bearerToken}`;
          }
          const doFetch = bridge.options.fetchImpl ?? fetch;
          const response = await doFetch(
            `${bridge.options.bridgeUrl.replace(/\/$/, "")}/v1/synth/tools/execute`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                agentId: identity.agentId,
                sessionId: identity.sessionId,
                toolCallId,
                toolName: tool.name,
                arguments: params,
                callbackUrl: bridge.callbackUrl,
              }),
              signal,
            },
          );
          const text = await response.text();
          if (!response.ok) {
            throw new Error(
              `Synth Temporal tool bridge failed (${response.status}): ${text.slice(0, 500)}`,
            );
          }
          return (JSON.parse(text) as { result: unknown }).result;
        } finally {
          bridge.#pending.delete(key);
        }
      },
    };

    // Preserve Proxy/symbol/non-enumerable tool metadata. Object spread here is
    // unsafe for OpenClaw tools because some executors carry authority in
    // wrappers and metadata outside ordinary enumerable properties.
    return new Proxy<BridgeableAgentTool>(Object.create(Object.getPrototypeOf(tool)), {
      get(target, key, receiver) {
        if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
        if (Object.hasOwn(callbacks, key)) return Reflect.get(callbacks, key);
        return Reflect.get(tool, key, tool);
      },
      has: (target, key) => Reflect.has(target, key) || Reflect.has(tool, key),
      ownKeys: (target) => [...new Set([...Reflect.ownKeys(tool), ...Reflect.ownKeys(target)])],
      getOwnPropertyDescriptor(target, key) {
        const local = Reflect.getOwnPropertyDescriptor(target, key);
        if (local) return local;
        const source = Reflect.getOwnPropertyDescriptor(tool, key);
        if (!source) return undefined;
        if (Object.hasOwn(callbacks, key)) {
          return {
            configurable: true,
            enumerable: source.enumerable,
            writable: true,
            value: Reflect.get(callbacks, key),
          };
        }
        return "value" in source
          ? { ...source, configurable: true }
          : {
              ...source,
              configurable: true,
              get: source.get ? () => Reflect.get(tool, key, tool) : undefined,
              set: source.set ? (value) => { Reflect.set(tool, key, value, tool); } : undefined,
            };
      },
      set: (target, key, value, receiver) =>
        Object.hasOwn(target, key)
          ? Reflect.set(target, key, value, receiver)
          : Reflect.set(tool, key, value, tool),
      deleteProperty: (target, key) =>
        Object.hasOwn(target, key)
          ? Reflect.deleteProperty(target, key)
          : Reflect.deleteProperty(tool, key),
      preventExtensions: () => false,
    });
  }

  wrapAll<T extends BridgeableAgentTool>(
    tools: T[],
    identity: OpenClawTemporalIdentity,
  ): T[] {
    return tools.map((tool) => this.wrap(tool, identity) as T);
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
