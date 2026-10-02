import { expect, test } from "bun:test";
import { parseRoutingConfig, planRoute } from "@panthea/agents/config";
import { renderToStaticMarkup } from "react-dom/server";

import type { ModelSettingsTransport } from "../connection";
import {
  deleteEndpointKey,
  formToSettings,
  persistModelSettings,
  SettingsView,
  saveEndpointKey,
  settingsToForm,
  updateRoleField,
  validateSettings,
} from "./settings";

const models = {
  endpoints: [
    {
      id: "local",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
      keyRef: "local-key",
    },
    {
      id: "hosted",
      baseUrl: "https://api.example.test/v1",
      model: "reasoner",
    },
  ],
  roles: { zeus: { endpoint: "local", fallback: ["hosted"] } },
  fallback: ["hosted"],
};

function fakeTransport(overrides: Partial<ModelSettingsTransport> = {}) {
  const calls: { method: string; value?: unknown }[] = [];
  const transport: ModelSettingsTransport = {
    async readModelSettings() {
      calls.push({ method: "read" });
      return null;
    },
    async saveModelSettings(settings) {
      calls.push({ method: "save", value: settings });
    },
    async setEndpointKey(keyRef, key) {
      calls.push({ method: "set-key", value: { keyRef, key } });
    },
    async deleteEndpointKey(keyRef) {
      calls.push({ method: "delete-key", value: keyRef });
    },
    async endpointKeyStatus(keyRefs) {
      calls.push({ method: "key-status", value: keyRefs });
      return Object.fromEntries(keyRefs.map((keyRef) => [keyRef, "set"]));
    },
    ...overrides,
  };
  return { calls, transport };
}

test("saving a valid settings form sends the normalized settings shape", async () => {
  const fake = fakeTransport();
  const result = await persistModelSettings(
    { models, offline: false },
    fake.transport,
  );

  expect(result).toEqual({ ok: true });
  expect(fake.calls).toEqual([
    {
      method: "save",
      value: JSON.stringify({
        models: {
          ...models,
          endpoints: [
            { ...models.endpoints[0], baseUrl: "http://localhost:11434/v1" },
            { ...models.endpoints[1], baseUrl: "https://api.example.test/v1" },
          ],
        },
        offline: false,
      }),
    },
  ]);
});

test("invalid URLs and URL credentials stop save with field messages", async () => {
  const fake = fakeTransport();
  const invalid = {
    ...models,
    endpoints: [{ ...models.endpoints[0], baseUrl: "not a URL" }],
    roles: {},
    fallback: [],
  };
  const invalidUrl = validateSettings({ models: invalid, offline: false });
  expect(invalidUrl.ok).toBe(false);
  if (!invalidUrl.ok)
    expect(invalidUrl.errors["endpoints.0.baseUrl"]).toBeTruthy();
  await persistModelSettings(
    { models: invalid, offline: false },
    fake.transport,
  );

  const credentials = {
    ...invalid,
    endpoints: [
      {
        ...models.endpoints[0],
        baseUrl: "https://name:secret@example.test/v1",
      },
    ],
  };
  const credentialUrl = validateSettings({
    models: credentials,
    offline: false,
  });
  expect(credentialUrl.ok).toBe(false);
  if (!credentialUrl.ok)
    expect(credentialUrl.errors["endpoints.0.baseUrl"]).toContain(
      "credentials",
    );
  expect(fake.calls).toEqual([]);
});

test("a key is write-only and its status becomes set after saving", async () => {
  const fake = fakeTransport();
  const savedStatus = await saveEndpointKey(
    "local-key",
    "sentinel-not-a-real-key",
    fake.transport,
  );
  const html = renderToStaticMarkup(
    <SettingsView
      transport={fake.transport}
      initialSettings={{ models, offline: false }}
      initialKeyStatus={{ "local-key": "set" }}
    />,
  );

  expect(html).not.toContain("sentinel-not-a-real-key");
  expect(html).toContain('type="password"');
  expect(html).toContain("<strong>Set</strong>");
  expect(savedStatus).toEqual({ "local-key": "set" });
  expect(fake.calls[0]).toEqual({
    method: "set-key",
    value: { keyRef: "local-key", key: "sentinel-not-a-real-key" },
  });
  expect(fake.calls[1]).toEqual({ method: "key-status", value: ["local-key"] });
});

test("endpoint status uses words as well as visual state", () => {
  const html = renderToStaticMarkup(
    <SettingsView
      transport={fakeTransport().transport}
      initialSettings={{ models, offline: false }}
      endpointStatuses={[
        { endpoint: "local", state: "ok" },
        {
          endpoint: "hosted",
          state: "failed",
          reason: "unreachable",
          detail: "Timed out",
        },
      ]}
    />,
  );
  expect(html).toContain("Reachable");
  expect(html).toContain("Failed");
  expect(html).toContain("Timed out");
});

test("offline mode names hosted endpoints that will be dropped", () => {
  const html = renderToStaticMarkup(
    <SettingsView
      transport={fakeTransport().transport}
      initialSettings={{ models, offline: true }}
    />,
  );

  expect(html).toContain("Offline mode");
  expect(html).toContain("hosted");
  expect(html).toContain("Dropped while offline");
});

test("Keychain failures are shown without hiding the command error", async () => {
  const fake = fakeTransport({
    async setEndpointKey() {
      throw new Error("Keychain access was denied");
    },
  });

  await expect(
    saveEndpointKey("local-key", "sentinel-not-a-real-key", fake.transport),
  ).rejects.toThrow("Keychain access was denied");
  const html = renderToStaticMarkup(
    <SettingsView
      transport={fake.transport}
      initialSettings={{ models, offline: false }}
      initialError="Keychain access was denied"
    />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("Keychain access was denied");
});

// --- Roles are saved under the id the router looks up ----------------------------------------

const localEndpoint = {
  uiKey: "local",
  id: "local",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "llama",
  keyRef: "",
};

test("a Zeus assignment made in the form is saved as roles.zeus and routes to the assigned endpoint", async () => {
  const fake = fakeTransport();
  // The form the operator starts from, one endpoint added, Zeus assigned to it.
  let form = settingsToForm(undefined);
  form = { ...form, endpoints: [localEndpoint] };
  form = updateRoleField(form, "zeus", { endpoint: "local" });

  const result = await persistModelSettings(
    formToSettings(form),
    fake.transport,
  );

  expect(result).toEqual({ ok: true });
  const saved = JSON.parse(String(fake.calls[0]?.value)) as {
    models: { roles: Record<string, unknown> };
  };
  expect(Object.keys(saved.models.roles)).toEqual(["zeus"]);
  const config = parseRoutingConfig(saved.models);
  if (!config.ok) throw new Error(`${config.path}: ${config.message}`);
  // The router looks a role up by the lowercase actor id.
  expect(
    planRoute(config.value, "zeus", { offline: false }).steps.map(
      (step) => step.endpoint.id,
    ),
  ).toEqual(["local"]);
  expect(planRoute(config.value, "hera", { offline: false }).steps).toEqual([]);
});

test("Hera is a row of her own, and the rows show names while the settings hold ids", () => {
  let form = settingsToForm(undefined);
  expect(Object.keys(form.roles)).toEqual(["zeus", "hera"]);
  form = { ...form, endpoints: [localEndpoint] };
  form = updateRoleField(form, "hera", { endpoint: "local", model: "other" });
  expect(Object.keys(formToSettings(form).models.roles)).toEqual(["hera"]);

  const html = renderToStaticMarkup(
    <SettingsView
      transport={fakeTransport().transport}
      initialSettings={{ models, offline: false }}
    />,
  );
  expect(html).toContain("<legend>Zeus</legend>");
  expect(html).toContain("<legend>Hera</legend>");
});

test("settings loaded keyed by id fill the matching rows and add no duplicate row", () => {
  const form = settingsToForm({
    models: {
      ...models,
      roles: { zeus: { endpoint: "local", model: "x", fallback: ["hosted"] } },
    },
    offline: false,
  });
  expect(Object.keys(form.roles)).toEqual(["zeus", "hera"]);
  expect(form.roles.zeus).toEqual({
    endpoint: "local",
    model: "x",
    fallback: "hosted",
    inheritFallback: false,
  });
  expect(form.roles.hera?.endpoint).toBe("");
  // And back: a round trip keeps the id.
  expect(Object.keys(formToSettings(form).models.roles)).toEqual(["zeus"]);
});

// --- A role's own empty fallback is not the same as inheriting the global one ----------------

/** Loads `roleFallback` onto Zeus (global fallback `hosted`), saves, and returns the saved role and Zeus's route. */
async function roundTripZeus(roleFallback: readonly string[] | undefined) {
  const fake = fakeTransport();
  const form = settingsToForm({
    models: {
      ...models,
      roles: {
        zeus: {
          endpoint: "local",
          ...(roleFallback === undefined ? {} : { fallback: roleFallback }),
        },
      },
      fallback: ["hosted"],
    },
    offline: false,
  });
  const result = await persistModelSettings(
    formToSettings(form),
    fake.transport,
  );
  expect(result).toEqual({ ok: true });
  const saved = JSON.parse(String(fake.calls[0]?.value)) as {
    models: { roles: Record<string, { fallback?: string[] }> };
  };
  const config = parseRoutingConfig(saved.models);
  if (!config.ok) throw new Error(`${config.path}: ${config.message}`);
  return {
    role: saved.models.roles.zeus,
    route: planRoute(config.value, "zeus", { offline: false }).steps.map(
      (step) => step.endpoint.id,
    ),
  };
}

test("a role's explicit empty fallback survives a load and save, so a local outage never reaches the hosted global fallback", async () => {
  const { role, route } = await roundTripZeus([]);
  expect(role?.fallback).toEqual([]);
  expect(route).toEqual(["local"]);
});

test("a role with no fallback of its own still inherits the global one after a load and save", async () => {
  const { role, route } = await roundTripZeus(undefined);
  expect(role).not.toHaveProperty("fallback");
  expect(route).toEqual(["local", "hosted"]);
});

test("each role row offers a Use the global fallback checkbox, checked only while the role has no fallback of its own", () => {
  const html = renderToStaticMarkup(
    <SettingsView
      transport={fakeTransport().transport}
      initialSettings={{
        models: {
          ...models,
          roles: { zeus: { endpoint: "local", fallback: [] } },
        },
        offline: false,
      }}
    />,
  );
  const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
  // Zeus has an explicit (empty) list; Hera has no assignment and so inherits. The offline toggle is the third.
  expect(html.match(/Use the global fallback/g)).toHaveLength(2);
  expect(boxes).toHaveLength(3);
  expect(boxes[0]).not.toContain("checked");
  expect(boxes[1]).toContain("checked");
});

// --- A key reference is trimmed once, for the settings and every key operation ----------

test("a key reference with spaces is stored, deleted, and checked under the trimmed name that the settings hold", async () => {
  const fake = fakeTransport();
  const status = await saveEndpointKey(
    " openai ",
    "not-a-real-key",
    fake.transport,
  );
  await deleteEndpointKey(" openai ", fake.transport);

  expect(fake.calls).toEqual([
    { method: "set-key", value: { keyRef: "openai", key: "not-a-real-key" } },
    { method: "key-status", value: ["openai"] },
    { method: "delete-key", value: "openai" },
    { method: "key-status", value: ["openai"] },
  ]);
  expect(status).toEqual({ openai: "set" });

  const form = settingsToForm(undefined);
  const settings = formToSettings({
    ...form,
    endpoints: [{ ...localEndpoint, keyRef: " openai " }],
  });
  expect(settings.models.endpoints[0]?.keyRef).toBe("openai");
});

test("the row looks its key status up by the trimmed reference, so a padded reference shows the status of the stored key", () => {
  const html = renderToStaticMarkup(
    <SettingsView
      transport={fakeTransport().transport}
      initialSettings={{
        models: {
          ...models,
          endpoints: [{ ...models.endpoints[0], keyRef: " openai " }],
        },
        offline: false,
      }}
      initialKeyStatus={{ openai: "set" }}
    />,
  );
  expect(html).toContain("<strong>Set</strong>");
  expect(html).toContain("Remove key");
});
