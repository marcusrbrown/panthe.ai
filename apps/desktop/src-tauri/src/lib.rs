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
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Matches the `externalBin` entry name in `tauri.conf.json` (the target
/// triple suffix is stripped by Tauri's sidecar bundling convention).
const SIDECAR_NAME: &str = "panthea-sim";
const MAX_RESTARTS: u32 = 3;

/// Tracks the running sidecar child and shutdown intent across the
/// supervisor's async task and the app-level `RunEvent` handlers.
#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
    restarts: Mutex<u32>,
    /// Set the moment an explicit Quit is requested, so the supervisor
    /// stops restarting and `RunEvent::ExitRequested` stops preventing exit.
    quitting: Mutex<bool>,
}

/// Mints a per-launch auth token: 32 random bytes from `/dev/urandom`,
/// hex-encoded. Minted fresh on every spawn (initial launch and every
/// restart) and never reused, written to argv/env, or logged — the token
/// exists only in this process's memory and the child's stdin.
fn generate_token() -> String {
    let mut buf = [0u8; 32];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut buf))
        .is_err()
    {
        // Extremely unlikely fallback (no /dev/urandom): mix pid and time
        // so startup still gets *a* per-launch value instead of failing.
        // Not exercised on the M0 macOS target.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let seed = u128::from(std::process::id()) ^ nanos;
        for (index, byte) in buf.iter_mut().enumerate() {
            *byte = ((seed >> ((index % 16) * 8)) & 0xff) as u8;
        }
    }
    buf.iter().map(|byte| format!("{byte:02x}")).collect()
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
/// the restart-with-backoff supervisor (max 3 attempts) on unexpected exit.
/// Never restarts once `quitting` is set.
fn spawn_sidecar(app: AppHandle) {
    let token = generate_token();
    let shell = app.shell();
    let command = match shell.sidecar(SIDECAR_NAME) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("panthea-desktop: failed to resolve sidecar \"{SIDECAR_NAME}\": {error}");
            return;
        }
    };

    let (mut rx, mut child) = match command.spawn() {
        Ok(pair) => pair,
        Err(error) => {
            eprintln!("panthea-desktop: failed to spawn sidecar: {error}");
            return;
        }
    };

    if let Err(error) = child.write(format!("{token}\n").as_bytes()) {
        eprintln!("panthea-desktop: failed to write launch token to sidecar stdin: {error}");
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
                    let state = supervised_app.state::<SidecarState>();
                    *state.child.lock().expect("sidecar state mutex poisoned") = None;

                    let quitting = *state.quitting.lock().expect("sidecar state mutex poisoned");
                    if quitting {
                        break;
                    }

                    let attempt = {
                        let mut restarts =
                            state.restarts.lock().expect("sidecar state mutex poisoned");
                        if *restarts >= MAX_RESTARTS {
                            eprintln!(
                                "panthea-desktop: sidecar exceeded {MAX_RESTARTS} restarts; giving up"
                            );
                            break;
                        }
                        *restarts += 1;
                        *restarts
                    };

                    // Exponential backoff (500ms, 1s, 2s). Blocking this
                    // background async task briefly is an acceptable
                    // tradeoff for a probe rather than adding `tokio` as a
                    // direct dependency solely for `tokio::time::sleep`.
                    let backoff = Duration::from_millis(500 * 2u64.pow(attempt.saturating_sub(1)));
                    std::thread::sleep(backoff);
                    spawn_sidecar(supervised_app.clone());
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Builds the Show/Quit tray. Quit sets the `quitting` flag (stopping the
/// supervisor and unblocking `RunEvent::ExitRequested`) then calls
/// `AppHandle::exit`, which drives `RunEvent::Exit` where the sidecar is
/// killed.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
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

    builder.build(app)?;
    Ok(())
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
            build_tray(&handle)?;

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
