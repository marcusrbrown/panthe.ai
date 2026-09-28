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

/// Everything a polled frame touches, behind one lock: the session
/// generation, change-detection state, world status, and the subscribed
/// Channel. Consolidated into one struct (rather than five separate
/// mutexes) so a frame's generation check, decision, cache update,
/// forward, and last-forwarded mark all happen atomically -- and so
/// installing a Channel and replaying the cached frame to it happen
/// atomically too, with no gap a concurrent poll or restart can land in.
#[derive(Default)]
pub struct FrameState {
    /// Bumped by every new session (`start_session`) and by session
    /// termination (`clear_session`); a poll task's frames are tagged
    /// with the generation it started with, so a frame still in flight
    /// after a restart or shutdown (a task-cancellation race) is fenced
    /// out rather than acted on.
    pub generation: u64,
    /// The last frame forwarded to the webview, for change detection.
    pub last_frame: Option<FrameKey>,
    /// The most recently polled frame's raw body, cached regardless of
    /// whether a subscriber was present to receive it -- replayed
    /// immediately to a newly (re)subscribing Channel.
    pub last_frame_body: Option<serde_json::Value>,
    pub world: WorldStatusSnapshot,
    /// The subscribed Channel; a resubscribe replaces it.
    pub channel: Option<Channel<serde_json::Value>>,
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
}
