// One adapter factory for every endpoint. All providers are OpenAI-compatible
// (local Ollama, OpenCode Go, any other), so they share
// `@ai-sdk/openai-compatible`. The model is always a provider instance built
// from an explicit base URL: a bare model-id string routes through Vercel's
// hosted gateway by default, which would send an offline or local request to
// a remote host.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Endpoint } from "./config";

/**
 * The client identification Go's documented integration contract asks every
 * non-OpenCode client to send (it rejects a request without the session
 * header): a User-Agent naming this client, and one per-process session id
 * standing in for "one conversation". The router sends these on every
 * request, as call headers: the AI SDK replaces a provider-level User-Agent
 * with its own, but appends its suffix to a call-level one.
 */
export const CLIENT_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": "panthea-agents/0.1.0",
  "x-opencode-session": crypto.randomUUID(),
};

/** The endpoint answered with a redirect. Adapters refuse them, so a local URL cannot bounce a request (and its key) to another host. */
export class RedirectRefusedError extends Error {
  constructor(readonly status: number) {
    super(`endpoint answered ${status}, a redirect; redirects are refused`);
    this.name = "RedirectRefusedError";
  }
}

/** Wraps `base` so a redirect is never followed: the request is sent with `redirect: "manual"` and any 3xx answer becomes a `RedirectRefusedError`. */
function refusingRedirects(base: typeof fetch): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const response = await base(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new RedirectRefusedError(response.status);
    }
    return response;
  };
  return wrapped as typeof fetch;
}

export interface EndpointModelArgs {
  readonly endpoint: Endpoint;
  /** The model to request: the endpoint's own, or a role's override. */
  readonly model: string;
  /** Supplied by the caller from platform credential storage; never read here, never logged. */
  readonly apiKey?: string;
  /** Replaces the global `fetch`; only tests need this. */
  readonly fetch?: typeof fetch;
}

/** Builds the chat model for one endpoint. Endpoints that reject a JSON-schema request fail with a 400, which the router answers with a plain-text request and the repair pass. */
export function createEndpointModel(args: EndpointModelArgs): LanguageModel {
  const provider = createOpenAICompatible({
    name: args.endpoint.id,
    baseURL: args.endpoint.baseUrl,
    ...(args.apiKey === undefined ? {} : { apiKey: args.apiKey }),
    supportsStructuredOutputs: true,
    fetch: refusingRedirects(args.fetch ?? fetch),
  });
  return provider.chatModel(args.model);
}
