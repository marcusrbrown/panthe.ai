// Invoke commands exposed to the main window's webview: subscribing to
// the frame stream and relaying a presentation receipt. No other
// command is reachable from the renderer (see capabilities/proxy.json).

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::state::SidecarState;

/// Stores `frames` as the subscribed Channel; a resubscribe (e.g. after
/// the webview reloads) replaces whatever channel was stored before.
/// Pushed to by the proxy's poll task, never called directly here.
#[tauri::command]
pub fn subscribe_world(state: State<SidecarState>, frames: Channel<Value>) {
    *state.channel.lock().expect("sidecar state mutex poisoned") = Some(frames);
}

/// Relays a presentation receipt for `event_id`, attributed to the
/// current sidecar session. Fails if no sidecar session is active yet.
#[tauri::command]
pub async fn present_event(app: AppHandle, event_id: String) -> Result<(), String> {
    let session = app
        .state::<SidecarState>()
        .session
        .lock()
        .expect("sidecar state mutex poisoned")
        .clone()
        .ok_or_else(|| "no active sidecar session".to_string())?;
    let session_id = app
        .state::<SidecarState>()
        .last_frame
        .lock()
        .expect("sidecar state mutex poisoned")
        .as_ref()
        .map(|frame| frame.session_id.clone())
        .ok_or_else(|| "no frame received yet".to_string())?;
    crate::proxy::present_event(session.port, &session.token, &session_id, &event_id).await
}
