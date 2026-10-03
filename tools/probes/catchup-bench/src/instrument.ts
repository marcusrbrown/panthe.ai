// Measurement seams that live entirely in the benchmark: nothing here is
// imported by production code, and no production code is edited to be timed.
//
// - `instrumentDb` wraps a bun:sqlite Database so every statement's wall time
//   is added to a category chosen from its SQL text, and the transaction's own
//   body is timed apart from its BEGIN and COMMIT.
// - `instrumentReducers` times the projection reducer and codec, which the
//   persistence layer takes as injected functions.
// - `timeLargeJson` times only JSON.parse / JSON.stringify calls that touch a
//   projection-sized string, which is where the projection is read and written.

import type { Database, Statement } from "bun:sqlite";
import type { ProjectionReducers } from "@panthea/persistence";
import type { Phases } from "./phases";

/** The category a statement's time is added to. */
export function categoryOf(sql: string): string {
  const text = sql.trimStart();
  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(text)) {
    return "sql:transaction-control";
  }
  if (/\bevents\b/.test(text)) return "sql:events";
  if (/\bprojections\b/.test(text)) return "sql:projection";
  if (/\btrace_/.test(text)) return "sql:trace";
  return "sql:other";
}

const STATEMENT_METHODS = ["get", "all", "run", "values", "iterate"] as const;

function timedStatement(
  statement: Statement,
  category: string,
  phases: Phases,
): Statement {
  return new Proxy(statement, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if ((STATEMENT_METHODS as readonly (string | symbol)[]).includes(prop)) {
        return (...args: unknown[]) =>
          phases.time(category, () =>
            (value as (...a: unknown[]) => unknown).apply(target, args),
          );
      }
      return value.bind(target);
    },
  });
}

/**
 * `db`, with every statement timed. A transaction body is timed as
 * `tx:body` and the whole `.immediate()` call as `tx:total`, so the cost of
 * committing is the difference.
 */
export function instrumentDb(db: Database, phases: Phases): Database {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "run") {
        return (sql: string, ...rest: unknown[]) =>
          phases.time(categoryOf(sql), () => target.run(sql, ...(rest as [])));
      }
      if (prop === "query" || prop === "prepare") {
        return (sql: string) =>
          timedStatement(
            (value as (s: string) => Statement).call(target, sql),
            categoryOf(sql),
            phases,
          );
      }
      if (prop === "exec") {
        return (sql: string) =>
          phases.time(categoryOf(sql), () => target.exec(sql));
      }
      if (prop === "transaction") {
        return (body: () => unknown) => {
          const timedBody = () => phases.time("tx:body", body);
          const tx = target.transaction(timedBody);
          const wrap = (run: () => unknown) => phases.time("tx:total", run);
          const wrapped = (() => wrap(() => tx())) as typeof tx;
          wrapped.immediate = (() => wrap(() => tx.immediate())) as typeof tx;
          wrapped.deferred = (() => wrap(() => tx.deferred())) as typeof tx;
          wrapped.exclusive = (() => wrap(() => tx.exclusive())) as typeof tx;
          return wrapped;
        };
      }
      return value.bind(target);
    },
  });
}

/** `reducers`, with the event reducer and the projection codec timed. */
export function instrumentReducers<T>(
  reducers: ProjectionReducers<T>,
  phases: Phases,
): ProjectionReducers<T> {
  return {
    initial: reducers.initial,
    applyEvent: (projections, event) =>
      phases.time("reduce:applyEvent", () =>
        reducers.applyEvent(projections, event),
      ),
    codec: {
      encode: (projections) =>
        phases.time("codec:encode", () => reducers.codec.encode(projections)),
      decode: (value) =>
        phases.time("codec:decode", () => reducers.codec.decode(value)),
    },
  };
}

/** A string at least this long is a projection, not an event or a trace row. */
export const LARGE_JSON_CHARS = 64 * 1024;

/**
 * Times JSON.parse and JSON.stringify calls that handle a projection-sized
 * string, and returns the function that puts the originals back. Every call
 * still pays two clock reads, which is part of the instrumentation's own cost
 * (reported by comparing an instrumented run with a plain one).
 */
export function timeLargeJson(phases: Phases): () => void {
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  JSON.parse = ((text: string, reviver?: never) => {
    if (typeof text !== "string" || text.length < LARGE_JSON_CHARS) {
      return parse(text, reviver);
    }
    return phases.time("json:parse-large", () => parse(text, reviver));
  }) as typeof JSON.parse;
  JSON.stringify = ((value: unknown, replacer?: never, space?: never) => {
    const start = performance.now();
    const out = stringify(value, replacer, space) as string | undefined;
    if (typeof out === "string" && out.length >= LARGE_JSON_CHARS) {
      phases.add("json:stringify-large", performance.now() - start);
    }
    return out;
  }) as typeof JSON.stringify;
  return () => {
    JSON.parse = parse;
    JSON.stringify = stringify;
  };
}
