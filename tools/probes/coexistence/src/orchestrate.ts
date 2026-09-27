// Loop mechanics for the coexistence probe (Unit 8): a steady-cadence LLM
// request loop, a back-to-back sd.cpp image-generation loop, the single
// lock the mutex policy tests, and the memory-threshold gate the
// admission-controlled-queue policy tests. Process lifecycle (spawning
// `ollama serve`/`sd-server`/the renderer app, killing them, wiring flags)
// stays in run.ts — this module only knows how to drive one already-running
// service under a given policy and record what happened.

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** A steady drumbeat of dialogue-turn + action-proposal prompts for the LLM loop — small and varied, not a schema-validity research set (that's inference-baseline's job). */
export const LLM_LOOP_PROMPTS: readonly string[] = [
  'Zeus, overlooking the town market: a merchant broke an oath sworn in your name. Reply with one JSON action: {"kind":"move"|"say"|"trade"|"strike"|"idle", ...}.',
  "Hera, at the Olympus hearth: a mortal petitioner is still waiting for judgment. Reply with one JSON action.",
  "Athena, watching two blacksmiths dispute a shared forge: Hephaestus asks you to choose a side. Reply with one JSON action.",
  "Hades, at the Underworld entry hall: a newly arrived shade asks about the return condition. Reply with one JSON action.",
  "Poseidon, above the harbor: a storm has damaged two fishing boats. Reply with one JSON action.",
  "Ares, near the town gate: a duel has been challenged over a stolen ox. Reply with one JSON action.",
  "Demeter, in the wilderness fields: a drought threatens this season\u2019s harvest. Reply with one JSON action.",
  "Hermes, on the road between town and Olympus: a message needs delivery before dusk. Reply with one JSON action.",
];

export interface LlmRequestSample {
  readonly atMs: number;
  readonly totalMs: number;
  readonly ok: boolean;
}

/** A cooperative single lock: whichever side holds it, the other awaits release — the mutex policy's "single lock" (docs/plans Unit 8 KTD). */
export interface CoexistenceLock {
  acquire(): Promise<() => void>;
}

export function createLock(): CoexistenceLock {
  let locked = false;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<() => void> {
      if (!locked) {
        locked = true;
      } else {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      return (): void => {
        const next = waiters.shift();
        if (next) {
          next();
        } else {
          locked = false;
        }
      };
    },
  };
}

/** True once `getAdmissionMiB()` reports at least `thresholdMiB` free+inactive memory. `undefined` reads (sampler not yet ticked) are treated as "not yet admitted". */
export function createAdmissionGate(
  getAdmissionMiB: () => number | undefined,
  thresholdMiB: number,
): () => boolean {
  return () => {
    const admissionMiB = getAdmissionMiB();
    return admissionMiB !== undefined && admissionMiB >= thresholdMiB;
  };
}

async function sendOllamaChatRequest(
  baseUrl: string,
  model: string,
  prompt: string,
  options: {
    readonly maxTokens: number;
    readonly contextTokens: number;
    readonly timeoutMs: number;
  },
): Promise<{ readonly ok: boolean; readonly totalMs: number }> {
  const startedAt = performance.now();
  try {
    return await withTimeout(options.timeoutMs, async (signal) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          messages: [
            {
              role: "system",
              content:
                "You are a character in a simulated world. Reply with exactly one compact JSON action object, no prose.",
            },
            { role: "user", content: prompt },
          ],
          options: {
            num_ctx: options.contextTokens,
            num_predict: options.maxTokens,
          },
        }),
      });
      const totalMs = performance.now() - startedAt;
      return { ok: response.ok, totalMs };
    });
  } catch {
    const totalMs = performance.now() - startedAt;
    return { ok: false, totalMs };
  }
}

export interface LlmLoopOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly durationMs: number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly contextTokens?: number;
  /** Present only for the mutex policy: an in-flight image generation holds this lock, so the LLM request awaits release. */
  readonly lock?: CoexistenceLock;
}

/** Drives a steady-cadence "one request every `intervalMs`" LLM loop for `durationMs`, recording per-request latency. */
export async function runLlmLoop(
  options: LlmLoopOptions,
): Promise<readonly LlmRequestSample[]> {
  const intervalMs = options.intervalMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxTokens = options.maxTokens ?? 150;
  const contextTokens = options.contextTokens ?? 4096;
  const samples: LlmRequestSample[] = [];
  const startedAt = performance.now();
  let promptIndex = 0;

  while (performance.now() - startedAt < options.durationMs) {
    const atMs = performance.now() - startedAt;
    const prompt =
      LLM_LOOP_PROMPTS[promptIndex % LLM_LOOP_PROMPTS.length] ??
      LLM_LOOP_PROMPTS[0] ??
      "Reply with one JSON action.";
    promptIndex += 1;

    // Timed from before lock acquisition, not just the HTTP call: under the
    // mutex policy this is exactly the effect being measured ("LLM requests
    // wait while an image is generating") — timing only the request itself
    // would silently hide the wait and make every policy look the same.
    const requestStartedAt = performance.now();
    let release: (() => void) | undefined;
    if (options.lock) {
      release = await options.lock.acquire();
    }
    const result = await sendOllamaChatRequest(
      options.baseUrl,
      options.model,
      prompt,
      {
        maxTokens,
        contextTokens,
        timeoutMs,
      },
    );
    release?.();
    const totalMs = performance.now() - requestStartedAt;

    samples.push({ atMs, totalMs, ok: result.ok });

    const elapsedThisTick = performance.now() - startedAt - atMs;
    const remaining = intervalMs - elapsedThisTick;
    if (remaining > 0) {
      await Bun.sleep(remaining);
    }
  }
  return samples;
}

interface SdCppJobSubmission {
  readonly id: string;
}

async function submitSdCppJob(
  baseUrl: string,
  options: {
    readonly width: number;
    readonly height: number;
    readonly steps: number;
    readonly timeoutMs: number;
  },
): Promise<SdCppJobSubmission> {
  return withTimeout(options.timeoutMs, async (signal) => {
    const response = await fetch(`${baseUrl}/sdcpp/v1/img_gen`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "pixel art town square, isometric, warm lighting",
        negative_prompt: "",
        width: options.width,
        height: options.height,
        seed: -1,
        batch_count: 1,
        sample_params: { sample_steps: options.steps },
        lora: [],
      }),
    });
    if (!response.ok) {
      throw new Error(`sd.cpp job submission returned HTTP ${response.status}`);
    }
    const parsed = (await response.json()) as { readonly id?: unknown };
    if (typeof parsed.id !== "string") {
      throw new Error("sd.cpp job submission missing string id");
    }
    return { id: parsed.id };
  });
}

async function pollSdCppJob(
  baseUrl: string,
  jobId: string,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<{ readonly status: string }> {
  const startedAt = performance.now();
  for (;;) {
    const parsed = await withTimeout(5000, async (signal) => {
      const response = await fetch(
        `${baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(jobId)}`,
        { signal },
      );
      return (await response.json()) as { readonly status?: unknown };
    });
    const status =
      typeof parsed.status === "string" ? parsed.status : "unknown";
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      return { status };
    }
    if (performance.now() - startedAt > timeoutMs) {
      return { status: "timeout" };
    }
    await Bun.sleep(pollIntervalMs);
  }
}

export interface ImageRunSample {
  readonly atMs: number;
  readonly seconds: number;
  readonly ok: boolean;
}

export interface ImageLoopOptions {
  readonly baseUrl: string;
  readonly durationMs: number;
  readonly width?: number;
  readonly height?: number;
  readonly steps?: number;
  readonly submitTimeoutMs?: number;
  readonly jobTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Present only for the mutex policy: an in-flight LLM request holds this lock, so image generation awaits its release before starting. */
  readonly lock?: CoexistenceLock;
  /** Present only for the admission-controlled-queue policy: gates the START of the next image on measured free+inactive memory. */
  readonly admissionGate?: () => boolean;
  readonly admissionPollMs?: number;
}

/** Drives back-to-back sd.cpp image generation for `durationMs`, gated by an optional lock (mutex) or memory threshold (admission-queue). Never more than one image in flight — the loop is sequential by construction. */
export async function runImageLoop(
  options: ImageLoopOptions,
): Promise<readonly ImageRunSample[]> {
  const width = options.width ?? 512;
  const height = options.height ?? 512;
  const steps = options.steps ?? 12;
  const submitTimeoutMs = options.submitTimeoutMs ?? 10000;
  const jobTimeoutMs = options.jobTimeoutMs ?? 90000;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const admissionPollMs = options.admissionPollMs ?? 2000;
  const samples: ImageRunSample[] = [];
  const startedAt = performance.now();

  while (performance.now() - startedAt < options.durationMs) {
    if (options.admissionGate) {
      while (
        !options.admissionGate() &&
        performance.now() - startedAt < options.durationMs
      ) {
        await Bun.sleep(admissionPollMs);
      }
      if (performance.now() - startedAt >= options.durationMs) {
        break;
      }
    }

    let release: (() => void) | undefined;
    if (options.lock) {
      release = await options.lock.acquire();
    }
    const atMs = performance.now() - startedAt;
    const imageStartedAt = performance.now();
    let ok = false;
    try {
      const submission = await submitSdCppJob(options.baseUrl, {
        width,
        height,
        steps,
        timeoutMs: submitTimeoutMs,
      });
      const job = await pollSdCppJob(
        options.baseUrl,
        submission.id,
        pollIntervalMs,
        jobTimeoutMs,
      );
      ok = job.status === "completed";
    } catch {
      ok = false;
    } finally {
      release?.();
    }
    const seconds = (performance.now() - imageStartedAt) / 1000;
    samples.push({ atMs, seconds, ok });
  }
  return samples;
}

/** Times one sd.cpp image generation end-to-end (submit + poll to completion) — used both by the image loop and the sd-server warmup transition measurement (stable-diffusion.cpp loads checkpoint tensors lazily on first request, not at process startup, so "reachable" alone understates the real cold-start cost; see art-local's own warmup-vs-steady-state column). */
export async function timeOneImage(
  baseUrl: string,
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly steps?: number;
    readonly submitTimeoutMs?: number;
    readonly jobTimeoutMs?: number;
    readonly pollIntervalMs?: number;
  } = {},
): Promise<{ readonly ok: boolean; readonly totalMs: number }> {
  const startedAt = performance.now();
  try {
    const submission = await submitSdCppJob(baseUrl, {
      width: options.width ?? 512,
      height: options.height ?? 512,
      steps: options.steps ?? 12,
      timeoutMs: options.submitTimeoutMs ?? 10000,
    });
    const job = await pollSdCppJob(
      baseUrl,
      submission.id,
      options.pollIntervalMs ?? 1000,
      options.jobTimeoutMs ?? 90000,
    );
    return {
      ok: job.status === "completed",
      totalMs: performance.now() - startedAt,
    };
  } catch {
    return { ok: false, totalMs: performance.now() - startedAt };
  }
}

/** Polls `checkReady` until it resolves true or `timeoutMs` elapses; used for cold-start/warmup transition timing (a fresh `ollama serve`/`sd-server` becoming reachable). */
export async function waitForReady(
  checkReady: () => Promise<boolean>,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<{ readonly ready: boolean; readonly ms: number }> {
  const startedAt = performance.now();
  for (;;) {
    if (await checkReady()) {
      return { ready: true, ms: performance.now() - startedAt };
    }
    if (performance.now() - startedAt > timeoutMs) {
      return { ready: false, ms: performance.now() - startedAt };
    }
    await Bun.sleep(pollIntervalMs);
  }
}

/** Times one Ollama chat request end-to-end — used both by the steady loop and the cold-start transition measurement (a single request against a model that may need to load first). */
export async function timeOllamaChatRequest(
  baseUrl: string,
  model: string,
  timeoutMs = 60000,
): Promise<{ readonly ok: boolean; readonly totalMs: number }> {
  return sendOllamaChatRequest(
    baseUrl,
    model,
    LLM_LOOP_PROMPTS[0] ?? "Reply with one JSON action.",
    {
      maxTokens: 150,
      contextTokens: 4096,
      timeoutMs,
    },
  );
}
