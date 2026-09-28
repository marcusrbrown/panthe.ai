// Shared state for the sidecar supervisor, the HTTP proxy, and the tray:
// the tracked child process, restart bookkeeping, the active session's
// port and token, the subscribed Channel, the last frame forwarded (for
// change detection), and the world's last reported status.

use std::sync::Mutex;

use tauri::ipc::Channel;
use tauri::tray::TrayIcon;
use tauri_plugin_shell::process::CommandChild;

/// The change-detection key extracted from a polled `/frame` response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameKey {
    pub sequence: u64,
    pub status: String,
    pub session_id: String,
}

/// True if `current` differs from `previous` in sequence, status, or
/// session ID -- the only fields that decide whether a polled frame is
/// worth forwarding to the webview. No previous frame (the first poll of
/// a session) always forwards.
pub fn should_forward(previous: Option<&FrameKey>, current: &FrameKey) -> bool {
    match previous {
        None => true,
        Some(previous) => previous != current,
    }
}

/// The currently active sidecar session's connection details: the port
/// and token discovered from its `PANTHEA_PORT` stdout line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarSession {
    pub port: u16,
    pub token: String,
}

/// A sidecar session's connection lifecycle: discovering a fresh port
/// always replaces whatever session was tracked before (never merges,
/// even across a rapid respawn); termination always clears it, even if a
/// session was never fully established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    PortDiscovered { token: String, port: u16 },
    Terminated,
}

pub fn transition_session(
    _current: Option<SidecarSession>,
    event: SessionEvent,
) -> Option<SidecarSession> {
    match event {
        SessionEvent::PortDiscovered { token, port } => Some(SidecarSession { port, token }),
        SessionEvent::Terminated => None,
    }
}

/// The sidecar's last reported world status and, when degraded, its
/// reason -- read by the tray to render its checked state and label.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorldStatusSnapshot {
    pub status: Option<String>,
    pub degraded_reason: Option<String>,
}

/// Everything a polled frame touches, behind one lock: the current
/// launch id, change-detection state, world status, and the subscribed
/// Channel. Consolidated into one struct (rather than several separate
/// mutexes) so a frame's launch-id check, decision, cache update,
/// forward, and last-forwarded mark all happen atomically -- and so
/// installing a Channel and replaying the cached frame to it happen
/// atomically too, with no gap a concurrent poll or restart can land in.
#[derive(Default)]
pub struct FrameState {
    /// Identifies the current sidecar launch attempt. Bumped by every
    /// spawn (`begin_launch`) and by every launch ending (`end_launch`
    /// -- termination, Stop Background, or restart-supervisor
    /// exhaustion). Anything belonging to a launch -- a poll task's
    /// frames, a child's Terminated/Error handling, a scheduled backoff
    /// retry -- captures this value when it starts and checks
    /// `is_current` before acting, so a callback that fires after its
    /// launch has ended becomes a no-op instead of touching whatever
    /// launch is current now.
    pub launch_id: u64,
    /// The last frame forwarded to the webview, for change detection.
    pub last_frame: Option<FrameKey>,
    /// The most recently polled frame's raw body, cached regardless of
    /// whether a subscriber was present to receive it -- replayed
    /// immediately to a newly (re)subscribing Channel.
    pub last_frame_body: Option<serde_json::Value>,
    pub world: WorldStatusSnapshot,
    /// The subscribed Channel; a resubscribe replaces it. Not reset by
    /// `begin_launch`/`end_launch` -- a subscribed webview stays
    /// subscribed across a sidecar restart.
    pub channel: Option<Channel<serde_json::Value>>,
}

/// True while `launch_id` is still the launch currently tracked by
/// `frame_state` -- false once a later spawn or a clear has bumped it
/// past that value.
pub fn is_current(frame_state: &FrameState, launch_id: u64) -> bool {
    frame_state.launch_id == launch_id
}

/// Starts a new launch: bumps the id and resets the fields a new launch
/// should start fresh with (change-detection state and world status).
/// Returns the new id for the caller to capture and carry through
/// everything that belongs to this launch.
pub fn begin_launch(frame_state: &mut FrameState) -> u64 {
    frame_state.launch_id += 1;
    frame_state.last_frame = None;
    frame_state.last_frame_body = None;
    frame_state.world = Default::default();
    frame_state.launch_id
}

/// Ends the current launch: bumps the id (fencing out anything still
/// captured with the old value) and clears the same fields
/// `begin_launch` resets, since the ended launch's world status and
/// cached frame no longer describe anything live.
pub fn end_launch(frame_state: &mut FrameState) {
    frame_state.launch_id += 1;
    frame_state.last_frame = None;
    frame_state.last_frame_body = None;
    frame_state.world = Default::default();
}

/// Whether a scheduled backoff retry should actually spawn: its
/// captured launch id must still be current (no later spawn or clear
/// has happened since it was scheduled) and the operator must not have
/// explicitly stopped the sidecar.
pub fn should_retry(frame_state: &FrameState, launch_id: u64, stopped: bool) -> bool {
    is_current(frame_state, launch_id) && !stopped
}

#[derive(Default)]
pub struct SidecarState {
    pub child: Mutex<Option<CommandChild>>,
    pub restarts: Mutex<u32>,
    /// Set the moment an explicit Quit is requested, so the supervisor
    /// stops restarting and `RunEvent::ExitRequested` stops preventing exit.
    pub quitting: Mutex<bool>,
    /// Set once the supervisor gives up after too many failed attempts.
    pub exhausted: Mutex<bool>,
    /// Set by an explicit Stop Background tray action: distinct from
    /// `quitting` (the app keeps running, just with no sidecar) and from
    /// `exhausted` (an operator choice, not a supervisor giveup).
    pub stopped: Mutex<bool>,
    pub tray: Mutex<Option<TrayIcon>>,
    /// The active session's port/token, or `None` before the first
    /// `PANTHEA_PORT` line and after the child terminates.
    pub session: Mutex<Option<SidecarSession>>,
    /// The poll task's handle, so a restart or explicit stop can cancel
    /// the previous session's polling before starting a new one.
    pub poll_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// True while the main window is hidden (background mode).
    pub window_hidden: Mutex<bool>,
    pub frame: Mutex<FrameState>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(sequence: u64, status: &str, session_id: &str) -> FrameKey {
        FrameKey {
            sequence,
            status: status.to_string(),
            session_id: session_id.to_string(),
        }
    }

    #[test]
    fn no_previous_frame_always_forwards() {
        assert!(should_forward(None, &key(1, "running", "s1")));
    }

    #[test]
    fn identical_frame_does_not_forward() {
        let frame = key(5, "running", "s1");
        assert!(!should_forward(Some(&frame), &frame));
    }

    #[test]
    fn a_changed_sequence_forwards() {
        let previous = key(5, "running", "s1");
        let current = key(6, "running", "s1");
        assert!(should_forward(Some(&previous), &current));
    }

    #[test]
    fn a_changed_status_forwards_even_with_the_same_sequence() {
        let previous = key(5, "running", "s1");
        let current = key(5, "paused", "s1");
        assert!(should_forward(Some(&previous), &current));
    }

    #[test]
    fn a_changed_session_id_forwards_even_with_the_same_sequence_and_status() {
        let previous = key(5, "running", "s1");
        let current = key(5, "running", "s2");
        assert!(should_forward(Some(&previous), &current));
    }

    #[test]
    fn discovering_a_port_with_no_prior_session_starts_one() {
        let result = transition_session(
            None,
            SessionEvent::PortDiscovered {
                token: "tok-a".to_string(),
                port: 4100,
            },
        );
        assert_eq!(
            result,
            Some(SidecarSession {
                port: 4100,
                token: "tok-a".to_string(),
            })
        );
    }

    #[test]
    fn discovering_a_port_replaces_a_prior_session_entirely_rather_than_merging() {
        let previous = Some(SidecarSession {
            port: 4100,
            token: "tok-a".to_string(),
        });
        let result = transition_session(
            previous,
            SessionEvent::PortDiscovered {
                token: "tok-b".to_string(),
                port: 4200,
            },
        );
        assert_eq!(
            result,
            Some(SidecarSession {
                port: 4200,
                token: "tok-b".to_string(),
            })
        );
    }

    #[test]
    fn termination_clears_an_established_session() {
        let previous = Some(SidecarSession {
            port: 4100,
            token: "tok-a".to_string(),
        });
        assert_eq!(transition_session(previous, SessionEvent::Terminated), None);
    }

    #[test]
    fn termination_with_no_established_session_is_a_no_op() {
        assert_eq!(transition_session(None, SessionEvent::Terminated), None);
    }

    #[test]
    fn a_fresh_frame_state_has_never_begun_a_launch() {
        let state = FrameState::default();
        assert!(!is_current(&state, 1));
    }

    #[test]
    fn begin_launch_bumps_the_id_and_the_new_id_is_current() {
        let mut state = FrameState::default();
        let id = begin_launch(&mut state);
        assert_eq!(id, 1);
        assert!(is_current(&state, 1));
        assert!(!is_current(&state, 0));
    }

    #[test]
    fn begin_launch_resets_frame_and_world_fields() {
        let mut state = FrameState::default();
        begin_launch(&mut state);
        state.last_frame = Some(key(1, "running", "s1"));
        state.last_frame_body = Some(serde_json::json!({"sequence": 1}));
        state.world.status = Some("running".to_string());

        begin_launch(&mut state);

        assert_eq!(state.last_frame, None);
        assert_eq!(state.last_frame_body, None);
        assert_eq!(state.world, Default::default());
    }

    #[test]
    fn end_launch_bumps_the_id_so_the_ended_launch_is_no_longer_current() {
        let mut state = FrameState::default();
        let id = begin_launch(&mut state);
        end_launch(&mut state);
        assert!(!is_current(&state, id));
    }

    #[test]
    fn end_launch_resets_frame_and_world_fields() {
        let mut state = FrameState::default();
        begin_launch(&mut state);
        state.last_frame = Some(key(1, "running", "s1"));
        state.last_frame_body = Some(serde_json::json!({"sequence": 1}));
        state.world.status = Some("degraded".to_string());

        end_launch(&mut state);

        assert_eq!(state.last_frame, None);
        assert_eq!(state.last_frame_body, None);
        assert_eq!(state.world, Default::default());
    }

    #[test]
    fn a_retry_is_allowed_when_its_id_is_current_and_not_stopped() {
        let mut state = FrameState::default();
        let id = begin_launch(&mut state);
        assert!(should_retry(&state, id, false));
    }

    #[test]
    fn a_retry_is_refused_when_stopped_even_with_a_current_id() {
        let mut state = FrameState::default();
        let id = begin_launch(&mut state);
        assert!(!should_retry(&state, id, true));
    }

    #[test]
    fn a_retry_is_refused_when_its_id_is_no_longer_current() {
        let mut state = FrameState::default();
        let id = begin_launch(&mut state);
        end_launch(&mut state);
        assert!(!should_retry(&state, id, false));
    }

    #[test]
    fn a_retry_scheduled_before_stop_does_not_spawn_after_stop_then_restart() {
        let mut state = FrameState::default();
        begin_launch(&mut state); // the original spawn
        end_launch(&mut state); // its termination -- record_attempt_failure
        let retry_id = state.launch_id; // captures this id for the retry

        // Before the retry fires: Stop Background, then Restart.
        end_launch(&mut state); // Stop's clear
        begin_launch(&mut state); // Restart's spawn

        assert!(!should_retry(&state, retry_id, false));
    }

    #[test]
    fn a_terminated_event_from_a_superseded_launch_is_not_current() {
        let mut state = FrameState::default();
        let launch_a = begin_launch(&mut state); // child A spawned

        end_launch(&mut state); // Stop Background kills A
        let launch_b = begin_launch(&mut state); // Restart spawns child B

        // Child A's late Terminated event, captured with launch_a's id,
        // must see itself as superseded -- and the id that IS current
        // belongs to child B, not to whatever a stale check might assume.
        assert!(!is_current(&state, launch_a));
        assert!(is_current(&state, launch_b));
        assert_ne!(launch_a, launch_b);
    }
}
