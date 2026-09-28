// The polling proxy: once a second, GETs the sidecar's `/frame` with the
// bearer token and forwards it to the subscribed Channel only when its
// sequence, status, or session ID changed. Also relays pause, resume,
// and presentation-receipt requests, all authenticated the same way.
//
// The webview never holds the token: only this module ever sends it, in
// an `Authorization` header, over plain HTTP to 127.0.0.1.

use std::time::Duration;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::state::{should_forward, FrameKey, FrameState, SidecarState};

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .expect("reqwest client failed to build")
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub(crate) fn extract_frame_key(frame: &Value) -> Option<FrameKey> {
    Some(FrameKey {
        sequence: frame.get("sequence")?.as_u64()?,
        status: frame.get("status")?.as_str()?.to_string(),
        session_id: frame.get("sessionId")?.as_str()?.to_string(),
    })
}

/// Given the cached last-polled frame body (if any), what a newly (or
/// re-)subscribing Channel should be sent immediately, and the key to
/// mark as last-forwarded once that send succeeds -- so the webview
/// never waits up to a second for the next poll to see the world's
/// current state, and a reload replays it again rather than waiting for
/// the next change.
pub(crate) fn replay_target(cached: Option<&Value>) -> Option<(Value, FrameKey)> {
    let body = cached?;
    let key = extract_frame_key(body)?;
    Some((body.clone(), key))
}

/// What handling a polled frame should do, or `None` to drop it
/// entirely (untouched state, no cache, no forward, no tray refresh).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrameDecision {
    pub(crate) forward: bool,
    pub(crate) refresh_tray: bool,
}

/// Decides how to handle one polled frame.
///
/// A frame whose `frame_generation` no longer matches the session
/// currently tracked (`current_generation`) is dropped entirely: a
/// restart bumps the generation, and a frame still in flight from the
/// previous session's poll loop (a task-cancellation race) must never
/// reach the webview or change any state.
///
/// For a current-generation frame: `forward` follows the existing
/// sequence/status/session-id change check; `refresh_tray` fires on
/// either a status change or a degraded-reason change, so a reason
/// changing while the status stays `"degraded"` still updates the label.
pub(crate) fn decide_frame_handling(
    current_generation: u64,
    frame_generation: u64,
    last_frame: Option<&FrameKey>,
    current_key: &FrameKey,
    previous_status: Option<&str>,
    previous_degraded_reason: Option<&str>,
    new_degraded_reason: Option<&str>,
) -> Option<FrameDecision> {
    if current_generation != frame_generation {
        return None;
    }
    let forward = should_forward(last_frame, current_key);
    let status_changed = previous_status != Some(current_key.status.as_str());
    let reason_changed = previous_degraded_reason != new_degraded_reason;
    Some(FrameDecision {
        forward,
        refresh_tray: status_changed || reason_changed,
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

/// Spawns the poll task for one sidecar session, tagged with
/// `generation` (the value `start_session` minted when this session
/// started) so every frame it hands to `handle_frame` can be checked
/// against whatever session is current by the time it arrives. Runs
/// until aborted (on restart or explicit stop) -- an HTTP failure or
/// non-success status logs and waits for the next tick rather than
/// stopping the loop.
pub fn start_polling(
    app: AppHandle,
    port: u16,
    token: String,
    generation: u64,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;

            match fetch_frame(port, &token).await {
                Ok(frame) => handle_frame(&app, frame, generation),
                Err(error) => {
                    eprintln!("panthea-desktop: /frame poll failed: {error}");
                }
            }
        }
    })
}

/// Applies one polled frame to `frame_state`: the generation check, the
/// forward/refresh decision, the world-status and cached-body update,
/// the channel send, and the last-forwarded mark, all under the
/// caller's single lock on `frame_state` -- so nothing else can observe
/// or land a change in the middle of handling one frame. Returns
/// whether the tray should be refreshed; the caller does that after
/// releasing the lock, since `tray::refresh` takes its own locks.
///
/// A stale-generation frame (`frame_generation` no longer matches
/// `frame_state.generation`) leaves every field of `frame_state`
/// untouched and returns `false`.
pub(crate) fn apply_frame(
    frame_state: &mut FrameState,
    frame: Value,
    frame_generation: u64,
) -> bool {
    let Some(key) = extract_frame_key(&frame) else {
        eprintln!("panthea-desktop: /frame response missing sequence/status/sessionId");
        return false;
    };
    let new_degraded_reason = frame
        .get("degradedReason")
        .and_then(Value::as_str)
        .map(str::to_string);

    let decision = decide_frame_handling(
        frame_state.generation,
        frame_generation,
        frame_state.last_frame.as_ref(),
        &key,
        frame_state.world.status.as_deref(),
        frame_state.world.degraded_reason.as_deref(),
        new_degraded_reason.as_deref(),
    );
    let Some(decision) = decision else {
        return false;
    };

    frame_state.world.status = Some(key.status.clone());
    frame_state.world.degraded_reason = new_degraded_reason;
    frame_state.last_frame_body = Some(frame.clone());

    if decision.forward {
        if let Some(channel) = frame_state.channel.as_ref() {
            match channel.send(forwarded_payload(frame)) {
                Ok(()) => {
                    frame_state.last_frame = Some(key);
                }
                Err(error) => {
                    eprintln!("panthea-desktop: failed to forward frame to the webview: {error}");
                }
            }
        }
    }

    decision.refresh_tray
}

/// Installs `frames` as the subscribed channel and, if a frame has ever
/// been cached, replays it immediately -- all under the caller's single
/// lock on `frame_state`, so a poll landing between the replay and the
/// channel install can never be missed or delivered twice.
pub(crate) fn apply_subscribe(frame_state: &mut FrameState, frames: Channel<Value>) {
    if let Some((body, key)) = replay_target(frame_state.last_frame_body.as_ref()) {
        match frames.send(body) {
            Ok(()) => {
                frame_state.last_frame = Some(key);
            }
            Err(error) => {
                eprintln!(
                    "panthea-desktop: failed to replay the cached frame to a new subscriber: {error}"
                );
            }
        }
    }
    frame_state.channel = Some(frames);
}

fn handle_frame(app: &AppHandle, frame: Value, frame_generation: u64) {
    let state = app.state::<SidecarState>();
    let refresh_tray = {
        let mut frame_state = state.frame.lock().expect("sidecar state mutex poisoned");
        apply_frame(&mut frame_state, frame, frame_generation)
    };

    if refresh_tray {
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
    use std::sync::{Arc, Mutex};

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

    fn key(sequence: u64, status: &str, session_id: &str) -> FrameKey {
        FrameKey {
            sequence,
            status: status.to_string(),
            session_id: session_id.to_string(),
        }
    }

    #[test]
    fn nothing_cached_has_nothing_to_replay() {
        assert!(replay_target(None).is_none());
    }

    #[test]
    fn a_cached_frame_replays_its_body_and_extracted_key() {
        let frame = sample_frame();
        let (body, replayed_key) = replay_target(Some(&frame)).expect("replay target");
        assert_eq!(body, frame);
        assert_eq!(replayed_key.sequence, 5);
        assert_eq!(replayed_key.session_id, "session-1");
    }

    #[test]
    fn a_malformed_cached_frame_has_nothing_to_replay() {
        let malformed = serde_json::json!({ "not": "a real frame" });
        assert!(replay_target(Some(&malformed)).is_none());
    }

    #[test]
    fn a_stale_generation_drops_the_frame_entirely() {
        let previous = key(1, "running", "s1");
        let current = key(2, "running", "s1");
        let decision =
            decide_frame_handling(2, 1, Some(&previous), &current, Some("running"), None, None);
        assert!(decision.is_none());
    }

    #[test]
    fn a_current_generation_with_no_status_or_reason_change_forwards_without_refreshing_the_tray() {
        let previous = key(3, "running", "s1");
        let current = key(4, "running", "s1");
        let decision =
            decide_frame_handling(1, 1, Some(&previous), &current, Some("running"), None, None)
                .expect("decision");
        assert!(decision.forward);
        assert!(!decision.refresh_tray);
    }

    #[test]
    fn a_status_change_refreshes_the_tray() {
        let previous = key(1, "running", "s1");
        let current = key(2, "paused", "s1");
        let decision =
            decide_frame_handling(1, 1, Some(&previous), &current, Some("running"), None, None)
                .expect("decision");
        assert!(decision.refresh_tray);
    }

    #[test]
    fn a_degraded_reason_change_with_an_unchanged_status_still_refreshes_the_tray() {
        let previous = key(3, "degraded", "s1");
        let current = key(4, "degraded", "s1");
        let decision = decide_frame_handling(
            1,
            1,
            Some(&previous),
            &current,
            Some("degraded"),
            Some("disk-full"),
            Some("store-error"),
        )
        .expect("decision");
        assert!(decision.refresh_tray);
    }

    #[test]
    fn an_identical_frame_does_not_forward_or_refresh_the_tray() {
        let frame = key(5, "running", "s1");
        let decision =
            decide_frame_handling(1, 1, Some(&frame), &frame, Some("running"), None, None)
                .expect("decision");
        assert!(!decision.forward);
        assert!(!decision.refresh_tray);
    }

    #[test]
    fn a_request_to_a_server_that_never_responds_times_out_well_under_five_seconds() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let port = listener.local_addr().expect("local addr").port();
        std::thread::spawn(move || {
            // Accept and hold the connection open without ever writing a
            // response, so the client's own timeout is what ends the call.
            if let Ok((stream, _)) = listener.accept() {
                std::thread::sleep(Duration::from_secs(30));
                drop(stream);
            }
        });

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let started = std::time::Instant::now();
        let result = runtime.block_on(fetch_frame(port, "a-token"));
        let elapsed = started.elapsed();

        assert!(result.is_err());
        assert!(
            elapsed < Duration::from_secs(5),
            "fetch_frame took {elapsed:?}, expected it to time out well under 5s"
        );
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

    #[test]
    fn a_stale_generation_leaves_frame_state_untouched_and_a_subscribe_then_handle_sequence_delivers_in_order_with_no_stale_replay(
    ) {
        let mut state = FrameState {
            generation: 2,
            ..Default::default()
        };

        // A frame tagged with a superseded generation is dropped
        // entirely -- every field of FrameState stays exactly as it was.
        let stale = serde_json::json!({ "sequence": 99, "status": "running", "sessionId": "old" });
        let refreshed = apply_frame(&mut state, stale, 1);
        assert!(!refreshed);
        assert_eq!(state.generation, 2);
        assert_eq!(state.last_frame, None);
        assert_eq!(state.last_frame_body, None);
        assert_eq!(state.world, Default::default());

        // A frame for the current generation lands before any
        // subscriber exists: cached, but nothing to deliver yet.
        let frame1 = serde_json::json!({ "sequence": 1, "status": "running", "sessionId": "s2" });
        apply_frame(&mut state, frame1.clone(), 2);
        assert_eq!(state.last_frame_body, Some(frame1.clone()));

        // A subscriber now arrives: it receives exactly that cached
        // frame immediately, not anything from before the generation
        // bump.
        let delivered = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = delivered.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                if let Ok(value) = serde_json::from_str::<Value>(&json) {
                    sink.lock().expect("delivered mutex poisoned").push(value);
                }
            }
            Ok(())
        });
        apply_subscribe(&mut state, channel);

        // The next two polled frames are forwarded in sequence order.
        let frame2 = serde_json::json!({ "sequence": 2, "status": "running", "sessionId": "s2" });
        let frame3 = serde_json::json!({ "sequence": 3, "status": "paused", "sessionId": "s2" });
        apply_frame(&mut state, frame2.clone(), 2);
        apply_frame(&mut state, frame3.clone(), 2);

        let received = delivered.lock().expect("delivered mutex poisoned");
        assert_eq!(*received, vec![frame1, frame2, frame3]);
    }
}
