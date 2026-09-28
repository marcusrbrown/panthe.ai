// Every piece of sidecar lifecycle state lives behind one lock:
// `Lifecycle`. The launch id, the tracked child, its session (port and
// token), the poll task handle, the stopped/exhausted/restarts
// supervisor bookkeeping, and the frame fields (change-detection state,
// world status, the subscribed Channel) all move together. Each
// transition below takes `&mut Lifecycle`, checks and mutates under
// that one lock, and returns what the caller must do after releasing
// it -- refresh the tray, kill a child, abort a task, schedule a retry
// -- so no check can ever be separated from the change it authorizes by
// an unlock. `quitting`, `window_hidden`, and the tray handle stay on
// `SidecarState` directly: they are read by the window/tray layer, not
// part of the spawn/kill supervision this module protects.

use std::sync::Mutex;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::tray::TrayIcon;
use tauri_plugin_shell::process::CommandChild;

pub const MAX_RESTARTS: u32 = 3;

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
/// a launch) always forwards.
pub fn should_forward(previous: Option<&FrameKey>, current: &FrameKey) -> bool {
    match previous {
        None => true,
        Some(previous) => previous != current,
    }
}

/// A sidecar session's connection details: the port and token
/// discovered from its `PANTHEA_PORT` stdout line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarSession {
    pub port: u16,
    pub token: String,
}

/// The sidecar's last reported world status and, when degraded, its
/// reason -- read by the tray to render its checked state and label.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorldStatusSnapshot {
    pub status: Option<String>,
    pub degraded_reason: Option<String>,
}

/// Every piece of state one sidecar launch and its supervision touch.
#[derive(Default)]
pub struct Lifecycle {
    /// Identifies the current launch attempt. Bumped by every spawn
    /// (`begin_spawn`) and by every launch ending (`stop`, or the
    /// termination handling inside `on_terminated`). Anything belonging
    /// to a launch -- a poll task's frames, a child's Terminated/Error
    /// handling, a scheduled backoff retry, an in-flight child attach --
    /// captures this value when it starts and is checked against it
    /// under this same lock before acting, so a callback that fires
    /// after its launch has ended becomes a no-op instead of touching
    /// whatever launch is current now.
    pub launch_id: u64,
    pub child: Option<CommandChild>,
    /// The active session's port/token, or `None` before the first
    /// `PANTHEA_PORT` line and after the child terminates.
    pub session: Option<SidecarSession>,
    /// The poll task's handle, so a restart, stop, or termination can
    /// cancel it. Taken out (never aborted) under the lock; the caller
    /// aborts it after unlock.
    pub poll_task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Set by an explicit Stop Background tray action: distinct from
    /// `exhausted` (a supervisor giveup, not an operator choice).
    pub stopped: bool,
    /// Set once the supervisor gives up after `MAX_RESTARTS` attempts.
    pub exhausted: bool,
    pub restarts: u32,
    /// The last frame forwarded to the webview, for change detection.
    pub last_frame: Option<FrameKey>,
    /// The most recently polled frame's raw body, cached regardless of
    /// whether a subscriber was present to receive it -- replayed
    /// immediately to a newly (re)subscribing Channel.
    pub last_frame_body: Option<serde_json::Value>,
    pub world: WorldStatusSnapshot,
    /// The subscribed Channel; a resubscribe replaces it. Not reset by
    /// a launch beginning or ending -- a subscribed webview stays
    /// subscribed across a sidecar restart.
    pub channel: Option<Channel<serde_json::Value>>,
}

/// True while `launch_id` is still the launch currently tracked by
/// `lifecycle` -- false once a later spawn or a clear has bumped it
/// past that value.
pub fn is_current(lifecycle: &Lifecycle, launch_id: u64) -> bool {
    lifecycle.launch_id == launch_id
}

/// Resets the fields a new launch should start fresh with:
/// change-detection state and world status. Shared by `begin_spawn`
/// (starting one) and the launch-ending path inside `on_terminated`/
/// `stop` (nothing about an ended launch's world status or cached frame
/// describes anything live anymore).
fn reset_frame_fields(lifecycle: &mut Lifecycle) {
    lifecycle.last_frame = None;
    lifecycle.last_frame_body = None;
    lifecycle.world = Default::default();
}

/// Starts a new launch attempt: refuses (returns `None`) if the
/// operator has explicitly stopped the sidecar. Otherwise bumps the
/// launch id and resets the frame fields, returning the new id for the
/// caller to carry through everything this launch's spawn, event loop,
/// and poll task do.
pub fn begin_spawn(lifecycle: &mut Lifecycle) -> Option<u64> {
    if lifecycle.stopped {
        return None;
    }
    lifecycle.launch_id += 1;
    reset_frame_fields(lifecycle);
    Some(lifecycle.launch_id)
}

/// Whether a resolved-and-spawned child may be installed: its launch id
/// must still be current and the sidecar must not have been stopped
/// while the OS-level spawn and stdin write were in flight.
pub fn should_attach(lifecycle: &Lifecycle, launch_id: u64) -> bool {
    is_current(lifecycle, launch_id) && !lifecycle.stopped
}

/// Installs `value` into `*slot` if `allowed`; otherwise hands it back
/// via `Err` for the caller to dispose of after unlock.
pub fn attach_into<T>(slot: &mut Option<T>, allowed: bool, value: T) -> Result<(), T> {
    if !allowed {
        return Err(value);
    }
    *slot = Some(value);
    Ok(())
}

/// Takes `*slot`'s value out (replacing it with `None`) only if
/// `current`; otherwise leaves it untouched and returns `None`.
pub fn take_if_current<T>(slot: &mut Option<T>, current: bool) -> Option<T> {
    if !current {
        return None;
    }
    slot.take()
}

/// What `attach_child` decided.
pub enum AttachOutcome {
    Attached,
    /// The launch went stale while the child was being resolved,
    /// spawned, or written to -- hands the child back so the caller can
    /// kill it after unlock. Nothing else will ever kill an untracked
    /// child.
    Refused(CommandChild),
}

/// Installs `child` as the tracked process for `launch_id`, or refuses
/// (see `should_attach`) and hands it back for the caller to kill.
pub fn attach_child(
    lifecycle: &mut Lifecycle,
    launch_id: u64,
    child: CommandChild,
) -> AttachOutcome {
    let allowed = should_attach(lifecycle, launch_id);
    match attach_into(&mut lifecycle.child, allowed, child) {
        Ok(()) => AttachOutcome::Attached,
        Err(child) => AttachOutcome::Refused(child),
    }
}

/// What `on_port` decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortOutcome {
    /// The session was installed; the caller starts the poll task
    /// against `port`/`token` and stores its handle under the same lock
    /// this instruction came from.
    StartPolling {
        port: u16,
        token: String,
        launch_id: u64,
    },
    /// `launch_id` is no longer current -- a stop or a newer spawn beat
    /// this child's `PANTHEA_PORT` line here. No session is installed.
    Refused,
}

/// Installs the session once `PANTHEA_PORT` is parsed, but only if
/// `launch_id` is still current -- it must never install a dead
/// launch's port/token as the tracked session.
pub fn on_port(lifecycle: &mut Lifecycle, launch_id: u64, port: u16, token: String) -> PortOutcome {
    if !is_current(lifecycle, launch_id) {
        return PortOutcome::Refused;
    }
    lifecycle.session = Some(SidecarSession {
        port,
        token: token.clone(),
    });
    PortOutcome::StartPolling {
        port,
        token,
        launch_id,
    }
}

/// The supervisor's retry decision: retry with the next backoff, or
/// give up once too many attempts have failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptOutcome {
    Retry { attempt: u32, backoff: Duration },
    Exhausted,
}

/// Given the number of restarts already recorded (before this failure),
/// decides whether to retry (with the next backoff) or give up. Attempts
/// 1..=MAX_RESTARTS retry; the attempt after that is exhausted.
pub fn next_attempt_outcome(restarts_so_far: u32) -> AttemptOutcome {
    let attempt = restarts_so_far + 1;
    if attempt > MAX_RESTARTS {
        return AttemptOutcome::Exhausted;
    }
    // Exponential backoff (500ms, 1s, 2s, ...).
    let backoff = Duration::from_millis(500 * 2u64.pow(attempt - 1));
    AttemptOutcome::Retry { attempt, backoff }
}

/// What `on_terminated` decided, once past the staleness check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminatedOutcome {
    /// The event belongs to a launch a later spawn or a clear has
    /// already ended -- nothing happened.
    Stale,
    /// Quitting or an explicit stop is in effect: the launch ended, but
    /// no retry is scheduled.
    Stopped,
    /// Schedule a retry after `backoff`, carrying `retry_launch_id` --
    /// the id that must still be current when the retry fires.
    Retry {
        backoff: Duration,
        retry_launch_id: u64,
        attempt: u32,
    },
    /// The restart supervisor gave up after `MAX_RESTARTS` attempts.
    Exhausted,
}

/// The poll task handle (if any) taken out alongside the decision, for
/// the caller to abort after unlock -- never aborted while the lock is
/// held.
pub struct TerminatedResult {
    pub poll_task: Option<tauri::async_runtime::JoinHandle<()>>,
    pub outcome: TerminatedOutcome,
}

/// Handles a spawn/token-write/unexpected-exit failure for `launch_id`.
/// A no-op (`Stale`) unless `launch_id` is still current -- this event
/// belongs to a launch a later spawn or an explicit stop/clear has
/// already ended. Otherwise clears the child and session, ends the
/// launch (bumping the id so anything still carrying the old value is
/// fenced out), and decides whether to retry or give up. Never retries
/// once `quitting` or explicitly stopped.
pub fn on_terminated(
    lifecycle: &mut Lifecycle,
    launch_id: u64,
    quitting: bool,
) -> TerminatedResult {
    let current = is_current(lifecycle, launch_id);
    let poll_task = take_if_current(&mut lifecycle.poll_task, current);
    // The terminated child is already dead; nothing else will ever act
    // on it, so its value is discarded rather than returned.
    let _child = take_if_current(&mut lifecycle.child, current);

    if !current {
        return TerminatedResult {
            poll_task,
            outcome: TerminatedOutcome::Stale,
        };
    }

    lifecycle.session = None;
    lifecycle.launch_id += 1;
    reset_frame_fields(lifecycle);

    if quitting || lifecycle.stopped {
        return TerminatedResult {
            poll_task,
            outcome: TerminatedOutcome::Stopped,
        };
    }

    let restarts_so_far = lifecycle.restarts;
    lifecycle.restarts += 1;

    match next_attempt_outcome(restarts_so_far) {
        AttemptOutcome::Retry { attempt, backoff } => TerminatedResult {
            poll_task,
            outcome: TerminatedOutcome::Retry {
                backoff,
                retry_launch_id: lifecycle.launch_id,
                attempt,
            },
        },
        AttemptOutcome::Exhausted => {
            lifecycle.exhausted = true;
            TerminatedResult {
                poll_task,
                outcome: TerminatedOutcome::Exhausted,
            }
        }
    }
}

/// Whether a scheduled backoff retry should actually spawn: equivalent
/// to `begin_spawn`, but only when the retry's captured `launch_id` is
/// still current -- a later spawn, stop, or clear since it was
/// scheduled refuses it before `begin_spawn`'s own stopped check ever
/// runs.
pub fn on_retry(lifecycle: &mut Lifecycle, launch_id: u64) -> Option<u64> {
    if !is_current(lifecycle, launch_id) {
        return None;
    }
    begin_spawn(lifecycle)
}

/// The child and poll task taken out by `stop`, for the caller to kill
/// and abort after unlock.
pub struct StopResult {
    pub child: Option<CommandChild>,
    pub poll_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// Stops the sidecar: sets `stopped`, ends the launch (bumping the id
/// so anything still carrying the old value is fenced out), and takes
/// the child and poll task handle out for the caller to kill/abort
/// after unlock.
pub fn stop(lifecycle: &mut Lifecycle) -> StopResult {
    lifecycle.stopped = true;
    lifecycle.launch_id += 1;
    let child = lifecycle.child.take();
    let poll_task = lifecycle.poll_task.take();
    lifecycle.session = None;
    reset_frame_fields(lifecycle);
    StopResult { child, poll_task }
}

/// Restarts from a stopped or exhausted state: clears `stopped`,
/// `exhausted`, and `restarts` (so backoff starts fresh rather than
/// resuming where the supervisor gave up), then begins a new spawn.
pub fn restart(lifecycle: &mut Lifecycle) -> Option<u64> {
    lifecycle.stopped = false;
    lifecycle.exhausted = false;
    lifecycle.restarts = 0;
    begin_spawn(lifecycle)
}

#[derive(Default)]
pub struct SidecarState {
    /// Set the moment an explicit Quit is requested, so the supervisor
    /// stops restarting and `RunEvent::ExitRequested` stops preventing exit.
    pub quitting: Mutex<bool>,
    /// True while the main window is hidden (background mode).
    pub window_hidden: Mutex<bool>,
    pub tray: Mutex<Option<TrayIcon>>,
    pub lifecycle: Mutex<Lifecycle>,
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
    fn a_fresh_lifecycle_has_never_begun_a_launch() {
        let lifecycle = Lifecycle::default();
        assert!(!is_current(&lifecycle, 1));
    }

    #[test]
    fn begin_spawn_bumps_the_id_and_the_new_id_is_current() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        assert_eq!(id, 1);
        assert!(is_current(&lifecycle, 1));
        assert!(!is_current(&lifecycle, 0));
    }

    #[test]
    fn begin_spawn_refuses_when_stopped() {
        let mut lifecycle = Lifecycle {
            stopped: true,
            ..Default::default()
        };
        assert_eq!(begin_spawn(&mut lifecycle), None);
        assert_eq!(lifecycle.launch_id, 0);
    }

    #[test]
    fn begin_spawn_resets_frame_and_world_fields() {
        let mut lifecycle = Lifecycle::default();
        begin_spawn(&mut lifecycle);
        lifecycle.last_frame = Some(key(1, "running", "s1"));
        lifecycle.last_frame_body = Some(serde_json::json!({"sequence": 1}));
        lifecycle.world.status = Some("running".to_string());

        begin_spawn(&mut lifecycle);

        assert_eq!(lifecycle.last_frame, None);
        assert_eq!(lifecycle.last_frame_body, None);
        assert_eq!(lifecycle.world, Default::default());
    }

    #[test]
    fn on_port_installs_the_session_and_instructs_polling_when_current() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");

        let outcome = on_port(&mut lifecycle, id, 4100, "tok-a".to_string());

        assert_eq!(
            outcome,
            PortOutcome::StartPolling {
                port: 4100,
                token: "tok-a".to_string(),
                launch_id: id,
            }
        );
        assert_eq!(
            lifecycle.session,
            Some(SidecarSession {
                port: 4100,
                token: "tok-a".to_string(),
            })
        );
    }

    #[test]
    fn on_port_refuses_a_stale_id_and_installs_nothing() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        begin_spawn(&mut lifecycle).expect("a second spawn supersedes the first");

        let outcome = on_port(&mut lifecycle, id, 4100, "tok-a".to_string());

        assert_eq!(outcome, PortOutcome::Refused);
        assert_eq!(lifecycle.session, None);
    }

    #[test]
    fn should_attach_is_true_for_a_current_unstopped_id() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        assert!(should_attach(&lifecycle, id));
    }

    #[test]
    fn should_attach_is_false_when_stopped_even_though_the_id_is_still_current() {
        // Constructed directly (not via `stop`, which also bumps the
        // id) so `stopped` and `is_current` are tested independently --
        // `stop` always bumps the id too, so it can never itself
        // produce a "stopped but still current" lifecycle.
        let lifecycle = Lifecycle {
            launch_id: 1,
            stopped: true,
            ..Default::default()
        };
        assert!(is_current(&lifecycle, 1));
        assert!(!should_attach(&lifecycle, 1));
    }

    #[test]
    fn should_attach_is_false_for_a_superseded_id() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        begin_spawn(&mut lifecycle).expect("a second spawn supersedes the first");
        assert!(!should_attach(&lifecycle, id));
    }

    #[test]
    fn retries_up_to_max_restarts_then_exhausts() {
        assert_eq!(
            next_attempt_outcome(0),
            AttemptOutcome::Retry {
                attempt: 1,
                backoff: Duration::from_millis(500)
            }
        );
        assert_eq!(
            next_attempt_outcome(1),
            AttemptOutcome::Retry {
                attempt: 2,
                backoff: Duration::from_millis(1000)
            }
        );
        assert_eq!(
            next_attempt_outcome(2),
            AttemptOutcome::Retry {
                attempt: 3,
                backoff: Duration::from_millis(2000)
            }
        );
        assert_eq!(next_attempt_outcome(3), AttemptOutcome::Exhausted);
        // Once exhausted, further failures stay exhausted (no wraparound
        // or accidental re-retry from a stale counter).
        assert_eq!(next_attempt_outcome(10), AttemptOutcome::Exhausted);
    }

    #[test]
    fn backoff_matches_max_restarts_boundary() {
        // MAX_RESTARTS itself is still a retry -- only the attempt after
        // it is exhausted.
        assert!(matches!(
            next_attempt_outcome(MAX_RESTARTS - 1),
            AttemptOutcome::Retry {
                attempt: MAX_RESTARTS,
                ..
            }
        ));
        assert_eq!(
            next_attempt_outcome(MAX_RESTARTS),
            AttemptOutcome::Exhausted
        );
    }

    #[test]
    fn on_terminated_is_stale_for_a_superseded_launch() {
        let mut lifecycle = Lifecycle::default();
        let old_id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        begin_spawn(&mut lifecycle).expect("a second spawn supersedes the first");

        let result = on_terminated(&mut lifecycle, old_id, false);
        assert_eq!(result.outcome, TerminatedOutcome::Stale);
        assert!(result.poll_task.is_none());
    }

    #[test]
    fn on_terminated_schedules_a_retry_for_a_current_launch() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");

        let result = on_terminated(&mut lifecycle, id, false);

        assert_eq!(
            result.outcome,
            TerminatedOutcome::Retry {
                backoff: Duration::from_millis(500),
                retry_launch_id: lifecycle.launch_id,
                attempt: 1,
            }
        );
        assert_eq!(lifecycle.restarts, 1);
        assert_eq!(lifecycle.session, None);
    }

    #[test]
    fn on_terminated_reports_stopped_and_schedules_nothing_when_quitting() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");

        let result = on_terminated(&mut lifecycle, id, true);

        assert_eq!(result.outcome, TerminatedOutcome::Stopped);
        assert_eq!(lifecycle.restarts, 0);
    }

    #[test]
    fn on_terminated_exhausts_after_max_restarts() {
        let mut lifecycle = Lifecycle::default();
        let mut id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        for _ in 0..MAX_RESTARTS {
            let result = on_terminated(&mut lifecycle, id, false);
            let TerminatedOutcome::Retry {
                retry_launch_id, ..
            } = result.outcome
            else {
                panic!("expected a retry");
            };
            id = on_retry(&mut lifecycle, retry_launch_id).expect("retry allowed");
        }

        let result = on_terminated(&mut lifecycle, id, false);
        assert_eq!(result.outcome, TerminatedOutcome::Exhausted);
        assert!(lifecycle.exhausted);
    }

    #[test]
    fn on_retry_is_allowed_for_a_current_unstopped_id() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        let result = on_terminated(&mut lifecycle, id, false);
        let TerminatedOutcome::Retry {
            retry_launch_id, ..
        } = result.outcome
        else {
            panic!("expected a retry");
        };

        assert!(on_retry(&mut lifecycle, retry_launch_id).is_some());
    }

    #[test]
    fn on_retry_refuses_a_stale_id() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        begin_spawn(&mut lifecycle).expect("a second spawn supersedes the first");
        assert_eq!(on_retry(&mut lifecycle, id), None);
    }

    #[test]
    fn on_retry_refuses_a_current_id_once_stopped() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        let result = on_terminated(&mut lifecycle, id, false);
        let TerminatedOutcome::Retry {
            retry_launch_id, ..
        } = result.outcome
        else {
            panic!("expected a retry");
        };

        stop(&mut lifecycle);

        assert_eq!(on_retry(&mut lifecycle, retry_launch_id), None);
    }

    #[test]
    fn stop_bumps_the_id_and_clears_the_session() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        on_port(&mut lifecycle, id, 4100, "tok".to_string());

        stop(&mut lifecycle);

        assert!(lifecycle.stopped);
        assert!(!is_current(&lifecycle, id));
        assert_eq!(lifecycle.session, None);
    }

    #[test]
    fn restart_clears_stopped_exhausted_and_restarts_then_spawns() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        on_terminated(&mut lifecycle, id, false); // restarts becomes 1
        stop(&mut lifecycle);
        lifecycle.exhausted = true;

        let new_id = restart(&mut lifecycle).expect("restart spawns");

        assert!(!lifecycle.stopped);
        assert!(!lifecycle.exhausted);
        assert_eq!(lifecycle.restarts, 0);
        assert!(is_current(&lifecycle, new_id));
    }

    #[test]
    fn an_old_launchs_terminated_event_after_stop_then_restart_is_a_no_op() {
        let mut lifecycle = Lifecycle::default();
        let old_id = begin_spawn(&mut lifecycle).expect("initial spawn allowed");
        on_port(&mut lifecycle, old_id, 4100, "token-a".to_string());

        // Stop Background, then Restart -- before the old child's
        // Terminated event is handled.
        stop(&mut lifecycle);
        let new_id = restart(&mut lifecycle).expect("restart allowed");
        on_port(&mut lifecycle, new_id, 4200, "token-b".to_string());

        let before_session = lifecycle.session.clone();
        let before_launch_id = lifecycle.launch_id;
        let before_restarts = lifecycle.restarts;
        let before_stopped = lifecycle.stopped;
        let before_exhausted = lifecycle.exhausted;

        // The old child's late Terminated event, still carrying old_id.
        let result = on_terminated(&mut lifecycle, old_id, false);

        assert_eq!(result.outcome, TerminatedOutcome::Stale);
        assert!(result.poll_task.is_none());
        assert_eq!(lifecycle.session, before_session);
        assert_eq!(lifecycle.launch_id, before_launch_id);
        assert_eq!(lifecycle.restarts, before_restarts);
        assert_eq!(lifecycle.stopped, before_stopped);
        assert_eq!(lifecycle.exhausted, before_exhausted);
    }

    #[test]
    fn a_stop_between_minting_and_installing_a_session_refuses_the_install() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");

        // Stop happens before the PANTHEA_PORT line is processed.
        stop(&mut lifecycle);

        let outcome = on_port(&mut lifecycle, id, 4100, "token".to_string());

        assert_eq!(outcome, PortOutcome::Refused);
        assert_eq!(lifecycle.session, None);
        assert!(lifecycle.poll_task.is_none());
    }

    #[test]
    fn a_retry_scheduled_before_stop_is_refused_when_it_fires() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        let result = on_terminated(&mut lifecycle, id, false);
        let TerminatedOutcome::Retry {
            retry_launch_id, ..
        } = result.outcome
        else {
            panic!("expected a retry");
        };

        // Stop happens before the retry fires.
        stop(&mut lifecycle);

        assert_eq!(on_retry(&mut lifecycle, retry_launch_id), None);
        assert!(lifecycle.child.is_none());
    }

    #[test]
    fn attach_child_refuses_once_stop_happens_between_the_spawn_attempt_and_the_install() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");

        // Stop happens between the spawn attempt's OS-level work and
        // attach_child's install -- it both sets `stopped` and bumps
        // the id, so this id is refused twice over.
        stop(&mut lifecycle);

        assert!(!should_attach(&lifecycle, id));
        assert!(lifecycle.child.is_none());
    }

    #[test]
    fn attach_child_refuses_a_superseded_id_from_a_second_spawn() {
        // A second, unrelated spawn (e.g. Restart) bumps the id again
        // before this attempt's attach_child runs.
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        begin_spawn(&mut lifecycle).expect("a second spawn bumps the id again");

        assert!(!should_attach(&lifecycle, id));
    }

    #[test]
    fn an_accepted_retry_is_refused_by_attach_into_once_stop_lands_before_attach() {
        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        let result = on_terminated(&mut lifecycle, id, false);
        let TerminatedOutcome::Retry {
            retry_launch_id, ..
        } = result.outcome
        else {
            panic!("expected a retry");
        };

        // on_retry accepts: the id is current and the sidecar is not
        // stopped.
        let retried_id = on_retry(&mut lifecycle, retry_launch_id).expect("retry accepted");

        // Stop lands while the retry's spawn is still in flight.
        stop(&mut lifecycle);

        let mut slot: Option<&str> = None;
        let allowed = should_attach(&lifecycle, retried_id);
        let result = attach_into(&mut slot, allowed, "child");

        assert_eq!(result, Err("child"));
        assert_eq!(slot, None);
    }

    #[test]
    fn take_if_current_leaves_a_stale_slot_untouched() {
        // A stale event leaves the new launch's child and poll task in place.
        let mut child_slot = Some("child-b");
        let mut poll_task_slot = Some(42u32);

        let taken_child = take_if_current(&mut child_slot, false);
        let taken_poll_task = take_if_current(&mut poll_task_slot, false);

        assert_eq!(taken_child, None);
        assert_eq!(taken_poll_task, None);
        assert_eq!(child_slot, Some("child-b"));
        assert_eq!(poll_task_slot, Some(42));
    }

    #[test]
    fn take_if_current_takes_the_value_when_current() {
        let mut slot = Some("child-a");
        assert_eq!(take_if_current(&mut slot, true), Some("child-a"));
        assert_eq!(slot, None);
    }

    #[test]
    fn a_stale_apply_frame_after_stop_leaves_state_unchanged() {
        use crate::proxy::apply_frame;

        let mut lifecycle = Lifecycle::default();
        let id = begin_spawn(&mut lifecycle).expect("spawn allowed");
        on_port(&mut lifecycle, id, 4100, "token".to_string());

        stop(&mut lifecycle);

        let before_launch_id = lifecycle.launch_id;
        let before_last_frame = lifecycle.last_frame.clone();
        let before_last_frame_body = lifecycle.last_frame_body.clone();
        let before_world = lifecycle.world.clone();

        let late_frame =
            serde_json::json!({ "sequence": 9, "status": "running", "sessionId": "old" });
        let refreshed = apply_frame(&mut lifecycle, id, late_frame);

        assert!(!refreshed);
        assert_eq!(lifecycle.launch_id, before_launch_id);
        assert_eq!(lifecycle.last_frame, before_last_frame);
        assert_eq!(lifecycle.last_frame_body, before_last_frame_body);
        assert_eq!(lifecycle.world, before_world);
    }
}
