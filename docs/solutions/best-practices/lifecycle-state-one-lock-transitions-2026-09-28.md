---
title: One lock over lifecycle state, transitions as pure functions
date: 2026-09-28
category: best-practices
module: desktop-lifecycle
problem_type: design_pattern
component: development_workflow
severity: high
applies_when:
  - Several async sources (process events, timers, poll tasks, UI callbacks) read or mutate state that must stay consistent together
  - Adding a new transition to a supervised child process's lifecycle
  - A UI refresh, tray, or menu callback needs current state without racing a scheduled update
  - Reviewing code where more than one mutex guards related fields
tags: [mutex, state-machine, launch-id, check-then-act, tauri, sidecar, main-thread, race-condition]
---

# One lock over lifecycle state, transitions as pure functions

## Context

Each race below passed the sidecar supervisor's unit tests and was only caught in review.

| Round | What happened |
|---|---|
| 1 | Late or reloaded subscriber gets no frame. `last_frame` marked though nothing delivered. In-flight frame leaks across restart. Pending retry undoes Stop. No request timeout. |
| 2 | Generation read under one lock and frame applied under others. Subscribe cloned, sent, then installed the channel. Fix attempt: one frame-state mutex. |
| 3 | `clear_session` didn't bump the generation, so an in-flight poll revived a dead session. An old child's `Terminated` after Stop→Restart cleared the new child and scheduled a spawn. Fix attempt: launch id. |
| 4 | The launch check released its lock before the mutation. Stop→Restart could land between check and clear, Stop between `on_port`'s check and install, and a retry passing its check could spawn after Stop. Fix: all lifecycle state in one `Mutex<Lifecycle>`. |
| 5 | Tray refresh held a mutex while Tauri menu calls blocked on the main thread, which could deadlock. A refresh that snapshotted state before scheduling could overwrite Stopped. Fix: `tray::refresh` schedules `app.run_on_main_thread`, reads state inside the closure, and holds no lock across menu calls. |

## Guidance

1. One lock over all state that callbacks from different sources (process events, timers, poll tasks, UI) read or change together.
2. Transitions are pure functions on `&mut State` that check and mutate in one step and return effects.
3. Effects (kill a process, abort a task, UI calls that may block on the main thread) run after unlock. Never hold the lock across `.await`.
4. Tag each launch or attempt with an id that every transition checks under the same lock.
5. Do blocking work such as spawning a child outside the lock. The attach step refuses, and the caller kills the child, if its launch went stale meanwhile.
6. UI refresh reads state when it runs, never a snapshot taken before scheduling. For Tauri menu or tray calls, schedule with `run_on_main_thread` and hold no lock across them.
7. Test transitions as pure functions driven in the adversarial orders. Per-field fences added one race at a time don't converge.

## Why This Matters

Splitting related state across several locks, or releasing a lock between a check and the mutation it authorized, opens a window a concurrent transition can land in. Each round above closed one such window and opened another, because the fix added a fence around one field instead of collapsing the state. A transition that checks and mutates in the same locked step, tagged with an id that later callbacks re-check, has no window to land in — the check and the authority it grants can't be pulled apart by anything that runs between them, because nothing runs between them.

## When to Apply

- A struct with fields several async sources read or write, where a stale read or a partial update is observable
- Adding a new transition (a new way the state can begin, end, or change) to an existing lifecycle
- A read-then-act callback (process exit, timer fire, poll response) that assumes the state it read still holds when it acts
- A UI or menu callback that must reflect current state and may itself block the thread doing the reading

## Examples

Before: sidecar state sat behind separate mutexes, none of them tying a launch attempt to what it was allowed to touch:

```rust
#[derive(Default)]
pub struct SidecarState {
    pub child: Mutex<Option<CommandChild>>,
    pub restarts: Mutex<u32>,
    pub quitting: Mutex<bool>,
    pub exhausted: Mutex<bool>,
    pub stopped: Mutex<bool>,
    pub tray: Mutex<Option<TrayIcon>>,
    pub session: Mutex<Option<SidecarSession>>,
    pub poll_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub window_hidden: Mutex<bool>,
    pub frame: Mutex<FrameState>,
}
```

After: one `Mutex<Lifecycle>` holds everything a launch and its supervision touch, keyed by a `launch_id` every transition checks under the same lock:

```rust
#[derive(Default)]
pub struct Lifecycle {
    pub launch_id: u64,
    pub child: Option<CommandChild>,
    pub session: Option<SidecarSession>,
    pub poll_task: Option<tauri::async_runtime::JoinHandle<()>>,
    pub stopped: bool,
    pub exhausted: bool,
    pub restarts: u32,
    // ...last_frame, last_frame_body, world, channel: all behind this same lock
}

pub struct SidecarState {
    pub quitting: Mutex<bool>,
    pub window_hidden: Mutex<bool>,
    pub tray: Mutex<Option<TrayIcon>>,
    pub lifecycle: Mutex<Lifecycle>,
}
```

Transitions are pure functions that check and mutate together and hand back effects for the caller to run after unlock:

```rust
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

pub fn attach_into<T>(slot: &mut Option<T>, allowed: bool, value: T) -> Result<(), T> {
    if !allowed {
        return Err(value);
    }
    *slot = Some(value);
    Ok(())
}
```

`on_terminated` is a no-op for a launch id a later spawn or stop has already superseded, instead of touching whatever launch is current now:

```rust
pub fn on_terminated(
    lifecycle: &mut Lifecycle,
    launch_id: u64,
    quitting: bool,
) -> TerminatedResult {
    let current = is_current(lifecycle, launch_id);
    // ...take the poll task and child only if current
    if !current {
        return TerminatedResult { poll_task, outcome: TerminatedOutcome::Stale };
    }
    // ...clear session, end the launch, decide retry or exhausted
}
```

`on_retry` refuses before `begin_spawn`'s own check ever runs, if the retry's captured id went stale while it waited on backoff:

```rust
pub fn on_retry(lifecycle: &mut Lifecycle, launch_id: u64) -> Option<u64> {
    if !is_current(lifecycle, launch_id) {
        return None;
    }
    begin_spawn(lifecycle)
}
```

`stop` ends the launch (bumping the id fences out anything still carrying the old one) and takes the child and poll task out for the caller to kill/abort after unlock:

```rust
pub fn stop(lifecycle: &mut Lifecycle) -> StopResult {
    lifecycle.stopped = true;
    lifecycle.launch_id += 1;
    let child = lifecycle.child.take();
    let poll_task = lifecycle.poll_task.take();
    lifecycle.session = None;
    reset_frame_fields(lifecycle);
    StopResult { child, poll_task }
}
```

The tray never holds a lock across a Tauri menu call: `refresh` only schedules the read-and-rebuild onto the main thread.

```rust
pub fn refresh(app: &AppHandle) {
    let app_for_refresh = app.clone();
    if let Err(error) = app.run_on_main_thread(move || refresh_on_main_thread(&app_for_refresh)) {
        eprintln!("panthea-desktop: failed to schedule a tray refresh: {error}");
    }
}

fn refresh_on_main_thread(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let (stopped, exhausted, world) = {
        let lifecycle = state.lifecycle.lock().expect("sidecar state mutex poisoned");
        (lifecycle.stopped, lifecycle.exhausted, lifecycle.world.clone())
    };
    // ...the lock guard is dropped here, before build_menu/set_menu run
}
```

An adversarial test, from `apps/desktop/src-tauri/src/state.rs`:

```rust
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

    // The old child's late Terminated event, still carrying old_id.
    let result = on_terminated(&mut lifecycle, old_id, false);

    assert_eq!(result.outcome, TerminatedOutcome::Stale);
    assert!(result.poll_task.is_none());
    assert_eq!(lifecycle.session, before_session);
    assert_eq!(lifecycle.launch_id, before_launch_id);
}
```

## Related

- [Authoritative rules take intent from proposals and everything else from the world](authoritative-rule-validation-2026-09-27.md)
- [0003: Simulation service](../../decisions/0003-simulation-service.md)
