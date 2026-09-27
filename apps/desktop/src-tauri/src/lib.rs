// Panthea desktop shell (ADR-0003 backend-lifecycle probe). Owns the Bun
// simulation sidecar as a supervised child process: spawns it with a
// per-launch auth token over stdin (never argv or env, never logged),
// restarts it with backoff on unexpected exit, keeps the app alive in the
// tray when the window closes, and kills the sidecar on explicit quit.
//
// See tools/probes/backend-lifecycle/README.md for the measured evidence
// this shell was built to produce.

use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Matches the `externalBin` entry name in `tauri.conf.json` (the target
/// triple suffix is stripped by Tauri's sidecar bundling convention).
const SIDECAR_NAME: &str = "panthea-sim";
const MAX_RESTARTS: u32 = 3;

/// Tracks the running sidecar child, the tray handle (so a supervisor
/// failure can update its tooltip), and shutdown/failure intent across the
/// supervisor's background threads and the app-level `RunEvent` handlers.
#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
    restarts: Mutex<u32>,
    /// Set the moment an explicit Quit is requested, so the supervisor
    /// stops restarting and `RunEvent::ExitRequested` stops preventing exit.
    quitting: Mutex<bool>,
    /// Set once the supervisor gives up after `MAX_RESTARTS` failed
    /// attempts — the app keeps running (renderer never blocked), but with
    /// no simulation service. Surfaced via the tray tooltip and logs.
    exhausted: Mutex<bool>,
    tray: Mutex<Option<TrayIcon>>,
}

/// Mints a per-launch auth token: 32 random bytes read from `/dev/urandom`,
/// hex-encoded. Minted fresh on every spawn (initial launch and every
/// restart) and never reused, written to argv/env, or logged — the token
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

/// The supervisor's pure retry decision, isolated from `AppHandle` so it's
/// unit-testable without a running Tauri app (see the `tests` module).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttemptOutcome {
    Retry { attempt: u32, backoff: Duration },
    Exhausted,
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

/// Records a failed spawn/token-write/unexpected-exit attempt: clears the
/// tracked child, and either schedules a backoff retry or marks the
/// supervisor exhausted (surfaced via the tray tooltip and an app-state
/// flag) once `MAX_RESTARTS` is exceeded. Never restarts once `quitting`.
fn record_attempt_failure(app: &AppHandle, reason: &str) {
    let state = app.state::<SidecarState>();
    *state.child.lock().expect("sidecar state mutex poisoned") = None;

    if *state.quitting.lock().expect("sidecar state mutex poisoned") {
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
                spawn_sidecar(app_for_retry);
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
}

/// Kills the currently tracked sidecar child, if any. Called from
/// `RunEvent::Exit` (the final step of an explicit quit).
fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let mut guard = state.child.lock().expect("sidecar state mutex poisoned");
    if let Some(child) = guard.take() {
        if let Err(error) = child.kill() {
            eprintln!("panthea-desktop: failed to kill sidecar on exit: {error}");
        }
    }
}

/// Spawns the sidecar, writes its per-launch token to stdin, and installs
/// the restart-with-backoff supervisor (max `MAX_RESTARTS` attempts) on
/// unexpected exit. A `/dev/urandom` failure is fatal (no deterministic
/// token fallback, ever). A resolve, spawn, or stdin-write failure is
/// routed through the same bounded-retry path as an unexpected exit — none
/// of them silently leaves the app with no supervised sidecar and no
/// record of the failure. A child that fails its stdin token write is
/// killed immediately rather than left running unauthenticated.
fn spawn_sidecar(app: AppHandle) {
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
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    print!("panthea-sim: {}", String::from_utf8_lossy(&bytes));
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

/// Builds the Show/Quit tray and returns its handle so a later supervisor
/// giveup can update the tooltip. Quit sets the `quitting` flag (stopping
/// the supervisor and unblocking `RunEvent::ExitRequested`) then calls
/// `AppHandle::exit`, which drives `RunEvent::Exit` where the sidecar is
/// killed.
fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Panthea")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                let state = app.state::<SidecarState>();
                *state.quitting.lock().expect("sidecar state mutex poisoned") = true;
                app.exit(0);
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    } else {
        eprintln!("panthea-desktop: no default window icon available; tray will have no icon");
    }

    builder.build(app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Ordering is fixed (ADR-0003 Key Technical Decisions): the
        // single-instance plugin runs first so a duplicate launch is
        // refused before any sidecar spawn or lock-file check happens.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            spawn_sidecar(handle.clone());
            let tray = build_tray(&handle)?;
            *handle
                .state::<SidecarState>()
                .tray
                .lock()
                .expect("sidecar state mutex poisoned") = Some(tray);

            if let Some(window) = app.get_webview_window("main") {
                let window_handle = handle.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let state = window_handle.state::<SidecarState>();
                        let quitting =
                            *state.quitting.lock().expect("sidecar state mutex poisoned");
                        if !quitting {
                            // Keep running in the tray (ADR-0003): prevent
                            // the actual close and hide instead.
                            api.prevent_close();
                            if let Some(window) = window_handle.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let state = app_handle.state::<SidecarState>();
            let quitting = *state.quitting.lock().expect("sidecar state mutex poisoned");
            if !quitting {
                // A window-close-driven exit request keeps the app running
                // in the tray rather than quitting (ADR-0003).
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            kill_sidecar(app_handle);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
