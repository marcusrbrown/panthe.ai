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
  createSessionId,
  type DegradedReason,
  eventSubjects,
  parseEventId,
  parseObservationRecord,
  parseSessionId,
  type RecentEvent,
  type SessionId,
  type SyncFrame,
  type WorldId,
  type WorldStatus,
} from "@panthea/contracts";
import {
  clearCatchUpProgress,
  type ExternalProposalEntry,
  exportArchive,
  getExternalProposal,
  insertExternalProposal,
  listEvents,
  type ProjectionReducers,
  readClock,
  readPrngState,
  type Store,
} from "@panthea/persistence";
import {
  followEvent,
  followProposal,
  getProposalOutcomeByProposalId,
  type ProposalId,
  parseProposalId,
  recordReceipt,
  UnknownEventError,
} from "@panthea/telemetry";
import {
  DEFAULT_TICK_ELAPSED_MS,
  type PrngState,
  type WorldState,
} from "@panthea/world";
import type { CatchUpOutcome } from "./catchup";
import {
  applyOneTick,
  commitWorldTick,
  intakeProposal,
  mergeTickQueue,
  type QueuedProposal,
  readPendingExternalQueue,
  recordOperatorEvent,
  type TickDeps,
  type TickStepResult,
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

// --- Live tick -----------------------------------------------------------------

/**
 * Runs one live tick against the routine queue plus the pending entries of
 * the durable proposal journal. The journal is read by the tick itself, at
 * the tick number it is computing, and consumed in the same transaction that
 * commits the tick, so a tick that fails to commit leaves every entry
 * pending. An actor with an external proposal has its routine yield (see
 * `mergeTickQueue`).
 */
export function applyLiveTick(
  routineQueue: readonly QueuedProposal[],
  state: WorldState,
  prng: PrngState,
  deps: TickDeps,
  commit: { readonly cursorWallMs: number; readonly paused: boolean },
): TickStepResult {
  let external: QueuedProposal[];
  try {
    external = readPendingExternalQueue(deps.store.db, state.tick + 1);
  } catch (error) {
    return {
      kind: "store-error",
      reason: "store-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return applyOneTick(
    state,
    prng,
    mergeTickQueue(routineQueue, external),
    deps,
    commit,
  );
}

// --- Shared status, read by /frame and the WebSocket stream ------------------

/** Mutated by the tick loop and by pause/resume; read to build every `SyncFrame`. */
export interface ServiceStatusRef {
  status: WorldStatus;
  degradedReason?: DegradedReason;
  sequence: number;
  /** The tick of the state `sequence` and `encodedState` describe; the recent-event window is measured back from it. */
  tick: number;
  encodedState: unknown;
  catchUpSummary?: CatchUpSummary;
}

export function createServiceStatusRef(state: WorldState): ServiceStatusRef {
  return {
    status: "running",
    sequence: state.lastSequence,
    tick: state.tick,
    encodedState: worldProjectionCodec.encode(state),
  };
}

/**
 * Updates `ref` from `state`, deriving `status` from `options.paused`
 * rather than assuming "running" -- a caller that just finished a
 * catch-up run (or any other operation that can leave the world paused)
 * must pass the persisted clock's actual `paused` flag, or a mid-run
 * pause would be silently reported as running.
 *
 * A catch-up summary, stamped with the sequence `state` finished at, stays
 * on every later frame until another catch-up's summary replaces it; an
 * ordinary update never clears it.
 */
export function updateServiceStatus(
  ref: ServiceStatusRef,
  state: WorldState,
  options: {
    readonly catchUpSummary?: CatchUpOutcome;
    readonly paused?: boolean;
  } = {},
): void {
  ref.status = options.paused ? "paused" : "running";
  ref.degradedReason = undefined;
  ref.sequence = state.lastSequence;
  ref.tick = state.tick;
  ref.encodedState = worldProjectionCodec.encode(state);
  if (options.catchUpSummary) {
    ref.catchUpSummary = {
      ...options.catchUpSummary,
      atSequence: state.lastSequence,
    };
  }
}

/** How many ticks back from the frame's tick the recent-event window reaches. */
export const RECENT_EVENT_WINDOW_TICKS = 10;

/** The most events a frame's recent-event window ever carries; the newest win when a busy window exceeds it. */
export const RECENT_EVENT_CAP = 200;

/**
 * The committed events a frame carries so a client can receipt what it
 * renders: the events of the last `windowTicks` ticks up to and including
 * `currentTick`, at most `cap` of them (the newest), ascending by sequence.
 * Events after `throughSequence` are excluded, so the window always
 * matches the state the same frame reports. An event's tick is its
 * simulated time divided by the tick length, since every tick advances
 * simulated time by exactly that length.
 */
export function readRecentEvents(
  db: Database,
  throughSequence: number,
  currentTick: number,
  limits: { readonly windowTicks: number; readonly cap: number } = {
    windowTicks: RECENT_EVENT_WINDOW_TICKS,
    cap: RECENT_EVENT_CAP,
  },
): readonly RecentEvent[] {
  const oldestTick = currentTick - limits.windowTicks;
  // Sequences are contiguous across the whole log, so this range holds
  // exactly the newest `cap` events at or before `throughSequence`.
  const candidates = listEvents(db, {
    fromSequence: Math.max(0, throughSequence - limits.cap),
    toSequence: throughSequence,
  });
  const recent: RecentEvent[] = [];
  for (const event of candidates) {
    const tick = Math.round(event.simTime / DEFAULT_TICK_ELAPSED_MS);
    if (tick <= oldestTick) continue;
    recent.push({
      id: event.id,
      sequence: event.sequence,
      tick,
      kind: event.kind,
      subjects: eventSubjects(event),
    });
  }
  return recent;
}

function buildFrame(
  worldId: WorldId,
  sessionId: SessionId,
  ref: ServiceStatusRef,
  db: Database,
): SyncFrame {
  return {
    schemaVersion: 1,
    sequence: ref.sequence,
    worldId,
    sessionId,
    status: ref.status,
    ...(ref.degradedReason ? { degradedReason: ref.degradedReason } : {}),
    ...(ref.catchUpSummary ? { catchUpSummary: ref.catchUpSummary } : {}),
    recentEvents: readRecentEvents(db, ref.sequence, ref.tick),
    state: ref.encodedState,
  };
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

/** Lets `/pause` cooperate with an in-progress catch-up run instead of racing its own commit against catch-up's chunk commits on the same store. */
export interface CatchUpControl {
  /** True while a catch-up run (startup or sleep-wake) is actively executing. */
  isRunning(): boolean;
  /** Requests that the in-progress catch-up stop at its next chunk boundary and persist paused. No-op if catch-up isn't currently running. */
  requestPause(): void;
}

const NOOP_CATCH_UP_CONTROL: CatchUpControl = {
  isRunning: () => false,
  requestPause: () => {
    // No catch-up run to cancel.
  },
};

export interface SimulationServerOptions {
  readonly token: string;
  readonly store: Store;
  readonly reducers: ProjectionReducers<WorldState>;
  readonly traceDb: Database;
  readonly slotsDir: string;
  readonly statusRef: ServiceStatusRef;
  readonly port?: number;
  readonly commitTick?: TickDeps["commitTick"];
  readonly catchUpControl?: CatchUpControl;
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
  const { store, reducers, traceDb, slotsDir, statusRef } = options;
  const catchUpControl = options.catchUpControl ?? NOOP_CATCH_UP_CONTROL;
  const eventSource = createEventSource(store);
  const receiptLimited = createReceiptLimiter();
  // One session identity for this launch's whole lifetime -- reused by
  // every broadcast, `/frame` response, and WS connection until restart,
  // never re-minted per request or per connection.
  const sessionId = createSessionId();
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
        const frame = buildFrame(
          store.worldId,
          ws.data.sessionId,
          statusRef,
          store.db,
        );
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
    const frame = buildFrame(store.worldId, sessionId, statusRef, store.db);
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
      return jsonResponse(
        buildFrame(store.worldId, sessionId, statusRef, store.db),
      );
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
    if (catchUpControl.isRunning()) {
      // A catch-up run is actively committing chunks against this same
      // store; requesting our own commit here would race it. Ask
      // catch-up itself to stop at its next chunk boundary and persist
      // paused (with its own operator observation, in the same
      // transaction) -- it owns that commit. 202 (not 200): the request
      // is accepted, not yet in effect, and that commit can itself still
      // fail; the caller reads the actual outcome from `/frame` or
      // status once catch-up reaches the boundary.
      catchUpControl.requestPause();
      return jsonResponse({ ok: true, pausingAtNextChunk: true }, 202);
    }
    const clock = readClock(store.db);
    if (clock.paused) {
      return jsonResponse({ ok: true, alreadyPaused: true });
    }
    const commit = commitWorldTick(
      tickDeps,
      [],
      {
        tick: clock.tick,
        simTimeMs: clock.simTimeMs,
        prngState: readPrngState(store.db),
        cursorWallMs: clock.cursorWallMs,
        paused: true,
      },
      [],
      recordOperatorEvent("pause"),
    );
    if (!commit.ok) {
      statusRef.status = "degraded";
      statusRef.degradedReason = commit.reason;
      publishFrame();
      return jsonResponse({ ok: false, error: commit.message }, 500);
    }
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
    const commit = commitWorldTick(
      tickDeps,
      [],
      {
        tick: clock.tick,
        simTimeMs: clock.simTimeMs,
        prngState: readPrngState(store.db),
        cursorWallMs: Math.max(clock.cursorWallMs, now),
        paused: false,
      },
      [],
      (db) => {
        recordOperatorEvent("resume")(db);
        // The paused interval is discarded, never caught up, so a backlog
        // left unfinished before the pause ends here.
        clearCatchUpProgress(db);
      },
    );
    if (!commit.ok) {
      statusRef.status = "degraded";
      statusRef.degradedReason = commit.reason;
      publishFrame();
      return jsonResponse({ ok: false, error: commit.message }, 500);
    }
    statusRef.status = "running";
    statusRef.degradedReason = undefined;
    publishFrame();
    return jsonResponse({ ok: true });
  }

  /** The journaled status of a proposal: pending, or the terminal outcome the trace recorded. A consumed entry with no outcome is corruption. */
  function journalStatus(entry: ExternalProposalEntry): Response {
    if (entry.consumedTick === undefined) {
      return jsonResponse(
        {
          ok: true,
          queued: true,
          proposalId: entry.proposalId,
          status: "pending",
        },
        202,
      );
    }
    const outcome = getProposalOutcomeByProposalId(
      traceDb,
      entry.proposalId as ProposalId,
    );
    if (!outcome) {
      return jsonResponse(
        {
          ok: false,
          error: `proposal ${entry.proposalId} was consumed at tick ${entry.consumedTick} but has no recorded outcome`,
        },
        500,
      );
    }
    return jsonResponse({
      ok: true,
      queued: false,
      proposalId: entry.proposalId,
      status: outcome.outcome,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    });
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
      !("proposalId" in body) ||
      !("observation" in body) ||
      !("proposal" in body)
    ) {
      return jsonResponse(
        { ok: false, error: "expected { proposalId, observation, proposal }" },
        400,
      );
    }
    const {
      proposalId: rawProposalId,
      observation: rawObservation,
      proposal: rawProposal,
    } = body as Record<string, unknown>;
    const proposalId = parseProposalId(rawProposalId, "proposalId");
    if (!proposalId.ok) {
      return jsonResponse({ ok: false, error: proposalId.message }, 400);
    }
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

    let result: ReturnType<typeof insertExternalProposal>;
    try {
      // An id the trace already holds for a proposal this journal never
      // accepted (a routine's) would have its outcome silently dropped.
      if (
        getExternalProposal(store.db, proposalId.value) === undefined &&
        getProposalOutcomeByProposalId(traceDb, proposalId.value) !== undefined
      ) {
        return jsonResponse(
          {
            ok: false,
            error: `proposalId ${proposalId.value} is already in use`,
          },
          409,
        );
      }
      result = insertExternalProposal(store.db, {
        proposalId: proposalId.value,
        proposal: intake.proposal,
        observation: observationResult.value,
      });
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: `could not journal the proposal: ${error instanceof Error ? error.message : String(error)}`,
        },
        500,
      );
    }
    if (result.kind === "conflict") {
      return jsonResponse(
        {
          ok: false,
          error: `proposalId ${proposalId.value} was already accepted with different content`,
        },
        409,
      );
    }
    return journalStatus(result.entry);
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
