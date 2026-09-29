// Routing configuration. A provider is any OpenAI-compatible endpoint: a
// base URL, a model, and an optional key reference. Roles are assigned to an
// endpoint, and an operator-ordered fallback list names further endpoints to
// try. Nothing here reads a key, opens a socket, or builds an adapter.
//
// Locality is derived from the URL and never configured. Offline mode drops
// every non-local endpoint from a role's route (ADR-0005, D02, D22) before
// the router builds anything.

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly path: string; readonly message: string };

export interface Endpoint {
  readonly id: string;
  /** OpenAI-compatible base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** The endpoint's default model. */
  readonly model: string;
  /** Names a key in platform credential storage; the value is supplied by the caller, never read here. */
  readonly keyRef?: string;
  /** Derived from `baseUrl` (see `isLocalHost`); not configurable. */
  readonly local: boolean;
}

export interface RoleAssignment {
  readonly endpoint: string;
  /** Overrides the endpoint's model for this role, on this endpoint only. */
  readonly model?: string;
  /** Replaces the global fallback list for this role. */
  readonly fallback?: readonly string[];
}

export interface RoutingConfig {
  /** In configuration order. */
  readonly endpoints: ReadonlyMap<string, Endpoint>;
  readonly roles: ReadonlyMap<string, RoleAssignment>;
  /** The operator's default ordered fallback list, as endpoint ids. */
  readonly fallback: readonly string[];
}

// --- Locality ------------------------------------------------------------------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(host: string): readonly number[] | undefined {
  const match = IPV4.exec(host);
  if (!match) {
    return undefined;
  }
  const octets = match.slice(1).map((part) => {
    // A leading zero reads as octal in some resolvers; refuse rather than guess.
    return part.length > 1 && part.startsWith("0") ? Number.NaN : Number(part);
  });
  return octets.every((octet) => octet >= 0 && octet <= 255)
    ? octets
    : undefined;
}

function isLocalIpv4([a, b]: readonly number[]): boolean {
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Parses an IPv6 address (no brackets, no zone) into eight 16-bit groups. */
function parseIpv6(host: string): readonly number[] | undefined {
  if (!host.includes(":")) {
    return undefined;
  }
  let text = host;
  // An embedded IPv4 tail (`::ffff:127.0.0.1`) stands for the last two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4(tail);
    if (!octets) {
      return undefined;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, lastColon + 1)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const toGroups = (part: string): number[] | undefined => {
    if (part === "") {
      return [];
    }
    const groups = part
      .split(":")
      .map((group) =>
        /^[0-9a-f]{1,4}$/i.test(group)
          ? Number.parseInt(group, 16)
          : Number.NaN,
      );
    return groups.some(Number.isNaN) ? undefined : groups;
  };
  const head = toGroups(halves[0] ?? "");
  if (!head) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const rest = toGroups(halves[1] ?? "");
  if (!rest || head.length + rest.length > 7) {
    return undefined;
  }
  return [
    ...head,
    ...new Array(8 - head.length - rest.length).fill(0),
    ...rest,
  ];
}

function isLocalIpv6(groups: readonly number[]): boolean {
  const first = groups[0] ?? 0;
  const isLoopback =
    groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  if (isLoopback) {
    return true;
  }
  // IPv4-mapped (::ffff:a.b.c.d) is judged as the IPv4 address it carries.
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return isLocalIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (first & 0xffc0) === 0xfe80 // fe80::/10 link-local
  );
}

/**
 * Whether a host is local: loopback (127.0.0.0/8, ::1), `localhost`, a
 * private LAN address (10/8, 172.16/12, 192.168/16, IPv6 fc00::/7 and
 * fe80::/10), or a `*.local` name. Anything else is non-local. Judged only
 * from the host text; no DNS lookup happens.
 */
export function isLocalHost(host: string): boolean {
  let name = host.toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) {
    name = name.slice(1, -1);
  }
  if (name.endsWith(".")) {
    name = name.slice(0, -1);
  }
  if (name === "") {
    return false;
  }
  if (name === "localhost" || name.endsWith(".local")) {
    return true;
  }
  const ipv4 = parseIpv4(name);
  if (ipv4) {
    return isLocalIpv4(ipv4);
  }
  const ipv6 = parseIpv6(name);
  return ipv6 ? isLocalIpv6(ipv6) : false;
}

/** Whether a URL's host is local. The URL parser normalizes shorthand and encoded IPv4 forms first; a string that does not parse is not local. */
export function isLocalUrl(url: string | URL): boolean {
  try {
    return isLocalHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

// --- Parsing -------------------------------------------------------------------

function fail(path: string, message: string): ParseResult<never> {
  return { ok: false, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(
  record: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): ParseResult<never> | undefined {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return fail(
        path,
        key === "local"
          ? "locality is derived from the URL and cannot be configured"
          : `unknown key "${key}"`,
      );
    }
  }
  return undefined;
}

function parseString(value: unknown, path: string): ParseResult<string> {
  return typeof value === "string" && value.trim() !== ""
    ? { ok: true, value }
    : fail(path, "expected a non-empty string");
}

function parseIdList(
  value: unknown,
  path: string,
  known: ReadonlyMap<string, Endpoint>,
): ParseResult<readonly string[]> {
  if (!Array.isArray(value)) {
    return fail(path, "expected an array of endpoint ids");
  }
  const ids: string[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `${path}[${index}]`;
    if (typeof entry !== "string") {
      return fail(at, "expected an endpoint id");
    }
    if (!known.has(entry)) {
      return fail(at, `unknown endpoint "${entry}"`);
    }
    if (ids.includes(entry)) {
      return fail(at, `endpoint "${entry}" is listed twice`);
    }
    ids.push(entry);
  }
  return { ok: true, value: ids };
}

function parseEndpoint(value: unknown, path: string): ParseResult<Endpoint> {
  if (!isRecord(value)) {
    return fail(path, "expected an object");
  }
  const bad = unknownKey(value, ["id", "baseUrl", "model", "keyRef"], path);
  if (bad) {
    return bad;
  }
  const id = parseString(value.id, `${path}.id`);
  if (!id.ok) return id;
  const baseUrl = parseString(value.baseUrl, `${path}.baseUrl`);
  if (!baseUrl.ok) return baseUrl;
  const model = parseString(value.model, `${path}.model`);
  if (!model.ok) return model;

  let url: URL;
  try {
    url = new URL(baseUrl.value);
  } catch {
    return fail(`${path}.baseUrl`, "not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(`${path}.baseUrl`, "expected an http or https URL");
  }
  if (url.username !== "" || url.password !== "") {
    return fail(
      `${path}.baseUrl`,
      "a URL must not carry credentials; a key belongs in credential storage, referenced by keyRef",
    );
  }

  let keyRef: string | undefined;
  if (value.keyRef !== undefined) {
    const parsedRef = parseString(value.keyRef, `${path}.keyRef`);
    if (!parsedRef.ok) return parsedRef;
    keyRef = parsedRef.value;
  }
  return {
    ok: true,
    value: {
      id: id.value,
      baseUrl: url.href.replace(/\/+$/, ""),
      model: model.value,
      ...(keyRef === undefined ? {} : { keyRef }),
      local: isLocalHost(url.hostname),
    },
  };
}

/** Parses a routing configuration, or names the first path that is wrong. */
export function parseRoutingConfig(input: unknown): ParseResult<RoutingConfig> {
  if (!isRecord(input)) {
    return fail("", "expected an object");
  }
  const bad = unknownKey(input, ["endpoints", "roles", "fallback"], "");
  if (bad) {
    return bad;
  }

  if (!Array.isArray(input.endpoints) || input.endpoints.length === 0) {
    return fail("endpoints", "expected at least one endpoint");
  }
  const endpoints = new Map<string, Endpoint>();
  for (const [index, raw] of input.endpoints.entries()) {
    const endpoint = parseEndpoint(raw, `endpoints[${index}]`);
    if (!endpoint.ok) return endpoint;
    if (endpoints.has(endpoint.value.id)) {
      return fail(
        `endpoints[${index}].id`,
        `endpoint id "${endpoint.value.id}" is already used`,
      );
    }
    endpoints.set(endpoint.value.id, endpoint.value);
  }

  const roles = new Map<string, RoleAssignment>();
  if (input.roles !== undefined) {
    if (!isRecord(input.roles)) {
      return fail("roles", "expected an object");
    }
    for (const [name, raw] of Object.entries(input.roles)) {
      const path = `roles.${name}`;
      if (!isRecord(raw)) {
        return fail(path, "expected an object");
      }
      const badRole = unknownKey(raw, ["endpoint", "model", "fallback"], path);
      if (badRole) {
        return badRole;
      }
      const endpoint = parseString(raw.endpoint, `${path}.endpoint`);
      if (!endpoint.ok) return endpoint;
      if (!endpoints.has(endpoint.value)) {
        return fail(`${path}.endpoint`, `unknown endpoint "${endpoint.value}"`);
      }
      let model: string | undefined;
      if (raw.model !== undefined) {
        const parsedModel = parseString(raw.model, `${path}.model`);
        if (!parsedModel.ok) return parsedModel;
        model = parsedModel.value;
      }
      let fallback: readonly string[] | undefined;
      if (raw.fallback !== undefined) {
        const parsedFallback = parseIdList(
          raw.fallback,
          `${path}.fallback`,
          endpoints,
        );
        if (!parsedFallback.ok) return parsedFallback;
        fallback = parsedFallback.value;
      }
      roles.set(name, {
        endpoint: endpoint.value,
        ...(model === undefined ? {} : { model }),
        ...(fallback === undefined ? {} : { fallback }),
      });
    }
  }

  let fallback: readonly string[] = [];
  if (input.fallback !== undefined) {
    const parsedFallback = parseIdList(input.fallback, "fallback", endpoints);
    if (!parsedFallback.ok) return parsedFallback;
    fallback = parsedFallback.value;
  }

  return { ok: true, value: { endpoints, roles, fallback } };
}

// --- Route planning ------------------------------------------------------------

export interface RouteStep {
  readonly endpoint: Endpoint;
  readonly model: string;
}

export interface RoutePlan {
  /** In the order the router tries them. */
  readonly steps: readonly RouteStep[];
  /** Endpoint ids offline mode removed, so a caller can tell "nothing local is configured" from an outage. */
  readonly offlineSkipped: readonly string[];
}

/**
 * The ordered steps for `role`: its assigned endpoint (with the role's model
 * override), then its own fallback list or else the global one, with no
 * endpoint repeated. A role with no assignment uses the global list alone.
 * Offline mode removes non-local endpoints here, before anything is built.
 */
export function planRoute(
  config: RoutingConfig,
  role: string,
  mode: { readonly offline: boolean },
): RoutePlan {
  const assignment = config.roles.get(role);
  const ordered: RouteStep[] = [];
  const seen = new Set<string>();
  const add = (id: string, model?: string): void => {
    const endpoint = config.endpoints.get(id);
    if (endpoint && !seen.has(id)) {
      seen.add(id);
      ordered.push({ endpoint, model: model ?? endpoint.model });
    }
  };
  if (assignment) {
    add(assignment.endpoint, assignment.model);
  }
  for (const id of assignment?.fallback ?? config.fallback) {
    add(id);
  }

  if (!mode.offline) {
    return { steps: ordered, offlineSkipped: [] };
  }
  return {
    steps: ordered.filter((step) => step.endpoint.local),
    offlineSkipped: ordered
      .filter((step) => !step.endpoint.local)
      .map((step) => step.endpoint.id),
  };
}
