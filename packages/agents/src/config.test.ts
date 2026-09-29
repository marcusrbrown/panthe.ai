import { describe, expect, test } from "bun:test";
import {
  type Endpoint,
  isLocalHost,
  isLocalUrl,
  parseRoutingConfig,
  planRoute,
  type RoutingConfig,
} from "./config";

describe("isLocalHost", () => {
  test.each([
    ["127.0.0.1"],
    ["127.255.255.254"],
    ["localhost"],
    ["LOCALHOST"],
    ["[::1]"],
    ["::1"],
    ["10.0.0.1"],
    ["10.255.255.255"],
    ["172.16.0.1"],
    ["172.31.255.255"],
    ["192.168.0.1"],
    ["192.168.255.255"],
    ["fc00::1"],
    ["fd12:3456:789a::1"],
    ["[fdff::1]"],
    ["fe80::1"],
    ["[febf::1]"],
    ["studio.local"],
    ["a.b.studio.local"],
    ["studio.local."],
    ["::ffff:127.0.0.1"],
    ["::ffff:192.168.1.5"],
  ])("%s is local", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  test.each([
    ["example.com"],
    ["api.opencode.ai"],
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["172.15.0.1"],
    ["172.32.0.1"],
    ["192.167.0.1"],
    ["11.0.0.1"],
    ["100.64.0.1"],
    ["169.254.1.1"],
    ["128.0.0.1"],
    ["2001:4860:4860::8888"],
    ["fe00::1"],
    ["fec0::1"],
    ["fbff::1"],
    ["::ffff:8.8.8.8"],
    ["localhost.example.com"],
    ["127.0.0.1.example.com"],
    ["notlocal"],
    ["local"],
    ["studio.local.example.com"],
    ["foo.localhost"],
    [""],
  ])("%s is not local", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });
});

describe("isLocalUrl", () => {
  test("judges the host the URL parser resolves, not what the text looks like", () => {
    // Shorthand and encoded IPv4 forms normalize to the loopback address.
    expect(isLocalUrl("http://127.1:11434/v1")).toBe(true);
    expect(isLocalUrl("http://0x7f.0.0.1/v1")).toBe(true);
    expect(isLocalUrl("http://[::1]:11434/v1")).toBe(true);
    // A loopback lookalike in the userinfo or a subdomain is a public host.
    expect(isLocalUrl("http://127.0.0.1@example.com/v1")).toBe(false);
    expect(isLocalUrl("http://localhost.example.com/v1")).toBe(false);
    expect(isLocalUrl("https://api.example.com/v1")).toBe(false);
    expect(isLocalUrl("https://8.8.8.8/v1")).toBe(false);
  });

  test("a string that is not a URL is not local", () => {
    expect(isLocalUrl("not a url")).toBe(false);
  });
});

const ollama = {
  id: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "llama3.2-3b-4k",
};
const go = {
  id: "go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  model: "some-go-model",
  keyRef: "opencode-go",
};

function config(overrides: Record<string, unknown> = {}): unknown {
  return {
    endpoints: [ollama, go],
    roles: { zeus: { endpoint: "ollama" } },
    fallback: ["ollama", "go"],
    ...overrides,
  };
}

function parsed(input: unknown): RoutingConfig {
  const result = parseRoutingConfig(input);
  if (!result.ok) {
    throw new Error(`${result.path}: ${result.message}`);
  }
  return result.value;
}

describe("parseRoutingConfig", () => {
  test("an endpoint carries no locality field: locality is judged from its URL where it is used", () => {
    const value = parsed(config());

    for (const endpoint of value.endpoints.values()) {
      expect(endpoint).not.toHaveProperty("local");
    }
    expect(
      [...value.endpoints.values()].map((e) => [e.id, isLocalUrl(e.baseUrl)]),
    ).toEqual([
      ["ollama", true],
      ["go", false],
    ]);
  });

  test("keeps the key reference and drops nothing the router needs", () => {
    const value = parsed(config());

    expect(value.endpoints.get("go")).toMatchObject({
      id: "go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "some-go-model",
      keyRef: "opencode-go",
    });
    expect(value.endpoints.get("ollama")?.keyRef).toBeUndefined();
  });

  test("locality is never configurable: a config that claims it is refused, so a public host cannot be declared local", () => {
    const result = parseRoutingConfig(
      config({ endpoints: [{ ...go, local: true }] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe("endpoints[0].local");
      expect(result.message).toContain("derived from the URL");
    }
  });

  test("an unknown key anywhere is an error, so a typo cannot silently do nothing", () => {
    const result = parseRoutingConfig(config({ fallbak: ["ollama"] }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe("fallbak");
    }
  });

  test.each([
    [
      "a role naming an unknown endpoint",
      { roles: { zeus: { endpoint: "nope" } } },
      "roles.zeus.endpoint",
    ],
    [
      "a global fallback naming an unknown endpoint",
      { fallback: ["ollama", "nope"] },
      "fallback[1]",
    ],
    [
      "a role fallback naming an unknown endpoint",
      { roles: { zeus: { endpoint: "ollama", fallback: ["nope"] } } },
      "roles.zeus.fallback[0]",
    ],
    [
      "a malformed URL",
      { endpoints: [{ ...ollama, baseUrl: "not a url" }] },
      "endpoints[0].baseUrl",
    ],
    [
      "a non-http scheme",
      { endpoints: [{ ...ollama, baseUrl: "file:///etc/passwd" }] },
      "endpoints[0].baseUrl",
    ],
    [
      "credentials embedded in the URL",
      { endpoints: [{ ...go, baseUrl: "https://user:secret@opencode.ai/v1" }] },
      "endpoints[0].baseUrl",
    ],
    [
      "a secret in the URL's query string",
      {
        endpoints: [
          {
            ...go,
            baseUrl: "https://api.example.com/v1?api_key=sk-example-secret",
          },
        ],
      },
      "endpoints[0].baseUrl",
    ],
    [
      "an empty query string",
      { endpoints: [{ ...go, baseUrl: "https://api.example.com/v1?" }] },
      "endpoints[0].baseUrl",
    ],
    [
      "a fragment",
      { endpoints: [{ ...go, baseUrl: "https://api.example.com/v1#frag" }] },
      "endpoints[0].baseUrl",
    ],
    [
      "a missing model",
      { endpoints: [{ id: "ollama", baseUrl: ollama.baseUrl }] },
      "endpoints[0].model",
    ],
    [
      "an empty endpoint id",
      { endpoints: [{ ...ollama, id: "" }] },
      "endpoints[0].id",
    ],
    [
      "a duplicate endpoint id",
      { endpoints: [ollama, { ...go, id: "ollama" }] },
      "endpoints[1].id",
    ],
    [
      "a non-string key reference",
      { endpoints: [{ ...go, keyRef: 5 }] },
      "endpoints[0].keyRef",
    ],
    ["no endpoints", { endpoints: [] }, "endpoints"],
    [
      "a duplicate id in a fallback list",
      { fallback: ["ollama", "ollama"] },
      "fallback[1]",
    ],
  ])("rejects %s, naming where", (_label, overrides, path) => {
    const result = parseRoutingConfig(config(overrides));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe(path);
    }
  });

  test("a query-string rejection says where a key belongs and does not echo the secret", () => {
    const result = parseRoutingConfig(
      config({
        endpoints: [
          {
            ...go,
            baseUrl: "https://api.example.com/v1?api_key=sk-example-secret",
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("keyRef");
      expect(result.message).not.toContain("sk-example-secret");
    }
  });

  test("a plain base URL is still accepted, with or without a trailing slash, and the trailing slash is dropped", () => {
    const value = parsed(
      config({
        endpoints: [
          { ...go, id: "slash", baseUrl: "https://api.example.com/v1/" },
          { ...go, id: "plain", baseUrl: "https://api.example.com/v1" },
        ],
        roles: {},
        fallback: [],
      }),
    );

    expect(value.endpoints.get("slash")?.baseUrl).toBe(
      "https://api.example.com/v1",
    );
    expect(value.endpoints.get("plain")?.baseUrl).toBe(
      "https://api.example.com/v1",
    );
  });

  test("rejects input that is not an object", () => {
    expect(parseRoutingConfig(null).ok).toBe(false);
    expect(parseRoutingConfig("endpoints").ok).toBe(false);
  });

  test("roles and fallback are optional", () => {
    const value = parsed({ endpoints: [ollama] });

    expect(value.roles.size).toBe(0);
    expect(value.fallback).toEqual([]);
  });
});

describe("planRoute", () => {
  const value = parsed(
    config({
      endpoints: [
        ollama,
        go,
        {
          id: "lan",
          baseUrl: "http://192.168.1.20:11434/v1",
          model: "llama3.1",
        },
      ],
      roles: {
        zeus: { endpoint: "go", model: "override-model" },
        hera: { endpoint: "ollama", fallback: ["lan"] },
      },
      fallback: ["ollama", "go", "lan"],
    }),
  );

  test("tries the role's endpoint first, then the global fallback list, without repeating an endpoint", () => {
    const plan = planRoute(value, "zeus", { offline: false });

    expect(plan.steps.map((step) => step.endpoint.id)).toEqual([
      "go",
      "ollama",
      "lan",
    ]);
  });

  test("a role's model override applies only to its own endpoint; a fallback endpoint uses its own model", () => {
    const plan = planRoute(value, "zeus", { offline: false });

    expect(plan.steps.map((step) => step.model)).toEqual([
      "override-model",
      "llama3.2-3b-4k",
      "llama3.1",
    ]);
  });

  test("a role's own fallback list replaces the global one", () => {
    const plan = planRoute(value, "hera", { offline: false });

    expect(plan.steps.map((step) => step.endpoint.id)).toEqual([
      "ollama",
      "lan",
    ]);
  });

  test("a role with no assignment uses the global fallback list", () => {
    const plan = planRoute(value, "hermes", { offline: false });

    expect(plan.steps.map((step) => step.endpoint.id)).toEqual([
      "ollama",
      "go",
      "lan",
    ]);
  });

  test("offline mode removes non-local endpoints, including the role's own, and reports them", () => {
    const plan = planRoute(value, "zeus", { offline: true });

    expect(plan.steps.map((step) => step.endpoint.id)).toEqual([
      "ollama",
      "lan",
    ]);
    expect(plan.offlineSkipped).toEqual(["go"]);
  });

  test("offline mode over a list with nothing local leaves no steps", () => {
    const remoteOnly = parsed({
      endpoints: [go],
      roles: { zeus: { endpoint: "go" } },
    });

    const plan = planRoute(remoteOnly, "zeus", { offline: true });

    expect(plan.steps).toEqual([]);
    expect(plan.offlineSkipped).toEqual(["go"]);
  });

  test("a hand-built config is judged by its URLs too: a public baseUrl is dropped offline whatever else the object claims", () => {
    const forged: RoutingConfig = {
      endpoints: new Map([
        [
          "public",
          // A caller that skips the parser tries to declare a public host local.
          {
            id: "public",
            baseUrl: "https://api.example.com/v1",
            model: "m",
            local: true,
          } as unknown as Endpoint,
        ],
        [
          "loopback",
          { id: "loopback", baseUrl: "http://127.0.0.1:11434/v1", model: "m" },
        ],
      ]),
      roles: new Map([["zeus", { endpoint: "public" }]]),
      fallback: ["loopback"],
    };

    const plan = planRoute(forged, "zeus", { offline: true });

    expect(plan.steps.map((step) => step.endpoint.id)).toEqual(["loopback"]);
    expect(plan.offlineSkipped).toEqual(["public"]);
  });

  test("online, nothing is skipped", () => {
    expect(planRoute(value, "zeus", { offline: false }).offlineSkipped).toEqual(
      [],
    );
  });
});
