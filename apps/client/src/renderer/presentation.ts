import type { RecentEvent } from "@panthea/contracts";
import type { ReceiptEmitter } from "../receipts";
import type { WorldViewModel } from "../store";

const DRAWN_EVENT_KINDS = ["strike", "fire", "ignit", "trade", "worship"];

export function drawableEvents(
  view: WorldViewModel,
  _realm: string,
): readonly RecentEvent[] {
  return view.recentEvents.filter((event) => {
    const kind = String(event.kind).toLowerCase();
    return DRAWN_EVENT_KINDS.some((marker) => kind.includes(marker));
  });
}

export async function receiptDrawnEvents(
  sessionId: string,
  events: readonly Pick<RecentEvent, "id">[],
  emitter: ReceiptEmitter,
): Promise<void> {
  await Promise.all(
    events.map((event) => emitter.present(sessionId, event.id)),
  );
}
