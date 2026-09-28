import type { WorldViewModel } from "../store";

export function rebuildAfterDeviceLoss(
  rebuild: () => WorldViewModel | undefined,
  replaceView: (view: WorldViewModel) => void,
): WorldViewModel | undefined {
  const view = rebuild();
  if (view) replaceView(view);
  return view;
}
