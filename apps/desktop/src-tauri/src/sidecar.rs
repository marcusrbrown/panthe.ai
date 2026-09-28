// Sidecar process supervision: spawns the Bun simulation service, writes
// its per-launch auth token to stdin, watches its stdout for the
// `PANTHEA_PORT` line to discover the session it just started, and
// restarts it with backoff on unexpected exit.

use std::io::Read;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::state::{transition_session, SessionEvent, SidecarState};

/// Matches the `externalBin` entry name in `tauri.conf.json` (the target
/// triple suffix is stripped by Tauri's sidecar bundling convention).
const SIDECAR_NAME: &str = "panthea-sim";
const MAX_RESTARTS: u32 = 3;
const PANTHEA_PORT_PREFIX: &str = "PANTHEA_PORT=";

/// Extracts the port from a `PANTHEA_PORT=<port>` stdout line, ignoring
/// surrounding whitespace and any other line content.
pub fn parse_panthea_port(line: &str) -> Option<u16> {
    line.trim().strip_prefix(PANTHEA_PORT_PREFIX)?.parse().ok()
}

/// Accumulates raw stdout bytes across `CommandEvent::Stdout` chunks
/// (which do not align with line boundaries) and yields complete lines.
#[derive(Default)]
struct LineBuffer {
    buf: Vec<u8>,
}

impl LineBuffer {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut lines = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&byte| byte == b'\n') {
            let line_bytes: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]).into_owned();
            lines.push(line);
        }
        lines
    }
}

/// Mints a per-launch auth token: 32 random bytes read from `/dev/urandom`,
/// hex-encoded. Minted fresh on every spawn (initial launch and every
/// restart) and never reused, written to argv/env, or logged -- the token
/// exists only in this process's memory and the child's stdin.
///
/// No deterministic fallback: if `/dev/urandom` can't be read, the caller
/// must fail rather than mint a guessable token from the pid and clock.
fn generate_token() -> std::io::Result<String> {
    let mut buf = [0u8; 32];
    let mut urandom = std::fs::File::open("/dev/urandom")?;
    urandom.read_exact(&mut buf)?;
    Ok(buf.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The supervisor's retry decision: retry with the next backoff, or give
/// up once too many attempts have failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttemptOutcome {
    Retry { attempt: u32, backoff: Duration },
    Exhausted,
}

/// Whether a scheduled retry should actually respawn the sidecar: an
/// operator's explicit Stop Background request, arriving while the
/// retry was pending, cancels it.
fn should_retry_spawn(stopped: bool) -> bool {
    !stopped
}

/// Given the number of restarts already recorded (before this failure),
/// decides whether to retry (with the next backoff) or give up. Attempts
/// 1..=MAX_RESTARTS retry; the attempt after that is exhausted.
fn next_attempt_outcome(restarts_so_far: u32) -> AttemptOutcome {
    let attempt = restarts_so_far + 1;
    if attempt > MAX_RESTARTS {
        return AttemptOutcome::Exhausted;
    }
    // Exponential backoff (500ms, 1s, 2s, ...).
    let backoff = Duration::from_millis(500 * 2u64.pow(attempt - 1));
    AttemptOutcome::Retry { attempt, backoff }
}

/// Updates the tray tooltip to surface a supervisor giveup to the user,
/// without blocking the renderer or tearing down the app.
fn mark_sidecar_unavailable(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let tray_guard = state.tray.lock().expect("sidecar state mutex poisoned");
    if let Some(tray) = tray_guard.as_ref() {
        let _ = tray.set_tooltip(Some("Panthea — simulation service unavailable (see logs)"));
    }
}

/// Cancels the active poll task (if any) and clears the tracked session,
/// so the proxy stops polling a port that no longer belongs to a live
/// sidecar.
fn clear_session(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if let Some(task) = state
        .poll_task
        .lock()
        .expect("sidecar state mutex poisoned")
        .take()
    {
        task.abort();
    }
    let mut session = state.session.lock().expect("sidecar state mutex poisoned");
    *session = transition_session(session.take(), SessionEvent::Terminated);
    drop(session);

    let mut frame = state.frame.lock().expect("sidecar state mutex poisoned");
    frame.last_frame = None;
    frame.last_frame_body = None;
    frame.world = Default::default();
}

/// Records a failed spawn/token-write/unexpected-exit attempt: clears the
/// tracked child and session, and either schedules a backoff retry or
/// marks the supervisor exhausted once `MAX_RESTARTS` is exceeded. Never
/// restarts once quitting or explicitly stopped.
fn record_attempt_failure(app: &AppHandle, reason: &str) {
    let state = app.state::<SidecarState>();
    *state.child.lock().expect("sidecar state mutex poisoned") = None;
    clear_session(app);

    let stop_requested = *state.quitting.lock().expect("sidecar state mutex poisoned")
        || *state.stopped.lock().expect("sidecar state mutex poisoned");
    if stop_requested {
        crate::tray::refresh(app);
        return;
    }

    let restarts_so_far = {
        let mut restarts = state.restarts.lock().expect("sidecar state mutex poisoned");
        let so_far = *restarts;
        *restarts = so_far + 1;
        so_far
    };

    match next_attempt_outcome(restarts_so_far) {
        AttemptOutcome::Retry { attempt, backoff } => {
            eprintln!(
                "panthea-desktop: sidecar attempt failed ({reason}); retrying in {backoff:?} (attempt {attempt}/{MAX_RESTARTS})"
            );
            let app_for_retry = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(backoff);
                let stopped = *app_for_retry
                    .state::<SidecarState>()
                    .stopped
                    .lock()
                    .expect("sidecar state mutex poisoned");
                if should_retry_spawn(stopped) {
                    spawn_sidecar(app_for_retry);
                }
            });
        }
        AttemptOutcome::Exhausted => {
            *state
                .exhausted
                .lock()
                .expect("sidecar state mutex poisoned") = true;
            eprintln!(
                "panthea-desktop: sidecar exceeded {MAX_RESTARTS} restart attempts (last failure: {reason}); giving up — the app keeps running with no simulation service"
            );
            mark_sidecar_unavailable(app);
        }
    }
    crate::tray::refresh(app);
}

/// Kills the currently tracked sidecar child, if any, and clears its
/// session. Used by both an explicit quit/stop and the app's final exit.
pub fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let mut guard = state.child.lock().expect("sidecar state mutex poisoned");
    if let Some(child) = guard.take() {
        if let Err(error) = child.kill() {
            eprintln!("panthea-desktop: failed to kill sidecar on exit: {error}");
        }
    }
    drop(guard);
    clear_session(app);
}

/// Spawns the sidecar, writes its per-launch token to stdin, watches
/// stdout for the `PANTHEA_PORT` line to start the proxy's poll task,
/// and installs the restart-with-backoff supervisor on unexpected exit.
/// A `/dev/urandom` failure is fatal (no deterministic token fallback,
/// ever). A resolve, spawn, or stdin-write failure is routed through the
/// same bounded-retry path as an unexpected exit. A child that fails its
/// stdin token write is killed immediately rather than left running
/// unauthenticated.
///
/// Does not touch `stopped` -- only an explicit Restart Simulation action
/// clears it before calling this, and a scheduled retry checks it before
/// calling this at all.
pub fn spawn_sidecar(app: AppHandle) {
    let token = match generate_token() {
        Ok(token) => token,
        Err(error) => {
            eprintln!(
                "panthea-desktop: fatal: failed to read /dev/urandom for the sidecar launch token: {error}"
            );
            std::process::exit(1);
        }
    };

    let shell = app.shell();
    let command = match shell.sidecar(SIDECAR_NAME) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("panthea-desktop: failed to resolve sidecar \"{SIDECAR_NAME}\": {error}");
            record_attempt_failure(&app, "resolve");
            return;
        }
    };

    let (mut rx, mut child) = match command.spawn() {
        Ok(pair) => pair,
        Err(error) => {
            eprintln!("panthea-desktop: failed to spawn sidecar: {error}");
            record_attempt_failure(&app, "spawn");
            return;
        }
    };

    if let Err(error) = child.write(format!("{token}\n").as_bytes()) {
        eprintln!("panthea-desktop: failed to write launch token to sidecar stdin: {error}");
        // An unauthenticated child must never be tracked as healthy —
        // kill it immediately rather than leaving a live, un-tokened
        // process running with no supervisor awareness of the failure.
        if let Err(kill_error) = child.kill() {
            eprintln!("panthea-desktop: failed to kill un-tokened sidecar: {kill_error}");
        }
        record_attempt_failure(&app, "stdin-write");
        return;
    }

    {
        let state = app.state::<SidecarState>();
        *state.child.lock().expect("sidecar state mutex poisoned") = Some(child);
    }

    let supervised_app = app.clone();
    let stdout_token = token.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = LineBuffer::default();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    print!("panthea-sim: {}", String::from_utf8_lossy(&bytes));
                    for line in lines.push(&bytes) {
                        if let Some(port) = parse_panthea_port(&line) {
                            start_session(&supervised_app, port, stdout_token.clone());
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprint!("panthea-sim(stderr): {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Error(error) => {
                    eprintln!("panthea-sim: command error: {error}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "panthea-sim: terminated (code={:?}, signal={:?})",
                        payload.code, payload.signal
                    );
                    record_attempt_failure(&supervised_app, "terminated");
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Starts a fresh session once `PANTHEA_PORT` is parsed: replaces
/// whatever session was tracked before, resets change-detection and
/// world-status state, bumps the generation counter (fencing out any
/// frame the previous session's poll task might still hand back before
/// its `abort()` takes effect), and starts the proxy's poll task against
/// the new port and token.
fn start_session(app: &AppHandle, port: u16, token: String) {
    let state = app.state::<SidecarState>();

    if let Some(task) = state
        .poll_task
        .lock()
        .expect("sidecar state mutex poisoned")
        .take()
    {
        task.abort();
    }

    let generation = {
        let mut frame = state.frame.lock().expect("sidecar state mutex poisoned");
        frame.generation += 1;
        frame.last_frame = None;
        frame.last_frame_body = None;
        frame.world = Default::default();
        frame.generation
    };

    let session = {
        let mut session = state.session.lock().expect("sidecar state mutex poisoned");
        *session = transition_session(
            session.take(),
            SessionEvent::PortDiscovered {
                token: token.clone(),
                port,
            },
        );
        session.clone()
    };
    let Some(session) = session else {
        return;
    };

    let task = crate::proxy::start_polling(app.clone(), session.port, session.token, generation);
    *state
        .poll_task
        .lock()
        .expect("sidecar state mutex poisoned") = Some(task);
    crate::tray::refresh(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_port_from_a_well_formed_line() {
        assert_eq!(parse_panthea_port("PANTHEA_PORT=54321"), Some(54321));
    }

    #[test]
    fn ignores_surrounding_whitespace() {
        assert_eq!(parse_panthea_port("  PANTHEA_PORT=8080\r"), Some(8080));
    }

    #[test]
    fn rejects_a_line_with_no_matching_prefix() {
        assert_eq!(parse_panthea_port("panthea-simulation: hello"), None);
    }

    #[test]
    fn rejects_a_non_numeric_port() {
        assert_eq!(parse_panthea_port("PANTHEA_PORT=not-a-port"), None);
    }

    #[test]
    fn a_line_buffer_yields_complete_lines_across_chunk_boundaries() {
        let mut lines = LineBuffer::default();
        assert_eq!(lines.push(b"panthea-simulation: rec"), Vec::<String>::new());
        assert_eq!(
            lines.push(b"laimed stale lock\nPANTHEA_PORT=1234\npar"),
            vec![
                "panthea-simulation: reclaimed stale lock".to_string(),
                "PANTHEA_PORT=1234".to_string(),
            ]
        );
        assert_eq!(
            lines.push(b"tial line more\n"),
            vec!["partial line more".to_string()]
        );
    }

    #[test]
    fn a_stopped_sidecar_does_not_respawn_on_a_pending_retry() {
        assert!(!should_retry_spawn(true));
    }

    #[test]
    fn a_running_sidecar_respawns_on_a_pending_retry() {
        assert!(should_retry_spawn(false));
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
        // MAX_RESTARTS itself is still a retry — only the attempt after it
        // is exhausted.
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
}
