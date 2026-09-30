// The real-inference run: the compiled sidecar with both gods taking turns
// through local Ollama (llama3.2 3B at a 4K context), unscripted, for a fixed
// wall time. It asserts properties (see real-analysis.ts), not exact facts,
// and records latency and outcomes so the README can quote numbers from a run.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnvironment } from "@panthea/tools-probes-shared";
import {
  killAllSidecars,
  startSidecar,
} from "../../m1-living-world/src/sidecar";
import { readFrame } from "../../m1-living-world/src/steps/api";
import { activeStorePath } from "../../m1-living-world/src/world-db";
import { readProposals, readRealRequests, readStoredEvents } from "./db";
import { analyzeReal, type RealAnalysis } from "./real-analysis";

export interface RealOptions {
  readonly binary: string;
  readonly durationMs: number;
  readonly ollama: string;
  readonly model: string;
}

export interface RealRecord {
  readonly ranAt: string;
  readonly model: string;
  readonly durationMs: number;
  readonly ticks: number;
  readonly analysis: RealAnalysis;
  readonly hardware: string;
}

export class OllamaUnreachable extends Error {}

/** Confirms Ollama answers and has the model, loads it, and returns. Throws with the exact error otherwise. */
async function prepareOllama(options: RealOptions): Promise<void> {
  const tags = `${options.ollama}/api/tags`;
  let names: string[];
  try {
    const response = await fetch(tags);
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    names = (
      (await response.json()) as { models: { name: string }[] }
    ).models.map((model) => model.name);
  } catch (error) {
    throw new OllamaUnreachable(
      `Ollama is unreachable at ${tags}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !names.some(
      (name) => name === options.model || name === `${options.model}:latest`,
    )
  ) {
    throw new OllamaUnreachable(
      `Ollama at ${options.ollama} has no model ${options.model} (has ${names.join(", ")})`,
    );
  }
  // Load it and keep it loaded, so the first turn does not measure a cold start.
  await fetch(`${options.ollama}/api/generate`, {
    method: "POST",
    body: JSON.stringify({
      model: options.model,
      prompt: "",
      keep_alive: "10m",
    }),
  });
}

export async function runReal(options: RealOptions): Promise<RealRecord> {
  await prepareOllama(options);
  const root = mkdtempSync(join(tmpdir(), "panthea-m2-real-"));
  const dataDir = join(root, "app-data");
  const configPath = join(root, "models.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      endpoints: [
        { id: "ollama", baseUrl: `${options.ollama}/v1`, model: options.model },
      ],
      roles: { zeus: { endpoint: "ollama" }, hera: { endpoint: "ollama" } },
    }),
  );
  try {
    const sidecar = await startSidecar(options.binary, dataDir, {
      env: { PANTHEA_MODEL_CONFIG: configPath },
    });
    const polls = { total: 0, degraded: 0 };
    const deadline = Date.now() + options.durationMs;
    let ticks = 0;
    while (Date.now() < deadline) {
      await Bun.sleep(2000);
      const { frame, state } = await readFrame(sidecar);
      polls.total += 1;
      if (frame.degradedReason === "model-degraded") polls.degraded += 1;
      ticks = state.tick;
    }
    const code = await sidecar.stop("SIGTERM");
    if (code !== 0) throw new Error(`the sidecar exited ${code}`);
    const path = activeStorePath(dataDir);
    const proposals = readProposals(path)
      .filter((entry) => entry.source === "model")
      .map((entry) => ({
        proposalId: entry.proposalId,
        actor: entry.actor,
        kind: entry.kind,
        observationId: String(entry.proposal.observationId),
        proposal: entry.proposal,
        outcome: entry.outcome as "committed" | "rejected" | undefined,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      }));
    const analysis = analyzeReal({
      requests: readRealRequests(path),
      proposals,
      events: readStoredEvents(path),
      polls,
    });
    return {
      ranAt: new Date().toISOString(),
      model: options.model,
      durationMs: options.durationMs,
      ticks,
      analysis,
      hardware: captureEnvironment().hardware.brand,
    };
  } finally {
    killAllSidecars();
    rmSync(root, { recursive: true, force: true });
  }
}
