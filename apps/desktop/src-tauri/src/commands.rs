// Invoke commands exposed to the main window's webview: subscribing to
// the frame stream and relaying a presentation receipt. No other
// command is reachable from the renderer (see capabilities/proxy.json).

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::state::SidecarState;

/// Stores `frames` as the subscribed Channel; a resubscribe (e.g. after
/// the webview reloads) replaces whatever channel was stored before.
/// Pushed to on every subsequent poll by the proxy's poll task -- but if
/// a frame has already been polled, that cached frame is sent right
/// away too, so a newly (re)subscribing webview sees the world's
/// current state immediately rather than waiting up to a second for the
/// next poll.
#[tauri::command]
pub fn subscribe_world(state: State<SidecarState>, frames: Channel<Value>) {
    let mut lifecycle = state
        .lifecycle
        .lock()
        .expect("sidecar state mutex poisoned");
    crate::proxy::apply_subscribe(&mut lifecycle, frames);
}

/// Relays a presentation receipt for `event_id`, attributed to the
/// current sidecar session. Fails if no sidecar session is active yet.
#[tauri::command]
pub async fn present_event(app: AppHandle, event_id: String) -> Result<(), String> {
    let (session, session_id) = {
        let state = app.state::<SidecarState>();
        let lifecycle = state
            .lifecycle
            .lock()
            .expect("sidecar state mutex poisoned");
        let session = lifecycle
            .session
            .clone()
            .ok_or_else(|| "no active sidecar session".to_string())?;
        let session_id = lifecycle
            .last_frame
            .as_ref()
            .map(|frame| frame.session_id.clone())
            .ok_or_else(|| "no frame received yet".to_string())?;
        (session, session_id)
    };
    crate::proxy::present_event(session.port, &session.token, &session_id, &event_id).await
}
