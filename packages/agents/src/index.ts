// Context, memory, planning, model routing, and fallback live here. Model
// routing is the first system: a router that turns a context into a typed
// intent through operator-configured OpenAI-compatible endpoints.

export type {
  Endpoint,
  ParseResult,
  RoleAssignment,
  RoutePlan,
  RouteStep,
  RoutingConfig,
} from "./config";
export {
  isLocalHost,
  isLocalUrl,
  parseRoutingConfig,
  planRoute,
} from "./config";
export type { EndpointModelArgs } from "./providers";
export { createEndpointModel, RedirectRefusedError } from "./providers";
export { extractJsonObjects, repairIntent } from "./repair";
export type {
  FailureReason,
  IntentSchema,
  RouteContext,
  RouteLimits,
  RouteResult,
  Router,
  RouterOptions,
  StepFailure,
  StepMetadata,
} from "./router";
export { createRouter, DEFAULT_ROUTE_LIMITS } from "./router";
