import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ModelSettingsTransport } from "../connection";
import {
  persistModelSettings,
  SettingsView,
  saveEndpointKey,
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
  roles: { Zeus: { endpoint: "local", fallback: ["hosted"] } },
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
