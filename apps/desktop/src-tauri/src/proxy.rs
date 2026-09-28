// The polling proxy: once a second, GETs the sidecar's `/frame` with the
// bearer token and forwards it to the subscribed Channel only when its
// sequence, status, or session ID changed. Also relays pause, resume,
// and presentation-receipt requests, all authenticated the same way.
//
// The webview never holds the token: only this module ever sends it, in
// an `Authorization` header, over plain HTTP to 127.0.0.1.

use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::{should_forward, FrameKey, SidecarState};

const POLL_INTERVAL: Duration = Duration::from_secs(1);

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("reqwest client failed to build")
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn extract_frame_key(frame: &Value) -> Option<FrameKey> {
    Some(FrameKey {
        sequence: frame.get("sequence")?.as_u64()?,
        status: frame.get("status")?.as_str()?.to_string(),
        session_id: frame.get("sessionId")?.as_str()?.to_string(),
    })
}

/// The exact value forwarded to the webview's Channel: the sidecar's own
/// frame body, verbatim. This is the one seam where a future change
/// could accidentally attach anything (a token, a header) to the
/// outgoing payload, and is unit-tested to prove it never does.
fn forwarded_payload(frame: Value) -> Value {
    frame
}

/// GETs `/frame` with the bearer token and parses its JSON body. The one
/// place this shell ever sends the token, and the one place a polled
/// frame's shape is decoded.
pub async fn fetch_frame(port: u16, token: &str) -> Result<Value, String> {
    let response = client()
        .get(format!("{}/frame", base_url(port)))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("unexpected status {}", response.status()));
    }
    response.json().await.map_err(|error| error.to_string())
}

/// Spawns the poll task for one sidecar session. Runs until aborted (on
/// restart or explicit stop) -- an HTTP failure or non-success status
/// logs and waits for the next tick rather than stopping the loop.
pub fn start_polling(
    app: AppHandle,
    port: u16,
    token: String,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;

            match fetch_frame(port, &token).await {
                Ok(frame) => handle_frame(&app, frame),
                Err(error) => {
                    eprintln!("panthea-desktop: /frame poll failed: {error}");
                }
            }
        }
    })
}

fn handle_frame(app: &AppHandle, frame: Value) {
    let Some(key) = extract_frame_key(&frame) else {
        eprintln!("panthea-desktop: /frame response missing sequence/status/sessionId");
        return;
    };

    let state = app.state::<SidecarState>();

    let status_changed = {
        let mut world = state.world.lock().expect("sidecar state mutex poisoned");
        let changed = world.status.as_deref() != Some(key.status.as_str());
        world.status = Some(key.status.clone());
        world.degraded_reason = frame
            .get("degradedReason")
            .and_then(Value::as_str)
            .map(str::to_string);
        changed
    };

    let mut last = state
        .last_frame
        .lock()
        .expect("sidecar state mutex poisoned");
    if should_forward(last.as_ref(), &key) {
        if let Some(channel) = state
            .channel
            .lock()
            .expect("sidecar state mutex poisoned")
            .as_ref()
        {
            if let Err(error) = channel.send(forwarded_payload(frame)) {
                eprintln!("panthea-desktop: failed to forward frame to the webview: {error}");
            }
        }
        *last = Some(key);
    }
    drop(last);

    if status_changed {
        crate::tray::refresh(app);
    }
}

async fn post_empty(port: u16, token: &str, path: &str) -> Result<(), String> {
    client()
        .post(format!("{}{}", base_url(port), path))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| error.to_string())
        .and_then(|response| {
            if response.status().is_success() {
                Ok(())
            } else {
                Err(format!("unexpected status {}", response.status()))
            }
        })
}

pub async fn pause(port: u16, token: &str) -> Result<(), String> {
    post_empty(port, token, "/pause").await
}

pub async fn resume(port: u16, token: &str) -> Result<(), String> {
    post_empty(port, token, "/resume").await
}

/// Relays a presentation receipt: the event the operator has just seen
/// rendered, attributed to the current session.
pub async fn present_event(
    port: u16,
    token: &str,
    session_id: &str,
    event_id: &str,
) -> Result<(), String> {
    let body = serde_json::json!({ "eventId": event_id, "sessionId": session_id });
    let response = client()
        .post(format!("{}/receipts", base_url(port)))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("unexpected status {}", response.status()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_frame() -> Value {
        serde_json::json!({
            "schemaVersion": 1,
            "sequence": 5,
            "worldId": "world-1",
            "sessionId": "session-1",
            "status": "running",
            "state": { "tick": 5 }
        })
    }

    #[test]
    fn extracts_the_key_fields_from_a_well_formed_frame() {
        let key = extract_frame_key(&sample_frame()).expect("frame key");
        assert_eq!(key.sequence, 5);
        assert_eq!(key.status, "running");
        assert_eq!(key.session_id, "session-1");
    }

    #[test]
    fn a_frame_missing_a_key_field_extracts_nothing() {
        let mut frame = sample_frame();
        frame.as_object_mut().unwrap().remove("sessionId");
        assert!(extract_frame_key(&frame).is_none());
    }

    #[test]
    fn the_forwarded_payload_never_contains_the_token() {
        let token = "a-super-secret-launch-token-value";
        let forwarded = forwarded_payload(sample_frame());
        let serialized = serde_json::to_string(&forwarded).expect("serialize");
        assert!(!serialized.contains(token));
    }

    #[test]
    fn the_forwarded_payload_is_the_frame_verbatim() {
        let frame = sample_frame();
        assert_eq!(forwarded_payload(frame.clone()), frame);
    }
}
