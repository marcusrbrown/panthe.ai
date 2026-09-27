// Adapter for stable-diffusion.cpp's `sd-server`, native async `sdcpp` API
// (see examples/server/api.md in leejet/stable-diffusion.cpp): submit a job
// with `POST /sdcpp/v1/img_gen`, poll `GET /sdcpp/v1/jobs/{id}` to
// completion, and cancel an in-flight job with
// `POST /sdcpp/v1/jobs/{id}/cancel`. This is the base arm for ADR-0007 —
// it must work standalone, with no Draw Things dependency.
//
// Never hangs: every network call carries an explicit timeout via
// `AbortSignal.timeout`, so "server absent" surfaces as a clear rejected
// promise, not a stuck request. Response bodies are validated field-by-field
// with a JSON-pointer-style path in the error, so a malformed body never
// throws a bare "Cannot read property of undefined".

export interface SdCppConfig {
  readonly baseUrl: string;
}

export interface LoraRef {
  readonly path: string;
  readonly multiplier: number;
}

export interface ImgGenOptions {
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly steps?: number;
  readonly seed?: number;
  readonly lora?: readonly LoraRef[];
  readonly timeoutMs?: number;
}

export interface JobSubmission {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly created: number;
  readonly pollUrl: string;
}

export interface JobImage {
  readonly index: number;
  readonly bytes: Uint8Array;
}

export type JobStatusName =
  | "queued"
  | "generating"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobRecord {
  readonly id: string;
  readonly kind: string;
  readonly status: JobStatusName;
  readonly created: number;
  readonly started: number | null;
  readonly completed: number | null;
  readonly queuePosition: number;
  readonly images: readonly JobImage[] | undefined;
  readonly error:
    | { readonly code: string; readonly message: string }
    | undefined;
}

export class SdCppError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(path ? `${message} (at ${path})` : message);
    this.name = "SdCppError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SdCppError(
        `request to ${url} timed out after ${timeoutMs}ms (server not responding)`,
      );
    }
    throw new SdCppError(
      `request to ${url} failed: ${error instanceof Error ? error.message : String(error)} (server not reachable)`,
    );
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    throw new SdCppError(
      `response from ${url} was not valid JSON (status ${response.status})`,
      "$",
    );
  }
  if (!response.ok) {
    const message =
      isRecord(parsed) && typeof parsed.error === "object"
        ? JSON.stringify(parsed.error)
        : text;
    throw new SdCppError(`${url} returned ${response.status}: ${message}`, "$");
  }
  return parsed;
}

/** Submits an async image-generation job. Returns immediately once the server accepts it (202). */
export async function submitImgGen(
  config: SdCppConfig,
  options: ImgGenOptions,
): Promise<JobSubmission> {
  const body = {
    prompt: options.prompt,
    negative_prompt: options.negativePrompt ?? "",
    width: options.width ?? 512,
    height: options.height ?? 512,
    seed: options.seed ?? -1,
    batch_count: 1,
    sample_params: {
      sample_steps: options.steps ?? 12,
    },
    lora: (options.lora ?? []).map((l) => ({
      path: l.path,
      multiplier: l.multiplier,
    })),
  };

  const parsed = await requestJson(
    `${config.baseUrl}/sdcpp/v1/img_gen`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!isRecord(parsed)) {
    throw new SdCppError("job submission response was not an object", "$");
  }
  if (typeof parsed.id !== "string") {
    throw new SdCppError("job submission missing string id", "$.id");
  }
  if (typeof parsed.kind !== "string") {
    throw new SdCppError("job submission missing string kind", "$.kind");
  }
  if (typeof parsed.status !== "string") {
    throw new SdCppError("job submission missing string status", "$.status");
  }
  if (typeof parsed.created !== "number") {
    throw new SdCppError("job submission missing numeric created", "$.created");
  }
  if (typeof parsed.poll_url !== "string") {
    throw new SdCppError(
      "job submission missing string poll_url",
      "$.poll_url",
    );
  }
  return {
    id: parsed.id,
    kind: parsed.kind,
    status: parsed.status,
    created: parsed.created,
    pollUrl: parsed.poll_url,
  };
}

function parseJobRecord(parsed: unknown): JobRecord {
  if (!isRecord(parsed)) {
    throw new SdCppError("job record was not an object", "$");
  }
  if (typeof parsed.id !== "string") {
    throw new SdCppError("job record missing string id", "$.id");
  }
  if (typeof parsed.kind !== "string") {
    throw new SdCppError("job record missing string kind", "$.kind");
  }
  const status = parsed.status;
  if (
    status !== "queued" &&
    status !== "generating" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    throw new SdCppError(
      `job record has unrecognized status ${JSON.stringify(status)}`,
      "$.status",
    );
  }
  if (typeof parsed.created !== "number") {
    throw new SdCppError("job record missing numeric created", "$.created");
  }

  let images: readonly JobImage[] | undefined;
  if (status === "completed") {
    const result = parsed.result;
    if (!isRecord(result)) {
      throw new SdCppError(
        "completed job record missing result object",
        "$.result",
      );
    }
    const rawImages = result.images;
    if (!Array.isArray(rawImages)) {
      throw new SdCppError(
        "completed job result missing images array",
        "$.result.images",
      );
    }
    images = rawImages.map((entry, index) => {
      const path = `$.result.images[${index}]`;
      if (!isRecord(entry) || typeof entry.b64_json !== "string") {
        throw new SdCppError(
          "image entry missing string b64_json",
          `${path}.b64_json`,
        );
      }
      const entryIndex = typeof entry.index === "number" ? entry.index : index;
      return {
        index: entryIndex,
        bytes: Uint8Array.from(Buffer.from(entry.b64_json, "base64")),
      };
    });
  }

  let error: JobRecord["error"];
  if (status === "failed" || status === "cancelled") {
    const errObj = parsed.error;
    if (isRecord(errObj)) {
      const code = typeof errObj.code === "string" ? errObj.code : "unknown";
      const message = typeof errObj.message === "string" ? errObj.message : "";
      error = { code, message };
    } else {
      error = { code: "unknown", message: "" };
    }
  }

  return {
    id: parsed.id,
    kind: parsed.kind,
    status,
    created: parsed.created,
    started: typeof parsed.started === "number" ? parsed.started : null,
    completed: typeof parsed.completed === "number" ? parsed.completed : null,
    queuePosition:
      typeof parsed.queue_position === "number" ? parsed.queue_position : 0,
    images,
    error,
  };
}

/** Fetches current job status. Never hangs — bounded by `timeoutMs`. */
export async function getJob(
  config: SdCppConfig,
  jobId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<JobRecord> {
  const parsed = await requestJson(
    `${config.baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(jobId)}`,
    { method: "GET" },
    timeoutMs,
  );
  return parseJobRecord(parsed);
}

/** Attempts to cancel an accepted/in-flight job. Resolves even if the job already finished. */
export async function cancelJob(
  config: SdCppConfig,
  jobId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  try {
    await requestJson(
      `${config.baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
      timeoutMs,
    );
  } catch (error) {
    // 404/409/410 (job already finished, already cancelled, or gone) are
    // not bench failures — the job is not running either way.
    if (
      error instanceof SdCppError &&
      /returned 40[49]|returned 410/.test(error.message)
    ) {
      return;
    }
    throw error;
  }
}

export interface PollOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Polls a job to a terminal state (completed/failed/cancelled), bounded by `timeoutMs`. */
export async function pollUntilDone(
  config: SdCppConfig,
  jobId: string,
  options: PollOptions = {},
): Promise<JobRecord> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  for (;;) {
    if (options.signal?.aborted) {
      throw new SdCppError("polling aborted by caller signal");
    }
    const job = await getJob(config, jobId);
    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return job;
    }
    if (Date.now() >= deadline) {
      throw new SdCppError(
        `job ${jobId} did not reach a terminal state within the poll timeout`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export interface GenerateResult {
  readonly job: JobRecord;
  readonly images: readonly JobImage[];
}

/** Submits a job and polls it to completion. Throws with the job's error on failure/cancellation. */
export async function generateImage(
  config: SdCppConfig,
  options: ImgGenOptions,
  pollOptions: PollOptions = {},
): Promise<GenerateResult> {
  const submission = await submitImgGen(config, options);
  const job = await pollUntilDone(config, submission.id, pollOptions);
  if (job.status !== "completed") {
    throw new SdCppError(
      `job ${submission.id} ended as ${job.status}: ${job.error?.message ?? "no error message"}`,
    );
  }
  return { job, images: job.images ?? [] };
}

/** Cheap reachability probe: `GET /sdcpp/v1/capabilities`. Never throws — returns a result object. */
export async function checkReachable(
  config: SdCppConfig,
  timeoutMs = 3_000,
): Promise<{ readonly reachable: boolean; readonly detail: string }> {
  try {
    await requestJson(
      `${config.baseUrl}/sdcpp/v1/capabilities`,
      { method: "GET" },
      timeoutMs,
    );
    return { reachable: true, detail: "ok" };
  } catch (error) {
    return {
      reachable: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ImgGenFeatures {
  readonly cancelQueued: boolean;
  readonly cancelGenerating: boolean;
}

/**
 * Reads `features_by_mode.img_gen` from `GET /sdcpp/v1/capabilities` —
 * critically, whether this build can cancel a job that has already started
 * generating (`cancel_generating`) versus only one still queued behind
 * another (`cancel_queued`). Some stable-diffusion.cpp builds support only
 * the latter, which callers need to know before relying on
 * `POST /sdcpp/v1/jobs/{id}/cancel` to interrupt an in-flight job.
 */
export async function getImgGenFeatures(
  config: SdCppConfig,
  timeoutMs = 5_000,
): Promise<ImgGenFeatures | undefined> {
  try {
    const parsed = await requestJson(
      `${config.baseUrl}/sdcpp/v1/capabilities`,
      { method: "GET" },
      timeoutMs,
    );
    if (!isRecord(parsed)) {
      return undefined;
    }
    const featuresByMode = parsed.features_by_mode;
    if (!isRecord(featuresByMode)) {
      return undefined;
    }
    const imgGen = featuresByMode.img_gen;
    if (!isRecord(imgGen)) {
      return undefined;
    }
    return {
      cancelQueued: imgGen.cancel_queued === true,
      cancelGenerating: imgGen.cancel_generating === true,
    };
  } catch {
    return undefined;
  }
}
