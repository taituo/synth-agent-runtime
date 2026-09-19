import type {
  HarnessBridgeActivities,
  HarnessInferenceRequest,
  HarnessInferenceResult,
  HarnessToolRequest,
  HarnessToolResult,
} from "./bridge-contracts.js";

export interface HttpHarnessBridgeActivityOptions {
  inferenceBaseUrl: string;
  inferenceApiKey?: string;
  inferenceHeaders?: Record<string, string>;
  toolCallbackBearerToken?: string;
  /** Exact callback origins the Temporal worker is allowed to contact. */
  allowedToolCallbackOrigins: string[];
  fetchImpl?: typeof fetch;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

function assertAllowedCallback(url: string, allowedOrigins: readonly string[]): string {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`unsupported harness callback protocol: ${parsed.protocol}`);
  }
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new Error(`harness callback origin is not allowed: ${parsed.origin}`);
  }
  if (
    parsed.pathname !== "/execute" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("harness callback URL must be the exact /execute endpoint");
  }
  return parsed.toString();
}

export function createHttpHarnessBridgeActivities(
  options: HttpHarnessBridgeActivityOptions,
): HarnessBridgeActivities {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async forwardInference(input: HarnessInferenceRequest): Promise<HarnessInferenceResult> {
      const path = input.api === "responses" ? "/v1/responses" : "/v1/chat/completions";
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...options.inferenceHeaders,
      };
      if (options.inferenceApiKey) headers.authorization = `Bearer ${options.inferenceApiKey}`;
      const response = await doFetch(joinUrl(options.inferenceBaseUrl, path), {
        method: "POST",
        headers,
        body: JSON.stringify(input.body),
      });
      const responseHeaders: Record<string, string> = {};
      for (const key of ["content-type", "openai-request-id", "x-request-id"]) {
        const value = response.headers.get(key);
        if (value) responseHeaders[key] = value;
      }
      return {
        status: response.status,
        headers: responseHeaders,
        bodyText: await response.text(),
      };
    },

    async forwardToolExecution(input: HarnessToolRequest): Promise<HarnessToolResult> {
      const callbackUrl = assertAllowedCallback(input.callbackUrl, options.allowedToolCallbackOrigins);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.toolCallbackBearerToken) {
        headers.authorization = `Bearer ${options.toolCallbackBearerToken}`;
      }
      const response = await doFetch(callbackUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`harness tool callback failed (${response.status}): ${text.slice(0, 500)}`);
      }
      return JSON.parse(text) as HarnessToolResult;
    },
  };
}
