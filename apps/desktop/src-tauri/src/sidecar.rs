// Sidecar process supervision: spawns the Bun simulation service, writes
// its per-launch auth token to stdin, watches its stdout for the
// `PANTHEA_PORT` line to discover the session it just started, and
// restarts it with backoff on unexpected exit.
//
// Every check against shared lifecycle state and the mutation it
// authorizes happen under the same `Lifecycle` lock (see state.rs) --
// spawning the child process and writing its token happen outside that
// lock, since they are blocking OS calls; `attach_child` then installs
// the child under the lock afterward, refusing and killing it if the
// launch went stale while the spawn was in flight.

use std::io::Read;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::commands::KeyVault;
use crate::launch::build_launch_line;
use crate::settings::SettingsStore;
use crate::state::{
    apply_restart, attach_child, begin_spawn, on_port, on_retry, on_terminated, restart, stop,
    ApplyRestartResult, AttachOutcome, PortOutcome, SidecarState, StopResult, TerminatedOutcome,
    MAX_RESTARTS,
};

/// Matches the `externalBin` entry name in `tauri.conf.json` (the target
/// triple suffix is stripped by Tauri's sidecar bundling convention).
const SIDECAR_NAME: &str = "panthea-sim";
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

/// Starts the initial launch (app startup) or an operator-triggered
/// restart from Stop/Unavailable. Refuses (does nothing) only if the
/// operator has explicitly stopped the sidecar since.
pub fn spawn_sidecar(app: AppHandle) {
    let launch_id = {
        let state = app.state::<SidecarState>();
        let mut lifecycle = state
            .lifecycle
            .lock()
            .expect("sidecar state mutex poisoned");
        begin_spawn(&mut lifecycle)
    };
    let Some(launch_id) = launch_id else {
        return;
    };
    spawn_with_id(app, launch_id);
}

/// Applies a settings change (saved settings, a set or deleted key, the
/// offline switch): replaces the running sidecar with a fresh launch that
/// reads the new settings and keys. The old child is killed and its poll task
/// aborted after unlock, never under the lock; the new launch gets a new id, so
/// anything the old one still has in flight is dropped. Does nothing when the
/// operator has stopped the sidecar. Blocks on the OS (kill, spawn, Keychain
/// reads): call it off the main thread.
pub fn apply_restart_sidecar(app: AppHandle) {
    let ApplyRestartResult {
        child,
        poll_task,
        launch_id,
    } = {
        let state = app.state::<SidecarState>();
        let mut lifecycle = state
            .lifecycle
            .lock()
            .expect("sidecar state mutex poisoned");
        apply_restart(&mut lifecycle)
    };

    if let Some(child) = child {
        if let Err(error) = child.kill() {
            eprintln!("panthea-desktop: failed to kill the replaced sidecar: {error}");
        }
    }
    if let Some(task) = poll_task {
        task.abort();
    }
    let Some(launch_id) = launch_id else {
        return;
    };
    crate::tray::refresh(&app);
    spawn_with_id(app, launch_id);
}

/// Spawns a scheduled backoff retry: a no-op unless `retry_launch_id` is
/// still current and the sidecar has not been stopped since it was
/// scheduled.
fn spawn_retry(app: AppHandle, retry_launch_id: u64) {
    let launch_id = {
        let state = app.state::<SidecarState>();
        let mut lifecycle = state
            .lifecycle
            .lock()
            .expect("sidecar state mutex poisoned");
        on_retry(&mut lifecycle, retry_launch_id)
    };
    let Some(launch_id) = launch_id else {
        return;
    };
    spawn_with_id(app, launch_id);
}

/// Restarts from a stopped or exhausted state: clears the operator/
/// supervisor flags and the restart counter, then spawns. Called by the
/// tray's Restart Simulation action.
pub fn restart_sidecar(app: AppHandle) {
    let launch_id = {
        let state = app.state::<SidecarState>();
        let mut lifecycle = state
            .lifecycle
            .lock()
            .expect("sidecar state mutex poisoned");
        restart(&mut lifecycle)
    };
    let Some(launch_id) = launch_id else {
        return;
    };
    spawn_with_id(app, launch_id);
}

/// Does the actual OS-level work for `launch_id`, already minted by the
/// caller (`begin_spawn`, `on_retry`, or `restart`): resolves and spawns
/// the child, writes its token to stdin, and installs it via
/// `attach_child` -- all outside the lifecycle lock, since resolving
/// and spawning a process is a blocking OS call that must never block
/// frame polling, pause/resume, or the tray. A child that fails its
/// stdin token write is killed immediately rather than left running
/// unauthenticated. `attach_child` refuses (and this function kills the
/// child) if the launch went stale while any of this was in flight. A
/// `/dev/urandom` failure is fatal -- no deterministic token fallback,
/// ever.
fn spawn_with_id(app: AppHandle, launch_id: u64) {
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
            handle_termination(&app, "resolve", launch_id);
            return;
        }
    };

    let (mut rx, mut child) = match command.spawn() {
        Ok(pair) => pair,
        Err(error) => {
            eprintln!("panthea-desktop: failed to spawn sidecar: {error}");
            handle_termination(&app, "spawn", launch_id);
            return;
        }
    };

    // The token line, then the launch config line (`{models, offline, keys}`),
    // in one write. The config carries keys read from the credential store at
    // this moment and nowhere else; the payload is never logged and is dropped
    // as soon as it is written. Stdin stays open afterwards: its EOF is the
    // sidecar's orphan guard and shutdown signal.
    let written = {
        let launch = build_launch_line(
            app.state::<SettingsStore>().read(),
            app.state::<KeyVault>().0.as_ref(),
        );
        for note in &launch.notes {
            eprintln!("panthea-desktop: {note}");
        }
        child.write(format!("{token}\n{}\n", launch.line).as_bytes())
    };
    if let Err(error) = written {
        eprintln!(
            "panthea-desktop: failed to write launch token and config to sidecar stdin: {error}"
        );
        // An unauthenticated child must never be tracked as healthy —
        // kill it immediately rather than leaving a live, un-tokened
        // process running with no supervisor awareness of the failure.
        if let Err(kill_error) = child.kill() {
            eprintln!("panthea-desktop: failed to kill un-tokened sidecar: {kill_error}");
        }
        handle_termination(&app, "stdin-write", launch_id);
        return;
    }

    let state = app.state::<SidecarState>();
    let attach_outcome = {
        let mut lifecycle = state
            .lifecycle
            .lock()
            .expect("sidecar state mutex poisoned");
        attach_child(&mut lifecycle, launch_id, child)
    };
    let stale_child = match attach_outcome {
        AttachOutcome::Attached => None,
        AttachOutcome::Refused(child) => Some(child),
    };
    if let Some(child) = stale_child {
        // The launch went stale (a newer spawn or a stop) while this
        // child was resolving, spawning, or being written to -- it was
        // never tracked, so nothing else will ever kill it.
        if let Err(error) = child.kill() {
            eprintln!("panthea-desktop: failed to kill a superseded sidecar: {error}");
        }
        return;
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
                            install_session(&supervised_app, launch_id, port, stdout_token.clone());
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
                    handle_termination(&supervised_app, "terminated", launch_id);
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Installs the session and starts the poll task once `PANTHEA_PORT` is
/// parsed, both under the one lock `on_port` runs in -- there is no
/// window between deciding to poll and actually tracking the poll task
/// where a stop could leave it running untracked. A no-op if
/// `launch_id` is no longer current.
fn install_session(app: &AppHandle, launch_id: u64, port: u16, token: String) {
    let state = app.state::<SidecarState>();
    let mut lifecycle = state
        .lifecycle
        .lock()
        .expect("sidecar state mutex poisoned");
    match on_port(&mut lifecycle, launch_id, port, token) {
        PortOutcome::StartPolling {
            port,
            token,
            launch_id,
        } => {
            let task = crate::proxy::start_polling(app.clone(), port, token, launch_id);
            lifecycle.poll_task = Some(task);
            drop(lifecycle);
            crate::tray::refresh(app);
        }
        PortOutcome::Refused => {}
    }
}

/// Handles a spawn/token-write/unexpected-exit failure for `launch_id`:
/// a no-op unless it is still current. Otherwise aborts the poll task
/// (if one was running) after unlock, and either schedules a backoff
/// retry or marks the supervisor exhausted.
fn handle_termination(app: &AppHandle, reason: &str, launch_id: u64) {
    let state = app.state::<SidecarState>();
    let quitting = *state.quitting.lock().expect("sidecar state mutex poisoned");

    let result = {
        let mut lifecycle = state
            .lifecycle
            .lock()
            .expect("sidecar state mutex poisoned");
        on_terminated(&mut lifecycle, launch_id, quitting)
    };

    if let Some(task) = result.poll_task {
        task.abort();
    }

    match result.outcome {
        TerminatedOutcome::Stale => {}
        TerminatedOutcome::Stopped => {
            crate::tray::refresh(app);
        }
        TerminatedOutcome::Retry {
            backoff,
            retry_launch_id,
            attempt,
        } => {
            eprintln!(
                "panthea-desktop: sidecar attempt failed ({reason}); retrying in {backoff:?} (attempt {attempt}/{MAX_RESTARTS})"
            );
            let app_for_retry = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(backoff);
                spawn_retry(app_for_retry, retry_launch_id);
            });
            crate::tray::refresh(app);
        }
        TerminatedOutcome::Exhausted => {
            eprintln!(
                "panthea-desktop: sidecar exceeded {MAX_RESTARTS} restart attempts (last failure: {reason}); giving up — the app keeps running with no simulation service"
            );
            // The tray's Unavailable checkbox item (set by the refresh
            // below, driven by the same exhausted flag) surfaces this
            // to the operator -- no separate tooltip write needed.
            crate::tray::refresh(app);
        }
    }
}

/// Stops the sidecar: marks it stopped, then kills the tracked child
/// and aborts the poll task (if any) after unlock -- never while
/// holding the lock. Used by both an explicit Stop Background and the
/// app's final exit.
pub fn stop_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let StopResult { child, poll_task } = {
        let mut lifecycle = state
            .lifecycle
            .lock()
            .expect("sidecar state mutex poisoned");
        stop(&mut lifecycle)
    };

    if let Some(child) = child {
        if let Err(error) = child.kill() {
            eprintln!("panthea-desktop: failed to kill sidecar: {error}");
        }
    }
    if let Some(task) = poll_task {
        task.abort();
    }
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
}
