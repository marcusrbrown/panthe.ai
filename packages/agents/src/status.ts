// How each configured endpoint's last request went, derived from the router's
// own results so it reflects real requests, never a separate probe. The
// router has already redacted any key from a failure's detail.

import type { RoutingConfig } from "./config";

export type EndpointStatus =
  | { readonly endpoint: string; readonly state: "untried" }
  | { readonly endpoint: string; readonly state: "ok" }
  | {
      readonly endpoint: string;
      readonly state: "failed";
      /** The router's failure reason, e.g. `network` or `key-missing`. */
      readonly reason: string;
      /** A short account with any key value redacted. */
      readonly detail: string;
    };

/** The router's step fields beyond the endpoint are accepted and ignored. */
interface StepFields {
  readonly model?: string;
  readonly attempts?: number;
  readonly elapsedMs?: number;
}

interface FailedStep extends StepFields {
  readonly endpoint: string;
  readonly reason: string;
  readonly detail?: string;
}

/** The part of a route result the status reads; a `RouteResult` is assignable to it. */
export type RouteOutcome =
  | {
      readonly kind: "intent";
      readonly step: StepFields & {
        readonly endpoint: string;
        readonly mode?: string;
      };
      readonly failed: readonly FailedStep[];
      readonly elapsedMs?: number;
    }
  | {
      readonly kind: "exhausted";
      readonly steps: readonly FailedStep[];
      readonly elapsedMs?: number;
    };

/** Every configured endpoint, untried, in config order. */
export function initialEndpointStatus(
  config: RoutingConfig,
): readonly EndpointStatus[] {
  return [...config.endpoints.keys()].map((endpoint) => ({
    endpoint,
    state: "untried",
  }));
}

/** The statuses after one routed request: each step that failed is failed, the one that answered is ok, every other endpoint keeps its last outcome. */
export function recordRouteOutcome(
  statuses: readonly EndpointStatus[],
  route: RouteOutcome,
): readonly EndpointStatus[] {
  const failed = route.kind === "intent" ? route.failed : route.steps;
  const outcomes = new Map<string, EndpointStatus>();
  for (const step of failed) {
    outcomes.set(step.endpoint, {
      endpoint: step.endpoint,
      state: "failed",
      reason: step.reason,
      detail: step.detail ?? "",
    });
  }
  if (route.kind === "intent") {
    outcomes.set(route.step.endpoint, {
      endpoint: route.step.endpoint,
      state: "ok",
    });
  }
  return statuses.map((status) => outcomes.get(status.endpoint) ?? status);
}
