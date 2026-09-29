// Direct reads of the active world's SQLite store, for the facts no endpoint
// exposes. Each accessor names why it cannot be an API call. A fact a live
// sidecar already serves (the tick and sequence in /frame, a proposal's status
// on retry, an event's chain and receipts in /trace/*) is read through
// `api.ts`, not here.

import type { Database } from "bun:sqlite";
import {
  activeStorePath,
  type CatchUpProgressRow,
  type ClockRow,
  type EventRow,
  hashEventPrefix,
  integrityCheck,
  type JournalRow,
  operatorObservationExists,
  type ReceiptWithKind,
  readCatchUpProgressRow,
  readClockRow,
  readEventRows,
  readJournal,
  readMaxSequence,
  readObservationSources,
  readReceiptsWithKinds,
  withWorldDb,
} from "../world-db";
import type { Story } from "./context";

const activeDb = <T>(story: Story, fn: (db: Database) => T): T =>
  withWorldDb(activeStorePath(story.dataDir), fn);

/** Direct read: event payloads, correlation ids, and the approximate flag are in no endpoint (/frame's recent events carry only kind and subjects, for ten ticks). */
export const eventsOf = (story: Story, fromSequence = 1): EventRow[] =>
  activeDb(story, (db) => readEventRows(db, fromSequence));

/** Direct read: the persisted clock row (wall cursor, paused flag). /frame carries neither, and a stopped or killed sidecar serves nothing. */
export const persistedClock = (story: Story): ClockRow =>
  activeDb(story, readClockRow);

/** Direct read: the highest committed event sequence while the sidecar is stopped or killed, when /frame is unavailable. */
export const maxSequenceOnDisk = (story: Story): number =>
  activeDb(story, readMaxSequence);

/** Direct read: observation counts by source; the trace endpoints follow one event or proposal and none aggregates. */
export const observationSources = (story: Story): Record<string, number> =>
  activeDb(story, readObservationSources);

/** Direct read: whether an operator observation names a fact; no endpoint lists observations. */
export const operatorObservationOn = (story: Story, fact: string): boolean =>
  activeDb(story, (db) => operatorObservationExists(db, fact));

/** Direct read: SQLite's own integrity check, which no endpoint runs. */
export const integrityOf = (story: Story): string =>
  activeDb(story, integrityCheck);

/** Direct read: every stored presentation receipt with its event's kind; /trace/event answers per event and none lists them. */
export const storedReceipts = (story: Story): ReceiptWithKind[] =>
  activeDb(story, readReceiptsWithKinds);

/** Direct read: a digest of the stored event payloads through `throughSequence`, to compare against another store's; no endpoint serves payloads. */
export const historyDigestOf = (
  story: Story,
  throughSequence: number,
): string => activeDb(story, (db) => hashEventPrefix(db, throughSequence));

/** Direct read: the proposal journal (consumed tick, persisted outcome); only a retry's status is served. */
export const journalOf = (story: Story): JournalRow[] =>
  activeDb(story, readJournal);

/** Direct read: an unfinished catch-up backlog's committed progress; no endpoint serves it. */
export const catchUpProgressOf = (
  story: Story,
): CatchUpProgressRow | undefined => activeDb(story, readCatchUpProgressRow);
