// Adapter for Draw Things' HTTP API server (Settings → API Server), which
// exposes an A1111-shaped `POST /sdapi/v1/txt2img`. This is the optional
// add-on arm for ADR-0007 — it never gates the base stable-diffusion.cpp
// arm and this probe never leaves the server enabled after a run.
//
// Known HTTP-surface limits (recorded, not worked around): no model/LoRA
// selection over HTTP, no model list, no cancellation. The active model is
// whatever the app has selected — callers must record which model was
// selected for each run out of band (the app UI, not this adapter).
//
// Never hangs: every call carries an explicit timeout via
// `AbortSignal.timeout`. If the app is not running or the API server is
// off, the request fails fast with a clear error, not a stuck promise.

export interface DrawThingsConfig {
  readonly baseUrl: string;
}

export interface Txt2ImgOptions {
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly steps?: number;
  readonly seed?: number;
  readonly cfgScale?: number;
  readonly timeoutMs?: number;
}

export interface Txt2ImgResult {
  readonly images: readonly Uint8Array[];
  readonly rawParameters: unknown;
}

export class DrawThingsError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(path ? `${message} (at ${path})` : message);
    this.name = "DrawThingsError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POSTs txt2img and decodes the base64 image list. Never hangs — bounded by `timeoutMs`. */
export async function txt2img(
  config: DrawThingsConfig,
  options: Txt2ImgOptions,
): Promise<Txt2ImgResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = {
    prompt: options.prompt,
    negative_prompt: options.negativePrompt ?? "",
    width: options.width ?? 512,
    height: options.height ?? 512,
    steps: options.steps ?? 12,
    seed: options.seed ?? -1,
    cfg_scale: options.cfgScale ?? 7.0,
    batch_size: 1,
  };

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new DrawThingsError(
        `txt2img request timed out after ${timeoutMs}ms — Draw Things not responding (is the app running with the API server enabled?)`,
      );
    }
    throw new DrawThingsError(
      `txt2img request failed: ${error instanceof Error ? error.message : String(error)} — Draw Things not reachable at ${config.baseUrl} (is the app running with the API server enabled?)`,
    );
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    throw new DrawThingsError(
      `txt2img response was not valid JSON (status ${response.status})`,
      "$",
    );
  }
  if (!response.ok) {
    throw new DrawThingsError(
      `txt2img returned ${response.status}: ${text}`,
      "$",
    );
  }
  if (!isRecord(parsed)) {
    throw new DrawThingsError("txt2img response was not an object", "$");
  }
  const rawImages = parsed.images;
  if (!Array.isArray(rawImages)) {
    throw new DrawThingsError(
      "txt2img response missing images array",
      "$.images",
    );
  }
  const images = rawImages.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new DrawThingsError(
        "image entry was not a base64 string",
        `$.images[${index}]`,
      );
    }
    // Draw Things may return a bare base64 string or a `data:image/...`
    // URL; strip the prefix if present.
    const commaIndex = entry.indexOf(",");
    const b64 =
      entry.startsWith("data:") && commaIndex !== -1
        ? entry.slice(commaIndex + 1)
        : entry;
    return Uint8Array.from(Buffer.from(b64, "base64"));
  });

  return { images, rawParameters: parsed.parameters };
}

/** Cheap reachability probe: a short-timeout GET to the options endpoint. Never throws. */
export async function checkReachable(
  config: DrawThingsConfig,
  timeoutMs = 3_000,
): Promise<{ readonly reachable: boolean; readonly detail: string }> {
  try {
    const response = await fetch(`${config.baseUrl}/sdapi/v1/options`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        reachable: false,
        detail: `GET /sdapi/v1/options returned ${response.status}`,
      };
    }
    return { reachable: true, detail: "ok" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const url = new URL(config.baseUrl);
    return {
      reachable: false,
      detail: `not reachable at ${url.port || "80"}: ${message}`,
    };
  }
}

/**
 * Reads the currently selected model from `GET /sdapi/v1/options`. Never
 * throws. Draw Things' actual options response is its own large settings
 * dict with the selected model under `model` (not the vanilla A1111/
 * stable-diffusion.cpp-compat `sd_model_checkpoint` key) — both are
 * checked so this keeps working against either shape.
 */
export async function getSelectedModel(
  config: DrawThingsConfig,
  timeoutMs = 3_000,
): Promise<string | undefined> {
  try {
    const response = await fetch(`${config.baseUrl}/sdapi/v1/options`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return undefined;
    }
    const parsed: unknown = await response.json();
    if (!isRecord(parsed)) {
      return undefined;
    }
    if (typeof parsed.model === "string") {
      return parsed.model;
    }
    if (typeof parsed.sd_model_checkpoint === "string") {
      return parsed.sd_model_checkpoint;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface ActiveLora {
  readonly file: string;
  readonly weight: number;
  readonly mode: string;
}

/** Reads the app's currently active LoRA list from `GET /sdapi/v1/options` (`loras: [{file, weight, mode}]`). Never throws. */
export async function getActiveLoras(
  config: DrawThingsConfig,
  timeoutMs = 3_000,
): Promise<readonly ActiveLora[]> {
  try {
    const response = await fetch(`${config.baseUrl}/sdapi/v1/options`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return [];
    }
    const parsed: unknown = await response.json();
    if (!isRecord(parsed) || !Array.isArray(parsed.loras)) {
      return [];
    }
    return parsed.loras.filter(isRecord).map((entry) => ({
      file: typeof entry.file === "string" ? entry.file : "unknown",
      weight: typeof entry.weight === "number" ? entry.weight : 0,
      mode: typeof entry.mode === "string" ? entry.mode : "unknown",
    }));
  } catch {
    return [];
  }
}

/** Combines the selected model and any active LoRAs into one descriptor string for recording (e.g. `sd_v1.5_f16.ckpt + pixelart_lora@0.6`). Never throws. */
export async function getSelectedModelDescriptor(
  config: DrawThingsConfig,
  timeoutMs = 3_000,
): Promise<string> {
  const model = (await getSelectedModel(config, timeoutMs)) ?? "unknown";
  const loras = await getActiveLoras(config, timeoutMs);
  if (loras.length === 0) {
    return model;
  }
  const loraDescriptors = loras
    .map((lora) => `${lora.file}@${lora.weight}`)
    .join(", ");
  return `${model} + ${loraDescriptors}`;
}
