// Presentation receipts: one relay per event id per session, for events the
// renderer actually drew. The dedup set belongs to one session and resets
// when the session id changes. A failed relay is reported through
// `onError` and never retried automatically; the caller may present the
// same event again, which relays it again.

export interface ReceiptError {
  readonly sessionId: string;
  readonly eventId: string;
  readonly message: string;
}

export type ReceiptResult = "sent" | "duplicate" | "failed";

export interface ReceiptEmitter {
  present(sessionId: string, eventId: string): Promise<ReceiptResult>;
}

export interface ReceiptEmitterDeps {
  presentEvent(eventId: string): Promise<void>;
  onError(error: ReceiptError): void;
}

export function createReceiptEmitter(deps: ReceiptEmitterDeps): ReceiptEmitter {
  let sessionId: string | undefined;
  let attempted = new Set<string>();

  return {
    async present(nextSessionId, eventId) {
      if (nextSessionId !== sessionId) {
        sessionId = nextSessionId;
        attempted = new Set();
      }
      if (attempted.has(eventId)) {
        return "duplicate";
      }
      const forSession = attempted;
      forSession.add(eventId);

      try {
        await deps.presentEvent(eventId);
        return "sent";
      } catch (error) {
        // Unmark only inside the session set this attempt started in, so a
        // late failure from an earlier session never touches a later one.
        forSession.delete(eventId);
        deps.onError({
          sessionId: nextSessionId,
          eventId,
          message: error instanceof Error ? error.message : String(error),
        });
        return "failed";
      }
    },
  };
}
