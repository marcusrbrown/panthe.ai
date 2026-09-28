// The sidecar's authenticated HTTP/WebSocket surface: every request needs
// the launch token (constant-time compare), rejects any request or
// upgrade carrying an `Origin`/`Sec-Fetch-*` header or a `Host` other than
// the bound loopback address, and never logs the token. Internal routines
// never go through this module -- they call the world engine directly,
// in-process; only fixture/scenario proposals arrive over `/proposals`.
//
// The WebSocket stream publishes a committed-state frame to the `frame`
// topic after each committed tick; a new or reconnecting subscriber gets
// one immediately on open, and `server.publish`'s return value (0 =
// dropped, -1 = backpressure, otherwise bytes sent) is checked rather than
// assumed to always succeed.

import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import {
  type ArchiveManifest,
  type CatchUpSummary,
  createObservationId,
  createSessionId,
  type DegradedReason,
  parseEventId,
  parseObservationRecord,
  parseSessionId,
  type SessionId,
  type SyncFrame,
  type WorldId,
  type WorldStatus,
} from "@panthea/contracts";
import {
  exportArchive,
  type ProjectionReducers,
  readClock,
  readPrngState,
  type Store,
} from "@panthea/persistence";
import {
  createProposalId,
  followEvent,
  followProposal,
  parseProposalId,
  recordObservation,
  recordReceipt,
  UnknownEventError,
} from "@panthea/telemetry";
import { toEntityId, type WorldState } from "@panthea/world";
import {
  commitWorldTick,
  intakeProposal,
  type QueuedProposal,
  type TickDeps,
} from "./tick";
import { createEventSource, worldProjectionCodec } from "./world-store";
import { importWorldArchive, listWorldSlots, type WorldSlot } from "./worlds";

// --- Request guards ----------------------------------------------------------

/** Constant-time bearer-token comparison, lifted from the probe; never throws on length mismatch. */
export function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

function extractBearerToken(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match?.[1];
}

function hasSecFetchHeader(headers: Headers): boolean {
  for (const key of headers.keys()) {
    if (key.toLowerCase().startsWith("sec-fetch-")) {
      return true;
    }
  }
  return false;
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

/**
 * Rejects (401, generic body, never echoing what was wrong) a request
 * that: carries an `Origin` header (any legitimate caller here is not a
 * browser page); carries any `Sec-Fetch-*` header (same reasoning,
 * DNS-rebinding/CSRF surface); names a `Host` other than the bound
 * loopback address; or lacks a bearer token equal to this launch's token
 * (constant-time compare -- covers a missing token, a wrong token, and a
 * stale token from a previous launch equally, since this process only
 * ever recognizes its own current token).
 */
export function checkRequestGuards(
  request: Request,
  expected: { readonly token: string; readonly host: string },
): Response | undefined {
  if (request.headers.has("origin")) {
    return unauthorized();
  }
  if (hasSecFetchHeader(request.headers)) {
    return unauthorized();
  }
  if (request.headers.get("host") !== expected.host) {
    return unauthorized();
  }
  const provided = extractBearerToken(request.headers.get("authorization"));
  if (!provided || !tokensMatch(expected.token, provided)) {
    return unauthorized();
  }
  return undefined;
}

// --- Fixture proposal queue --------------------------------------------------

/** The queue `/proposals` appends to; the tick loop drains it alongside routine-produced proposals every tick. Internal routines never touch this -- only HTTP fixture intake does. */
export interface ExternalQueue {
  enqueue(proposal: QueuedProposal): void;
  drain(): QueuedProposal[];
}

export function createExternalQueue(): ExternalQueue {
  let pending: QueuedProposal[] = [];
  return {
    enqueue(proposal) {
      pending.push(proposal);
    },
    drain() {
      const drained = pending;
      pending = [];
      return drained;
    },
  };
}

// --- Shared status, read by /frame and the WebSocket stream ------------------

/** Mutated by the tick loop and by pause/resume; read to build every `SyncFrame`. */
export interface ServiceStatusRef {
  status: WorldStatus;
  degradedReason?: DegradedReason;
  sequence: number;
  encodedState: unknown;
  catchUpSummary?: CatchUpSummary;
}

export function createServiceStatusRef(state: WorldState): ServiceStatusRef {
  return {
    status: "running",
    sequence: state.lastSequence,
    encodedState: worldProjectionCodec.encode(state),
  };
}

export function updateServiceStatus(
  ref: ServiceStatusRef,
  state: WorldState,
  options: { readonly catchUpSummary?: CatchUpSummary } = {},
): void {
  ref.status = "running";
  ref.degradedReason = undefined;
  ref.sequence = state.lastSequence;
  ref.encodedState = worldProjectionCodec.encode(state);
  if (options.catchUpSummary) {
    ref.catchUpSummary = options.catchUpSummary;
  }
}

function buildFrame(
  worldId: WorldId,
  sessionId: SessionId,
  ref: ServiceStatusRef,
): SyncFrame {
  return {
    schemaVersion: 1,
    sequence: ref.sequence,
    worldId,
    sessionId,
    status: ref.status,
    ...(ref.degradedReason ? { degradedReason: ref.degradedReason } : {}),
    ...(ref.catchUpSummary ? { catchUpSummary: ref.catchUpSummary } : {}),
    state: ref.encodedState,
  };
}

// --- Operator events -----------------------------------------------------

const OPERATOR_ENTITY_ID = toEntityId("operator");

/** Records a pause/resume as an operator event, distinct from any character action: it never goes through `runTick`/`validateProposal` and produces no `WorldEvent`. */
function recordOperatorEvent(traceDb: Database, kind: string): void {
  recordObservation(traceDb, {
    schemaVersion: 1,
    id: createObservationId(),
    observer: OPERATOR_ENTITY_ID,
    stateRevision: 0,
    factsRead: [`operator:${kind}`],
    source: "operator",
  });
}

// --- Receipt rate limiting ----------------------------------------------

const RECEIPT_WINDOW_MS = 1000;
const RECEIPT_LIMIT_PER_WINDOW = 50;

function createReceiptLimiter(): (now: number) => boolean {
  let windowStart = 0;
  let count = 0;
  return (now: number) => {
    if (now - windowStart > RECEIPT_WINDOW_MS) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count > RECEIPT_LIMIT_PER_WINDOW;
  };
}

// --- Server --------------------------------------------------------------

export interface SimulationServerOptions {
  readonly token: string;
  readonly store: Store;
  readonly reducers: ProjectionReducers<WorldState>;
  readonly traceDb: Database;
  readonly slotsDir: string;
  readonly statusRef: ServiceStatusRef;
  readonly externalQueue: ExternalQueue;
  readonly port?: number;
  readonly commitTick?: TickDeps["commitTick"];
}

export interface SimulationServerHandle {
  readonly port: number;
  broadcastFrame(): void;
  stop(force?: boolean): void;
}

interface WsData {
  readonly sessionId: SessionId;
}

const FRAME_TOPIC = "frame";
export const VERSION = "0.1.0";

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Starts the sidecar's authenticated HTTP server and WebSocket stream. */
export function createSimulationServer(
  options: SimulationServerOptions,
): SimulationServerHandle {
  const { store, reducers, traceDb, slotsDir, statusRef, externalQueue } =
    options;
  const eventSource = createEventSource(store);
  const receiptLimited = createReceiptLimiter();
  let host = "";

  const tickDeps: TickDeps = {
    store,
    reducers,
    traceDb,
    ...(options.commitTick ? { commitTick: options.commitTick } : {}),
  };

  const server = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(request, srv) {
      const guardFailure = checkRequestGuards(request, {
        token: options.token,
        host,
      });
      if (guardFailure) {
        return guardFailure;
      }

      const url = new URL(request.url);

      if (url.pathname === "/stream") {
        const sessionId = createSessionId();
        const upgraded = srv.upgrade(request, { data: { sessionId } });
        if (upgraded) {
          return undefined;
        }
        return new Response("Upgrade failed", { status: 400 });
      }

      return handleHttp(request, url).catch(
        (error) =>
          new Response(
            `Internal error: ${error instanceof Error ? error.message : String(error)}`,
            { status: 500 },
          ),
      );
    },
    websocket: {
      open(ws) {
        ws.subscribe(FRAME_TOPIC);
        const frame = buildFrame(store.worldId, ws.data.sessionId, statusRef);
        ws.send(JSON.stringify(frame));
      },
      message() {
        // The stream is publish-only from the service's side; the shell
        // never sends proposals or commands over it.
      },
      close(ws) {
        ws.unsubscribe(FRAME_TOPIC);
      },
    },
  });

  host = `127.0.0.1:${server.port}`;

  function publishFrame(): void {
    const sessionId = createSessionId();
    const frame = buildFrame(store.worldId, sessionId, statusRef);
    const sent = server.publish(FRAME_TOPIC, JSON.stringify(frame));
    if (sent < 0) {
      console.warn("panthea-simulation: frame broadcast backpressured");
    }
  }

  async function handleHttp(request: Request, url: URL): Promise<Response> {
    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({ ok: true, version: VERSION });
    }

    if (url.pathname === "/frame" && request.method === "GET") {
      const sessionId = createSessionId();
      return jsonResponse(buildFrame(store.worldId, sessionId, statusRef));
    }

    if (url.pathname === "/pause" && request.method === "POST") {
      return handlePause();
    }

    if (url.pathname === "/resume" && request.method === "POST") {
      return handleResume();
    }

    if (url.pathname === "/proposals" && request.method === "POST") {
      return handleProposal(request);
    }

    if (url.pathname === "/export" && request.method === "POST") {
      return handleExport(request);
    }

    if (url.pathname === "/import" && request.method === "POST") {
      return handleImportOrRestore(request);
    }

    if (url.pathname === "/restore" && request.method === "POST") {
      return handleImportOrRestore(request);
    }

    if (url.pathname === "/slots" && request.method === "GET") {
      const slots: readonly WorldSlot[] = listWorldSlots(slotsDir);
      return jsonResponse({ slots });
    }

    if (url.pathname === "/trace/event" && request.method === "GET") {
      return handleTraceEvent(url);
    }

    if (url.pathname === "/trace/proposal" && request.method === "GET") {
      return handleTraceProposal(url);
    }

    if (url.pathname === "/receipts" && request.method === "POST") {
      return handleReceipt(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  function handlePause(): Response {
    const clock = readClock(store.db);
    if (clock.paused) {
      return jsonResponse({ ok: true, alreadyPaused: true });
    }
    const commit = commitWorldTick(tickDeps, [], {
      tick: clock.tick,
      simTimeMs: clock.simTimeMs,
      prngState: readPrngState(store.db),
      cursorWallMs: clock.cursorWallMs,
      paused: true,
    });
    if (!commit.ok) {
      statusRef.status = "degraded";
      statusRef.degradedReason = commit.reason;
      publishFrame();
      return jsonResponse({ ok: false, error: commit.message }, 500);
    }
    recordOperatorEvent(traceDb, "pause");
    statusRef.status = "paused";
    statusRef.degradedReason = undefined;
    publishFrame();
    return jsonResponse({ ok: true });
  }

  function handleResume(): Response {
    const clock = readClock(store.db);
    if (!clock.paused) {
      return jsonResponse({ ok: true, alreadyRunning: true });
    }
    const now = Date.now();
    const commit = commitWorldTick(tickDeps, [], {
      tick: clock.tick,
      simTimeMs: clock.simTimeMs,
      prngState: readPrngState(store.db),
      cursorWallMs: Math.max(clock.cursorWallMs, now),
      paused: false,
    });
    if (!commit.ok) {
      statusRef.status = "degraded";
      statusRef.degradedReason = commit.reason;
      publishFrame();
      return jsonResponse({ ok: false, error: commit.message }, 500);
    }
    recordOperatorEvent(traceDb, "resume");
    statusRef.status = "running";
    statusRef.degradedReason = undefined;
    publishFrame();
    return jsonResponse({ ok: true });
  }

  async function handleProposal(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("observation" in body) ||
      !("proposal" in body)
    ) {
      return jsonResponse(
        { ok: false, error: "expected { observation, proposal }" },
        400,
      );
    }
    const { observation: rawObservation, proposal: rawProposal } =
      body as Record<string, unknown>;
    const observationResult = parseObservationRecord(rawObservation);
    if (!observationResult.ok) {
      return jsonResponse({ ok: false, error: observationResult.message }, 400);
    }
    const intake = intakeProposal(store.db, rawProposal);
    if (!intake.ok) {
      return jsonResponse({ ok: false, error: intake.rejection.message }, 400);
    }
    if (intake.proposal.observationId !== observationResult.value.id) {
      return jsonResponse(
        {
          ok: false,
          error: "proposal.observationId does not match observation.id",
        },
        400,
      );
    }
    externalQueue.enqueue({
      id: createProposalId(),
      proposal: intake.proposal,
      observation: observationResult.value,
    });
    return jsonResponse({ ok: true, queued: true }, 202);
  }

  async function handleExport(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "invalid JSON body" }, 400);
    }
    const path =
      typeof body === "object" && body !== null && "path" in body
        ? (body as { path: unknown }).path
        : undefined;
    if (typeof path !== "string" || path.length === 0) {
      return jsonResponse({ ok: false, error: "expected { path }" }, 400);
    }
    try {
      const manifest: ArchiveManifest = exportArchive(store, path);
      return jsonResponse({ ok: true, manifest });
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  }

  async function handleImportOrRestore(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "invalid JSON body" }, 400);
    }
    const archivePath =
      typeof body === "object" && body !== null && "archivePath" in body
        ? (body as { archivePath: unknown }).archivePath
        : undefined;
    if (typeof archivePath !== "string" || archivePath.length === 0) {
      return jsonResponse(
        { ok: false, error: "expected { archivePath }" },
        400,
      );
    }
    try {
      const result = importWorldArchive(
        archivePath,
        slotsDir,
        worldProjectionCodec,
      );
      return jsonResponse({ ok: true, result });
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        422,
      );
    }
  }

  function handleTraceEvent(url: URL): Response {
    const raw = url.searchParams.get("id");
    const parsed = raw === null ? undefined : parseEventId(raw, "id");
    if (!parsed || !parsed.ok) {
      return jsonResponse({ ok: false, error: "expected ?id=<EventId>" }, 400);
    }
    const result = followEvent(traceDb, eventSource, parsed.value);
    return jsonResponse({ ok: true, result });
  }

  function handleTraceProposal(url: URL): Response {
    const raw = url.searchParams.get("id");
    const parsed = raw === null ? undefined : parseProposalId(raw, "id");
    if (!parsed || !parsed.ok) {
      return jsonResponse(
        { ok: false, error: "expected ?id=<ProposalId>" },
        400,
      );
    }
    const result = followProposal(traceDb, eventSource, parsed.value);
    return jsonResponse({ ok: true, result });
  }

  async function handleReceipt(request: Request): Promise<Response> {
    if (receiptLimited(Date.now())) {
      return jsonResponse({ ok: false, error: "rate limited" }, 429);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("eventId" in body) ||
      !("sessionId" in body)
    ) {
      return jsonResponse(
        { ok: false, error: "expected { eventId, sessionId }" },
        400,
      );
    }
    const { eventId: rawEventId, sessionId: rawSessionId } = body as Record<
      string,
      unknown
    >;
    const eventId = parseEventId(rawEventId, "eventId");
    if (!eventId.ok) {
      return jsonResponse({ ok: false, error: eventId.message }, 400);
    }
    const sessionId = parseSessionId(rawSessionId, "sessionId");
    if (!sessionId.ok) {
      return jsonResponse({ ok: false, error: sessionId.message }, 400);
    }
    try {
      recordReceipt(traceDb, eventSource, {
        eventId: eventId.value,
        sessionId: sessionId.value,
      });
      return jsonResponse({ ok: true });
    } catch (error) {
      if (error instanceof UnknownEventError) {
        return jsonResponse({ ok: false, error: "unknown event" }, 404);
      }
      throw error;
    }
  }

  return {
    port: server.port ?? 0,
    broadcastFrame: publishFrame,
    stop(force = false) {
      server.stop(force);
    },
  };
}
