// Tray icon: shows the current lifecycle state (running, paused,
// background, or stopped) marked as checked, a degraded label with its
// reason when the sidecar reports it, and Show/Pause/Resume/Stop
// Background/Quit actions. Pause and resume relay to the sidecar over
// the proxy's HTTP client; the tray itself never touches the token
// directly.

use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager};

use crate::state::{SidecarSession, SidecarState};

const ITEM_STATE_RUNNING: &str = "state_running";
const ITEM_STATE_PAUSED: &str = "state_paused";
const ITEM_STATE_BACKGROUND: &str = "state_background";
const ITEM_STATE_STOPPED: &str = "state_stopped";
const ITEM_STATE_UNAVAILABLE: &str = "state_unavailable";
const ITEM_DEGRADED: &str = "degraded";
const ITEM_SHOW: &str = "show";
const ITEM_PAUSE: &str = "pause";
const ITEM_RESUME: &str = "resume";
const ITEM_STOP_BACKGROUND: &str = "stop_background";
const ITEM_QUIT: &str = "quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Running,
    Paused,
    Background,
    Stopped,
    Unavailable,
}

/// What the Stop/Restart tray item does when clicked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Stop,
    Restart,
}

/// Decides the Stop/Restart tray item's action: restart whenever
/// there's no live sidecar to stop -- an explicit Stop Background, or
/// the restart supervisor having given up -- and stop otherwise. The
/// menu label and the click handler both derive from this same
/// decision, so they can never disagree about what the item does.
pub fn stop_or_restart(stopped: bool, exhausted: bool) -> Action {
    if stopped || exhausted {
        Action::Restart
    } else {
        Action::Stop
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayDisplay {
    pub state: TrayState,
    pub degraded_reason: Option<String>,
    pub action: Action,
}

/// Maps the sidecar's reported world status, whether the operator
/// explicitly stopped it, whether the restart supervisor gave up, and
/// window visibility to the tray's checked state and degraded label.
///
/// `sidecar_stopped` takes priority over everything else -- a stopped
/// sidecar has no world status to report. `exhausted` takes priority
/// over the world status next -- a supervisor that gave up has no live
/// sidecar to report a status for either. The degraded label only ever
/// carries a reason when `world_status` is actually `"degraded"`; a
/// reason value with any other status is not surfaced, since it would
/// describe a state the world isn't currently in.
pub fn map_tray_display(
    sidecar_stopped: bool,
    exhausted: bool,
    window_visible: bool,
    world_status: Option<&str>,
    degraded_reason: Option<&str>,
) -> TrayDisplay {
    let action = stop_or_restart(sidecar_stopped, exhausted);
    if sidecar_stopped {
        return TrayDisplay {
            state: TrayState::Stopped,
            degraded_reason: None,
            action,
        };
    }
    if exhausted {
        return TrayDisplay {
            state: TrayState::Unavailable,
            degraded_reason: None,
            action,
        };
    }
    let state = match world_status {
        Some("paused") => TrayState::Paused,
        _ if window_visible => TrayState::Running,
        _ => TrayState::Background,
    };
    let degraded_reason = if world_status == Some("degraded") {
        degraded_reason.map(str::to_string)
    } else {
        None
    };
    TrayDisplay {
        state,
        degraded_reason,
        action,
    }
}

fn build_menu(app: &AppHandle, display: &TrayDisplay) -> tauri::Result<Menu<tauri::Wry>> {
    let state_running = CheckMenuItemBuilder::with_id(ITEM_STATE_RUNNING, "Running")
        .enabled(false)
        .checked(display.state == TrayState::Running)
        .build(app)?;
    let state_paused = CheckMenuItemBuilder::with_id(ITEM_STATE_PAUSED, "Paused")
        .enabled(false)
        .checked(display.state == TrayState::Paused)
        .build(app)?;
    let state_background = CheckMenuItemBuilder::with_id(ITEM_STATE_BACKGROUND, "Background")
        .enabled(false)
        .checked(display.state == TrayState::Background)
        .build(app)?;
    let state_stopped = CheckMenuItemBuilder::with_id(ITEM_STATE_STOPPED, "Stopped")
        .enabled(false)
        .checked(display.state == TrayState::Stopped)
        .build(app)?;
    let state_unavailable = CheckMenuItemBuilder::with_id(ITEM_STATE_UNAVAILABLE, "Unavailable")
        .enabled(false)
        .checked(display.state == TrayState::Unavailable)
        .build(app)?;

    let mut builder = MenuBuilder::new(app).items(&[
        &state_running,
        &state_paused,
        &state_background,
        &state_stopped,
        &state_unavailable,
    ]);

    let degraded_item;
    if let Some(reason) = &display.degraded_reason {
        degraded_item = MenuItemBuilder::with_id(ITEM_DEGRADED, format!("Degraded: {reason}"))
            .enabled(false)
            .build(app)?;
        builder = builder.item(&degraded_item);
    }

    let show_item = MenuItemBuilder::with_id(ITEM_SHOW, "Show").build(app)?;
    let pause_item = MenuItemBuilder::with_id(ITEM_PAUSE, "Pause")
        .enabled(display.state == TrayState::Running || display.state == TrayState::Background)
        .build(app)?;
    let resume_item = MenuItemBuilder::with_id(ITEM_RESUME, "Resume")
        .enabled(display.state == TrayState::Paused)
        .build(app)?;
    let stop_label = match display.action {
        Action::Restart => "Restart Simulation",
        Action::Stop => "Stop Background",
    };
    let stop_item = MenuItemBuilder::with_id(ITEM_STOP_BACKGROUND, stop_label).build(app)?;
    let quit_item = MenuItemBuilder::with_id(ITEM_QUIT, "Quit").build(app)?;

    builder
        .separator()
        .items(&[&show_item, &pause_item, &resume_item, &stop_item])
        .separator()
        .item(&quit_item)
        .build()
}

/// Builds the tray, registering `on_menu_event` once for the tray's
/// whole lifetime -- later state changes call `refresh`, which replaces
/// the menu (`TrayIcon::set_menu`) without re-registering the handler.
pub fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let initial = TrayDisplay {
        state: TrayState::Running,
        degraded_reason: None,
        action: Action::Stop,
    };
    let menu = build_menu(app, &initial)?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Panthea")
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()));

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    } else {
        eprintln!("panthea-desktop: no default window icon available; tray will have no icon");
    }

    builder.build(app)
}

/// Rebuilds and replaces the tray menu from the current state -- called
/// whenever the sidecar's reported status, the session, or window
/// visibility changes.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let stopped = *state.stopped.lock().expect("sidecar state mutex poisoned");
    let exhausted = *state
        .exhausted
        .lock()
        .expect("sidecar state mutex poisoned");
    let window_visible = !*state
        .window_hidden
        .lock()
        .expect("sidecar state mutex poisoned");
    let world = state
        .frame
        .lock()
        .expect("sidecar state mutex poisoned")
        .world
        .clone();

    let display = map_tray_display(
        stopped,
        exhausted,
        window_visible,
        world.status.as_deref(),
        world.degraded_reason.as_deref(),
    );

    let tray_guard = state.tray.lock().expect("sidecar state mutex poisoned");
    let Some(tray) = tray_guard.as_ref() else {
        return;
    };
    match build_menu(app, &display) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(error) => {
            eprintln!("panthea-desktop: failed to rebuild the tray menu: {error}");
        }
    }
}

fn current_session(app: &AppHandle) -> Option<SidecarSession> {
    app.state::<SidecarState>()
        .session
        .lock()
        .expect("sidecar state mutex poisoned")
        .clone()
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    *app.state::<SidecarState>()
        .window_hidden
        .lock()
        .expect("sidecar state mutex poisoned") = false;
    refresh(app);
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        ITEM_SHOW => show_window(app),
        ITEM_QUIT => {
            let state = app.state::<SidecarState>();
            *state.quitting.lock().expect("sidecar state mutex poisoned") = true;
            app.exit(0);
        }
        ITEM_PAUSE => trigger_pause(app),
        ITEM_RESUME => trigger_resume(app),
        ITEM_STOP_BACKGROUND => trigger_stop_or_restart(app),
        _ => {}
    }
}

fn trigger_pause(app: &AppHandle) {
    let Some(session) = current_session(app) else {
        eprintln!("panthea-desktop: /pause requested with no active sidecar session");
        return;
    };
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::proxy::pause(session.port, &session.token).await {
            eprintln!("panthea-desktop: /pause request failed: {error}");
        }
    });
}

fn trigger_resume(app: &AppHandle) {
    let Some(session) = current_session(app) else {
        eprintln!("panthea-desktop: /resume requested with no active sidecar session");
        return;
    };
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::proxy::resume(session.port, &session.token).await {
            eprintln!("panthea-desktop: /resume request failed: {error}");
        }
    });
}

fn trigger_stop_or_restart(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let stopped = *state.stopped.lock().expect("sidecar state mutex poisoned");
    let exhausted = *state
        .exhausted
        .lock()
        .expect("sidecar state mutex poisoned");

    match stop_or_restart(stopped, exhausted) {
        Action::Restart => {
            // Only this action clears `stopped`/`exhausted` -- spawn_sidecar
            // itself never does, so a retry left pending from before a
            // Stop stays cancelled. The restart counter resets too, so
            // backoff starts fresh rather than picking up where the
            // supervisor gave up.
            *state.stopped.lock().expect("sidecar state mutex poisoned") = false;
            *state
                .exhausted
                .lock()
                .expect("sidecar state mutex poisoned") = false;
            *state.restarts.lock().expect("sidecar state mutex poisoned") = 0;
            crate::sidecar::spawn_sidecar(app.clone());
        }
        Action::Stop => {
            *state.stopped.lock().expect("sidecar state mutex poisoned") = true;
            crate::sidecar::kill_sidecar(app);
            show_window(app);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stopped_sidecar_always_maps_to_stopped_with_no_degraded_label() {
        let display = map_tray_display(true, false, true, Some("degraded"), Some("disk-full"));
        assert_eq!(
            display,
            TrayDisplay {
                state: TrayState::Stopped,
                degraded_reason: None,
                action: Action::Restart,
            }
        );
    }

    #[test]
    fn a_paused_world_maps_to_paused_regardless_of_window_visibility() {
        assert_eq!(
            map_tray_display(false, false, true, Some("paused"), None).state,
            TrayState::Paused
        );
        assert_eq!(
            map_tray_display(false, false, false, Some("paused"), None).state,
            TrayState::Paused
        );
    }

    #[test]
    fn a_running_world_with_a_visible_window_maps_to_running() {
        assert_eq!(
            map_tray_display(false, false, true, Some("running"), None).state,
            TrayState::Running
        );
    }

    #[test]
    fn a_running_world_with_a_hidden_window_maps_to_background() {
        assert_eq!(
            map_tray_display(false, false, false, Some("running"), None).state,
            TrayState::Background
        );
    }

    #[test]
    fn a_degraded_world_carries_its_reason_and_still_reflects_window_visibility() {
        let visible = map_tray_display(false, false, true, Some("degraded"), Some("disk-full"));
        assert_eq!(visible.state, TrayState::Running);
        assert_eq!(visible.degraded_reason, Some("disk-full".to_string()));

        let hidden = map_tray_display(false, false, false, Some("degraded"), Some("store-error"));
        assert_eq!(hidden.state, TrayState::Background);
        assert_eq!(hidden.degraded_reason, Some("store-error".to_string()));
    }

    #[test]
    fn a_reason_present_without_a_degraded_status_is_never_surfaced() {
        let display = map_tray_display(false, false, true, Some("running"), Some("stale-reason"));
        assert_eq!(display.degraded_reason, None);
    }

    #[test]
    fn no_world_status_yet_falls_back_to_window_visibility() {
        assert_eq!(
            map_tray_display(false, false, true, None, None).state,
            TrayState::Running
        );
        assert_eq!(
            map_tray_display(false, false, false, None, None).state,
            TrayState::Background
        );
    }

    #[test]
    fn an_exhausted_supervisor_maps_to_unavailable_regardless_of_window_visibility() {
        assert_eq!(
            map_tray_display(false, true, true, None, None).state,
            TrayState::Unavailable
        );
        assert_eq!(
            map_tray_display(false, true, false, None, None).state,
            TrayState::Unavailable
        );
    }

    #[test]
    fn an_explicit_stop_takes_priority_over_exhausted() {
        let display = map_tray_display(true, true, true, None, None);
        assert_eq!(display.state, TrayState::Stopped);
    }

    #[test]
    fn stop_or_restart_covers_all_four_combinations() {
        assert_eq!(stop_or_restart(false, false), Action::Stop);
        assert_eq!(stop_or_restart(true, false), Action::Restart);
        assert_eq!(stop_or_restart(false, true), Action::Restart);
        assert_eq!(stop_or_restart(true, true), Action::Restart);
    }

    #[test]
    fn the_running_display_action_is_stop() {
        let display = map_tray_display(false, false, true, Some("running"), None);
        assert_eq!(display.action, Action::Stop);
    }

    #[test]
    fn the_stopped_display_action_is_restart() {
        let display = map_tray_display(true, false, true, None, None);
        assert_eq!(display.action, Action::Restart);
    }

    #[test]
    fn the_unavailable_display_action_is_restart() {
        let display = map_tray_display(false, true, true, None, None);
        assert_eq!(display.action, Action::Restart);
    }
}
