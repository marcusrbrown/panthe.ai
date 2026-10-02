import type { Endpoint } from "@panthea/agents/config";
import { isLocalUrl, parseRoutingConfig } from "@panthea/agents/config";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import type { ModelSettingsTransport } from "../connection";
import "./settings.css";

type EndpointState = "untried" | "ok" | "failed";
type KeyStatus = "set" | "missing";

interface SettingsShape {
  readonly models: {
    readonly endpoints: readonly Endpoint[];
    readonly roles: Readonly<Record<string, RoleForm>>;
    readonly fallback: readonly string[];
  };
  readonly offline: boolean;
}

interface RoleForm {
  readonly endpoint: string;
  readonly model?: string;
  readonly fallback?: readonly string[];
}

interface EndpointForm {
  readonly uiKey: string;
  readonly id: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly keyRef: string;
  readonly reasoningEffort?: "none";
}

/** `inheritFallback` is the role having no fallback of its own (it uses the global one); unchecked, `fallback` is the role's own list, which may be empty (no fallback at all). */
interface RoleFormFields {
  endpoint: string;
  model: string;
  fallback: string;
  inheritFallback: boolean;
}

interface MutableSettings {
  endpoints: EndpointForm[];
  roles: Record<string, RoleFormFields>;
  fallback: string;
  offline: boolean;
}

export interface EndpointFrameStatus {
  readonly endpoint: string;
  readonly state: EndpointState;
  readonly reason?: string;
  readonly detail?: string;
}

type Validation =
  | { readonly ok: true; readonly value: SettingsShape }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** The gods an operator can assign. The id is the role key the router looks up (the lowercase actor id) and the only form ever saved; the label is for display. */
const ROLES = [
  { id: "zeus", label: "Zeus" },
  { id: "hera", label: "Hera" },
] as const;

function roleLabel(id: string): string {
  return ROLES.find((role) => role.id === id)?.label ?? id;
}

function emptyRole(): RoleFormFields {
  return { endpoint: "", model: "", fallback: "", inheritFallback: true };
}

function roleToForm(assignment: RoleForm): RoleFormFields {
  return {
    endpoint: assignment.endpoint,
    model: assignment.model ?? "",
    fallback: assignment.fallback?.join(", ") ?? "",
    inheritFallback: assignment.fallback === undefined,
  };
}

function emptyForm(): MutableSettings {
  return {
    endpoints: [],
    roles: Object.fromEntries(ROLES.map((role) => [role.id, emptyRole()])),
    fallback: "",
    offline: false,
  };
}

/** The form for saved settings (or an empty one): each saved role lands on the row of its id. */
export function settingsToForm(
  value: SettingsShape | undefined,
): MutableSettings {
  if (!value) return emptyForm();
  const roles = Object.fromEntries(
    ROLES.map(({ id }) => {
      const assignment = value.models.roles[id];
      return [id, assignment ? roleToForm(assignment) : emptyRole()];
    }),
  );
  for (const [name, assignment] of Object.entries(value.models.roles)) {
    if (!(name in roles)) roles[name] = roleToForm(assignment);
  }
  return {
    endpoints: value.models.endpoints.map((endpoint) => ({
      id: endpoint.id,
      uiKey: endpoint.id,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      keyRef: endpoint.keyRef ?? "",
      ...(endpoint.reasoningEffort
        ? { reasoningEffort: endpoint.reasoningEffort }
        : {}),
    })),
    roles,
    fallback: value.models.fallback.join(", "),
    offline: value.offline,
  };
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** The settings a form saves: roles keyed by id, a key reference trimmed. */
export function formToSettings(form: MutableSettings): SettingsShape {
  const endpoints = form.endpoints.map((endpoint) => ({
    id: endpoint.id,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    ...(normalizeKeyRef(endpoint.keyRef)
      ? { keyRef: normalizeKeyRef(endpoint.keyRef) }
      : {}),
    ...(endpoint.reasoningEffort
      ? { reasoningEffort: endpoint.reasoningEffort }
      : {}),
  }));
  const roles = Object.fromEntries(
    Object.entries(form.roles)
      .filter(([, role]) => role.endpoint.trim())
      .map(([name, role]) => [
        name,
        {
          endpoint: role.endpoint,
          ...(role.model.trim() ? { model: role.model.trim() } : {}),
          ...(role.inheritFallback ? {} : { fallback: list(role.fallback) }),
        },
      ]),
  );
  return {
    models: {
      endpoints,
      roles,
      fallback: list(form.fallback),
    },
    offline: form.offline,
  };
}

export function validateSettings(value: unknown): Validation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: { form: "Enter valid model settings." } };
  }
  const settings = value as { models?: unknown; offline?: unknown };
  if (typeof settings.offline !== "boolean") {
    return {
      ok: false,
      errors: { offline: "Choose whether offline mode is on." },
    };
  }
  const parsed = parseRoutingConfig(settings.models);
  if (!parsed.ok) {
    const match = /^endpoints\[(\d+)\]\.([^.]+)$/.exec(parsed.path);
    const role = /^roles\.([^.]+)\.([^.]+)$/.exec(parsed.path);
    const fallback = /^(roles\.[^.]+\.fallback|fallback)\[(\d+)\]$/.exec(
      parsed.path,
    );
    const path = match
      ? `endpoints.${match[1]}.${match[2]}`
      : role
        ? `roles.${role[1]}.${role[2]}`
        : fallback
          ? (fallback[1] ?? "form")
          : "form";
    return { ok: false, errors: { [path]: parsed.message } };
  }
  return {
    ok: true,
    value: {
      models: {
        endpoints: [...parsed.value.endpoints.values()],
        roles: Object.fromEntries(parsed.value.roles),
        fallback: parsed.value.fallback,
      },
      offline: settings.offline,
    },
  };
}

export async function persistModelSettings(
  settings: unknown,
  transport: ModelSettingsTransport,
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> }
> {
  const validated = validateSettings(settings);
  if (!validated.ok) return validated;
  await transport.saveModelSettings(JSON.stringify(validated.value));
  return { ok: true };
}

/** Sets one role field, leaving every other row as it was. */
export function updateRoleField(
  form: MutableSettings,
  roleId: string,
  patch: Partial<MutableSettings["roles"][string]>,
): MutableSettings {
  const role = form.roles[roleId] ?? emptyRole();
  return { ...form, roles: { ...form.roles, [roleId]: { ...role, ...patch } } };
}

/** A key reference is trimmed once, here: the settings, every key operation, and every lookup use this name. */
export function normalizeKeyRef(keyRef: string): string {
  return keyRef.trim();
}

export async function saveEndpointKey(
  keyRef: string,
  key: string,
  transport: ModelSettingsTransport,
): Promise<Record<string, KeyStatus>> {
  const name = normalizeKeyRef(keyRef);
  await transport.setEndpointKey(name, key);
  return transport.endpointKeyStatus([name]);
}

export async function deleteEndpointKey(
  keyRef: string,
  transport: ModelSettingsTransport,
): Promise<Record<string, KeyStatus>> {
  const name = normalizeKeyRef(keyRef);
  await transport.deleteEndpointKey(name);
  return transport.endpointKeyStatus([name]);
}

function parseStoredSettings(
  serialized: string | null,
): SettingsShape | undefined {
  if (serialized === null) return undefined;
  const parsed: unknown = JSON.parse(serialized);
  const validation = validateSettings(parsed);
  if (!validation.ok) throw new Error("Saved model settings are invalid.");
  return validation.value;
}

export function SettingsView({
  transport,
  onBack,
  initialSettings,
  initialKeyStatus = {},
  initialError = "",
  endpointStatuses = [],
}: {
  readonly transport: ModelSettingsTransport;
  readonly onBack?: () => void;
  readonly initialSettings?: SettingsShape;
  readonly initialKeyStatus?: Readonly<Record<string, KeyStatus>>;
  readonly initialError?: string;
  readonly endpointStatuses?: readonly EndpointFrameStatus[];
}) {
  const [form, setForm] = useState(() => settingsToForm(initialSettings));
  const [keyStatus, setKeyStatus] = useState<Record<string, KeyStatus>>({
    ...initialKeyStatus,
  });
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(initialError);
  const [isError, setIsError] = useState(Boolean(initialError));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (initialSettings) return;
    let current = true;
    void transport
      .readModelSettings()
      .then((serialized) => {
        if (!current) return;
        const settings = parseStoredSettings(serialized);
        setForm(settingsToForm(settings));
      })
      .catch((error: unknown) => {
        if (current)
          setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      current = false;
    };
  }, [initialSettings, transport]);

  const keyRefs = useMemo(
    () => [
      ...new Set(
        form.endpoints
          .map((endpoint) => normalizeKeyRef(endpoint.keyRef))
          .filter(Boolean),
      ),
    ],
    [form.endpoints],
  );
  useEffect(() => {
    if (!keyRefs.length) return;
    let current = true;
    void transport
      .endpointKeyStatus(keyRefs)
      .then((statuses) => {
        if (current) setKeyStatus((prior) => ({ ...prior, ...statuses }));
      })
      .catch((error: unknown) => {
        if (current) {
          setMessage(error instanceof Error ? error.message : String(error));
          setIsError(true);
        }
      });
    return () => {
      current = false;
    };
  }, [keyRefs, transport]);

  const roles = [
    ...new Set([...ROLES.map((role) => role.id), ...Object.keys(form.roles)]),
  ];
  const normalized = formToSettings(form);
  const parsedForOffline = validateSettings(normalized);
  const dropped =
    parsedForOffline.ok && form.offline
      ? parsedForOffline.value.models.endpoints.filter(
          (endpoint) => !isLocalUrl(endpoint.baseUrl),
        )
      : [];
  const statusByEndpoint = new Map(
    endpointStatuses.map((status) => [status.endpoint, status]),
  );

  function updateEndpoint(
    index: number,
    field: keyof EndpointForm,
    value: string,
  ) {
    setForm((prior) => ({
      ...prior,
      endpoints: prior.endpoints.map((endpoint, at) =>
        at === index ? { ...endpoint, [field]: value } : endpoint,
      ),
    }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateSettings(formToSettings(form));
    if (!result.ok) {
      setErrors(result.errors);
      setMessage("Fix the marked fields before saving.");
      setIsError(true);
      return;
    }
    setErrors({});
    setBusy(true);
    setIsError(false);
    setMessage("Saving. The world service will restart.");
    try {
      await transport.saveModelSettings(JSON.stringify(result.value));
      setMessage("Settings saved. The world service is restarting.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function storeKey(keyRef: string) {
    const value = keyInputs[keyRef] ?? "";
    if (!value) {
      setMessage("Enter a key first.");
      return;
    }
    setBusy(true);
    setIsError(false);
    setMessage("Saving key. The world service will restart.");
    try {
      const status = await saveEndpointKey(keyRef, value, transport);
      setKeyStatus((prior) => ({ ...prior, ...status }));
      setKeyInputs((prior) => ({ ...prior, [keyRef]: "" }));
      setMessage("Key saved. The world service is restarting.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function removeKey(keyRef: string) {
    setBusy(true);
    setIsError(false);
    setMessage("Removing key. The world service will restart.");
    try {
      const status = await deleteEndpointKey(keyRef, transport);
      setKeyStatus((prior) => ({ ...prior, ...status }));
      setMessage("Key removed. The world service is restarting.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <header className="settings-header">
        <button className="settings-back" type="button" onClick={onBack}>
          ← <span>World</span>
        </button>
        <div>
          <p className="eyebrow">Panthea / configuration</p>
          <h1 id="settings-title">Model settings</h1>
        </div>
        <p className="settings-note">Saving restarts the world service.</p>
      </header>

      <form
        className="settings-form"
        onSubmit={(event) => void save(event)}
        noValidate
      >
        <div className="settings-columns">
          <div className="settings-main-column">
            <section
              className="settings-section"
              aria-labelledby="endpoints-title"
            >
              <div className="settings-section-heading">
                <div>
                  <p className="eyebrow">Connections</p>
                  <h2 id="endpoints-title">Endpoints</h2>
                </div>
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() =>
                    setForm((prior) => ({
                      ...prior,
                      endpoints: [
                        ...prior.endpoints,
                        {
                          uiKey: crypto.randomUUID(),
                          id: "",
                          baseUrl: "",
                          model: "",
                          keyRef: "",
                        },
                      ],
                    }))
                  }
                >
                  Add endpoint
                </button>
              </div>
              {form.endpoints.length === 0 && (
                <p className="settings-empty">
                  No endpoints yet. Add one to configure model routing.
                </p>
              )}
              <ol className="endpoint-list">
                {form.endpoints.map((endpoint, index) => {
                  const status = statusByEndpoint.get(endpoint.id);
                  const base = `endpoints.${index}`;
                  const label = endpoint.id || `Endpoint ${index + 1}`;
                  return (
                    <li className="endpoint-item" key={endpoint.uiKey}>
                      <div className="endpoint-item-heading">
                        <span className="endpoint-index">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <strong>{label}</strong>
                        <span
                          className={`endpoint-state state-${status?.state ?? "untried"}`}
                        >
                          {status?.state === "ok"
                            ? "Reachable"
                            : status?.state === "failed"
                              ? "Failed"
                              : "Not tried"}
                        </span>
                        <button
                          className="text-button remove-endpoint"
                          type="button"
                          onClick={() =>
                            setForm((prior) => ({
                              ...prior,
                              endpoints: prior.endpoints.filter(
                                (_, at) => at !== index,
                              ),
                            }))
                          }
                          aria-label={`Remove ${label}`}
                        >
                          Remove
                        </button>
                      </div>
                      {status?.state === "failed" && (
                        <p className="endpoint-error">
                          {status.reason}: {status.detail}
                        </p>
                      )}
                      <div className="endpoint-fields">
                        <label>
                          Endpoint ID
                          <input
                            value={endpoint.id}
                            onChange={(event) =>
                              updateEndpoint(index, "id", event.target.value)
                            }
                            aria-invalid={Boolean(errors[`${base}.id`])}
                          />
                          <FieldError message={errors[`${base}.id`]} />
                        </label>
                        <label>
                          Base URL
                          <input
                            type="url"
                            value={endpoint.baseUrl}
                            onChange={(event) =>
                              updateEndpoint(
                                index,
                                "baseUrl",
                                event.target.value,
                              )
                            }
                            aria-invalid={Boolean(errors[`${base}.baseUrl`])}
                          />
                          <FieldError message={errors[`${base}.baseUrl`]} />
                        </label>
                        <label>
                          Model
                          <input
                            value={endpoint.model}
                            onChange={(event) =>
                              updateEndpoint(index, "model", event.target.value)
                            }
                            aria-invalid={Boolean(errors[`${base}.model`])}
                          />
                          <span className="field-hint">
                            Not checked until a request.
                          </span>
                          <FieldError message={errors[`${base}.model`]} />
                        </label>
                        <label>
                          Key reference{" "}
                          <span className="optional-label">Optional</span>
                          <input
                            value={endpoint.keyRef}
                            onChange={(event) =>
                              updateEndpoint(
                                index,
                                "keyRef",
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      </div>
                      {normalizeKeyRef(endpoint.keyRef) && (
                        <div className="key-row">
                          <div className="key-state">
                            <span>Key</span>
                            <strong>
                              {keyStatus[normalizeKeyRef(endpoint.keyRef)] ===
                              "set"
                                ? "Set"
                                : "Missing"}
                            </strong>
                          </div>
                          <label className="key-entry">
                            Enter new key
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={
                                keyInputs[normalizeKeyRef(endpoint.keyRef)] ??
                                ""
                              }
                              onChange={(event) =>
                                setKeyInputs((prior) => ({
                                  ...prior,
                                  [normalizeKeyRef(endpoint.keyRef)]:
                                    event.target.value,
                                }))
                              }
                            />
                          </label>
                          <button
                            className="quiet-button"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void storeKey(normalizeKeyRef(endpoint.keyRef))
                            }
                          >
                            Save key
                          </button>
                          {keyStatus[normalizeKeyRef(endpoint.keyRef)] ===
                            "set" && (
                            <button
                              className="text-button"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void removeKey(normalizeKeyRef(endpoint.keyRef))
                              }
                            >
                              Remove key
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>

            <section
              className="settings-section roles-section"
              aria-labelledby="roles-title"
            >
              <div className="settings-section-heading">
                <div>
                  <p className="eyebrow">Routing</p>
                  <h2 id="roles-title">God assignments</h2>
                </div>
                <p className="section-hint">
                  Fallback order is tried from left to right.
                </p>
              </div>
              {roles.map((roleName) => {
                const role = form.roles[roleName] ?? emptyRole();
                return (
                  <fieldset className="role-row" key={roleName}>
                    <legend>{roleLabel(roleName)}</legend>
                    <label>
                      Endpoint
                      <select
                        value={role.endpoint}
                        onChange={(event) =>
                          setForm((prior) =>
                            updateRoleField(prior, roleName, {
                              endpoint: event.target.value,
                            }),
                          )
                        }
                        aria-invalid={Boolean(
                          errors[`roles.${roleName}.endpoint`],
                        )}
                      >
                        <option value="">No endpoint</option>
                        {form.endpoints.map((endpoint) => (
                          <option key={endpoint.uiKey} value={endpoint.id}>
                            {endpoint.id || "Unnamed endpoint"}
                          </option>
                        ))}
                      </select>
                      <FieldError
                        message={errors[`roles.${roleName}.endpoint`]}
                      />
                    </label>
                    <label>
                      Model override{" "}
                      <span className="optional-label">Optional</span>
                      <input
                        value={role.model}
                        placeholder="Use endpoint model"
                        onChange={(event) =>
                          setForm((prior) =>
                            updateRoleField(prior, roleName, {
                              model: event.target.value,
                            }),
                          )
                        }
                      />
                      {role.model && (
                        <small className="section-hint">
                          Model name is sent as entered and is not checked here.
                        </small>
                      )}
                    </label>
                    <label>
                      Role fallback order
                      <input
                        value={role.fallback}
                        placeholder="endpoint-a, endpoint-b"
                        disabled={role.inheritFallback}
                        onChange={(event) =>
                          setForm((prior) =>
                            updateRoleField(prior, roleName, {
                              fallback: event.target.value,
                            }),
                          )
                        }
                        aria-invalid={Boolean(
                          errors[`roles.${roleName}.fallback`],
                        )}
                      />
                      <FieldError
                        message={errors[`roles.${roleName}.fallback`]}
                      />
                    </label>
                    <label className="toggle-row role-fallback-toggle">
                      <input
                        type="checkbox"
                        checked={role.inheritFallback}
                        onChange={(event) =>
                          setForm((prior) =>
                            updateRoleField(prior, roleName, {
                              inheritFallback: event.target.checked,
                            }),
                          )
                        }
                      />
                      <span>Use the global fallback</span>
                    </label>
                  </fieldset>
                );
              })}
              <label className="global-fallback">
                Global fallback order
                <input
                  value={form.fallback}
                  placeholder="endpoint-a, endpoint-b"
                  onChange={(event) =>
                    setForm((prior) => ({
                      ...prior,
                      fallback: event.target.value,
                    }))
                  }
                  aria-invalid={Boolean(errors["fallback.0"])}
                />
                <span className="field-hint">
                  Separate endpoint IDs with commas.
                </span>
                <FieldError message={errors.fallback} />
              </label>
            </section>
          </div>

          <aside className="settings-side-column">
            <section className="offline-panel" aria-labelledby="offline-title">
              <p className="eyebrow">Network policy</p>
              <h2 id="offline-title">Offline mode</h2>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={form.offline}
                  onChange={(event) =>
                    setForm((prior) => ({
                      ...prior,
                      offline: event.target.checked,
                    }))
                  }
                />
                <span>Use local endpoints only</span>
              </label>
              <p className="field-hint">
                Locality comes from each endpoint URL. No network fallback is
                used while offline.
              </p>
              {form.offline && (
                <div className="dropped-list">
                  <strong>Dropped while offline</strong>
                  {dropped.length ? (
                    <ul>
                      {dropped.map((endpoint) => (
                        <li key={endpoint.id}>
                          {endpoint.id} <span>{endpoint.baseUrl}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No hosted endpoints to drop.</p>
                  )}
                </div>
              )}
            </section>
            <section className="save-panel" aria-label="Save model settings">
              <p className="eyebrow">Apply changes</p>
              <p>Saving settings or keys restarts the world service.</p>
              {loadError && (
                <p className="settings-error" role="alert">
                  Could not load settings: {loadError}
                </p>
              )}
              {errors.form && (
                <p className="settings-error" role="alert">
                  {errors.form}
                </p>
              )}
              <button className="save-button" type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save settings"}
              </button>
              <p
                className="save-message"
                role={isError ? "alert" : "status"}
                aria-live={isError ? "assertive" : "polite"}
              >
                {message}
              </p>
            </section>
          </aside>
        </div>
        <div className="settings-mobile-save">
          <button className="save-button" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
          <span role="status" aria-live="polite">
            {message}
          </span>
        </div>
      </form>
    </section>
  );
}

function FieldError({ message }: { readonly message?: string }) {
  return message ? (
    <small className="field-error" role="alert">
      {message}
    </small>
  ) : null;
}
