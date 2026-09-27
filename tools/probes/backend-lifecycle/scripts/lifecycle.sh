#!/usr/bin/env bash
# Drives the packaged Tauri app through every ADR-0003 lifecycle transition
# and records process-tree snapshots, tick continuity (via direct SQLite
# inspection — see README "Caveat" for why this isn't the HTTP API), and
# `PRAGMA integrity_check` results after every kill.
#
# The sidecar's per-launch auth token is minted by the Rust shell, passed
# only over the child's stdin, and never written to logs, disk, or this
# script's output (System-Wide Impact, plan). This script therefore never
# calls the sidecar's HTTP API directly; every "did the tick continue"
# check queries the SQLite database file, which is strictly stronger
# evidence than an authenticated HTTP round trip (it proves the persisted
# state advanced, not just that a socket answered).
#
# Requires: the packaged .app already built and ad-hoc signed (this script
# does that first). macOS only, per M0 scope.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$PROBE_DIR/../../.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/apps/desktop"
TAURI_DIR="$DESKTOP_DIR/src-tauri"

PRODUCT_NAME="panthea-desktop"
APP_BUNDLE="$TAURI_DIR/target/release/bundle/macos/$PRODUCT_NAME.app"
APP_BIN="$APP_BUNDLE/Contents/MacOS/$PRODUCT_NAME"
APP_DATA_DIR="$HOME/Library/Application Support/ai.panthe.desktop"
DB_PATH="$APP_DATA_DIR/probe.sqlite"
LOCK_PATH="$APP_DATA_DIR/lifecycle.lock"

RESULTS_FILE="${PANTHEA_LIFECYCLE_RESULTS:-$PROBE_DIR/lifecycle-results.txt}"
APP_LOG="${PANTHEA_LIFECYCLE_APP_LOG:-$PROBE_DIR/lifecycle-app.log}"

: >"$RESULTS_FILE"

log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$RESULTS_FILE"
}

section() {
  log ""
  log "=== $* ==="
}

# --- process helpers -------------------------------------------------------

app_pid() { pgrep -f "$APP_BIN" | head -n1; }
sidecar_pid() { pgrep -f "src-tauri/target/release/bundle/macos/$PRODUCT_NAME.app/Contents/MacOS/panthea-sim" | head -n1; }

is_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

rss_snapshot() {
  local label="$1"
  log "--- RSS snapshot: $label ---"
  local a s
  a="$(app_pid)"
  s="$(sidecar_pid)"
  if [[ -n "$a" ]]; then
    ps -o pid,ppid,rss,comm -p "$a" | tee -a "$RESULTS_FILE"
  else
    log "(shell process not found)"
  fi
  if [[ -n "$s" ]]; then
    ps -o pid,ppid,rss,comm -p "$s" | tee -a "$RESULTS_FILE"
  else
    log "(sidecar process not found)"
  fi
}

db_status() {
  local label="$1"
  log "--- DB status: $label ---"
  if [[ -f "$DB_PATH" ]]; then
    sqlite3 "$DB_PATH" \
      "SELECT 'events=' || COUNT(*) || ' last_id=' || COALESCE(MAX(id),'null') || ' last_sim_t=' || COALESCE(MAX(sim_t),'null') FROM events;" \
      | tee -a "$RESULTS_FILE"
    sqlite3 "$DB_PATH" "SELECT 'cursor_wall_ms=' || cursor_wall_ms FROM clock LIMIT 1;" | tee -a "$RESULTS_FILE"
  else
    log "(no db at $DB_PATH)"
  fi
}

integrity_check() {
  local label="$1"
  if [[ -f "$DB_PATH" ]]; then
    log "PRAGMA integrity_check ($label): $(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')"
  else
    log "PRAGMA integrity_check ($label): (no db)"
  fi
}

lock_status() {
  local label="$1"
  if [[ -f "$LOCK_PATH" ]]; then
    log "lock ($label): $(cat "$LOCK_PATH")"
  else
    log "lock ($label): (no lock file)"
  fi
}

launch_app() {
  log "launching $APP_BIN (stdout/stderr -> $APP_LOG)"
  : >"$APP_LOG"
  "$APP_BIN" >>"$APP_LOG" 2>&1 &
  disown
  sleep 3
  local a
  a="$(app_pid)"
  if [[ -z "$a" ]]; then
    log "FAIL: app did not stay running after launch"
    return 1
  fi
  log "app pid=$a"
  # Give the sidecar a moment to bind + start ticking.
  sleep 2
}

stop_app_gracefully() {
  local a
  a="$(app_pid)"
  if [[ -n "$a" ]]; then
    log "SIGTERM app pid=$a (Quit-equivalent — see README Caveat on tray automation)"
    kill -TERM "$a" 2>/dev/null || true
    for _ in $(seq 1 20); do
      is_alive "$a" || break
      sleep 0.5
    done
  fi
}

# --- build -------------------------------------------------------------

build_and_sign() {
  section "Build + ad-hoc sign"
  bash "$SCRIPT_DIR/build-sidecar.sh" 2>&1 | tee -a "$RESULTS_FILE"
  bash "$SCRIPT_DIR/scan-binary.sh" 2>&1 | tee -a "$RESULTS_FILE"

  log "running: bun run --cwd $DESKTOP_DIR tauri build"
  (cd "$DESKTOP_DIR" && bun run tauri build) 2>&1 | tee -a "$RESULTS_FILE"

  if [[ ! -d "$APP_BUNDLE" ]]; then
    log "FAIL: expected bundle not found at $APP_BUNDLE"
    exit 1
  fi

  log "ad-hoc signing (M0 probe only — never release guidance): codesign -s - + xattr -cr"
  codesign -s - --force --deep "$APP_BUNDLE" 2>&1 | tee -a "$RESULTS_FILE"
  xattr -cr "$APP_BUNDLE"
  codesign -dv "$APP_BUNDLE" 2>&1 | tee -a "$RESULTS_FILE" || true
}

# --- transitions ---------------------------------------------------------

transition_close_window_then_quit() {
  section "Transition 1: start -> close window -> verify tick continues -> Quit -> verify exit"
  rm -f "$LOCK_PATH"
  launch_app || return 1
  rss_snapshot "after start"
  db_status "after start"

  log "closing main window via AppleScript (System Events)"
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $(app_pid)) to click button 1 of window 1" \
    2>&1 | tee -a "$RESULTS_FILE" || log "(AppleScript close-window failed — see README manual fallback)"
  sleep 3

  if is_alive "$(app_pid)"; then
    log "PASS: shell process still alive after window close (kept running in tray)"
  else
    log "FAIL: shell process exited on window close (tray behavior not working)"
  fi

  db_status "before waiting for tick after close"
  sleep 5
  db_status "after waiting 5s post-close (tick should have advanced)"

  stop_app_gracefully
  sleep 1
  if is_alive "$(app_pid)"; then
    log "FAIL: shell process still alive after Quit-equivalent SIGTERM"
  else
    log "PASS: shell process exited after Quit-equivalent SIGTERM"
  fi
  if is_alive "$(sidecar_pid)"; then
    log "FAIL: sidecar still alive after shell exit (orphan)"
  else
    log "PASS: sidecar not running after shell exit (no orphan)"
  fi
  integrity_check "after transition 1"
  lock_status "after transition 1"
}

transition_kill_sidecar_restart() {
  section "Transition 2: start -> kill -9 sidecar -> verify supervisor restarts + event continuity"
  rm -f "$LOCK_PATH"
  launch_app || return 1
  db_status "before kill"
  local before_sidecar_pid
  before_sidecar_pid="$(sidecar_pid)"
  log "sidecar pid before kill: $before_sidecar_pid"

  if [[ -z "$before_sidecar_pid" ]]; then
    log "FAIL: no sidecar process found to kill"
    stop_app_gracefully
    return 1
  fi

  kill -9 "$before_sidecar_pid"
  log "sent kill -9 to sidecar pid $before_sidecar_pid"
  sleep 5

  local after_sidecar_pid
  after_sidecar_pid="$(sidecar_pid)"
  log "sidecar pid after supervisor restart: $after_sidecar_pid"
  if [[ -n "$after_sidecar_pid" && "$after_sidecar_pid" != "$before_sidecar_pid" ]]; then
    log "PASS: supervisor restarted the sidecar with a new pid"
  else
    log "FAIL: supervisor did not restart the sidecar (pid=$after_sidecar_pid)"
  fi

  sleep 3
  db_status "after restart (event ids should continue increasing, not reset)"
  integrity_check "after transition 2"
  rss_snapshot "after transition 2"

  stop_app_gracefully
}

transition_kill_app_force() {
  section "Transition 3: start -> kill -9 app -> verify sidecar exits <=10s and lock reclaimable"
  rm -f "$LOCK_PATH"
  launch_app || return 1
  local a s
  a="$(app_pid)"
  s="$(sidecar_pid)"
  log "app pid=$a sidecar pid=$s"

  kill -9 "$a"
  log "sent kill -9 to app pid $a"

  local waited=0
  while is_alive "$s" && [[ "$waited" -lt 10 ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  if is_alive "$s"; then
    log "FAIL: sidecar still alive ${waited}s after app force-kill (orphaned)"
  else
    log "PASS: sidecar exited within ${waited}s of app force-kill (no orphan)"
  fi
  integrity_check "after transition 3"
  lock_status "after transition 3 (pid $s should now be dead)"

  log "starting a fresh app instance to verify the stale lock is reclaimed"
  launch_app || return 1
  sleep 2
  lock_status "after reclaim attempt (pid should be the new sidecar's pid)"
  if grep -q "reclaimed stale lock" "$APP_LOG"; then
    log "PASS: app log shows the stale lock was reclaimed"
  else
    log "NOTE: 'reclaimed stale lock' not found in app log — check $APP_LOG manually"
  fi
  stop_app_gracefully
}

transition_duplicate_start() {
  section "Transition 4: second launch while running -> refused"
  rm -f "$LOCK_PATH"
  launch_app || return 1
  local first_pid
  first_pid="$(app_pid)"
  log "first instance pid=$first_pid"

  log "launching a second instance directly (bypassing Launch Services single-instance re-focus)"
  "$APP_BIN" >"$PROBE_DIR/lifecycle-second-instance.log" 2>&1 &
  local second_pid=$!
  sleep 2

  if is_alive "$second_pid"; then
    log "FAIL: second instance still running as its own process (single-instance plugin did not refuse it)"
    kill -9 "$second_pid" 2>/dev/null || true
  else
    log "PASS: second instance exited immediately (tauri-plugin-single-instance refused it)"
  fi

  local after_first_pid
  after_first_pid="$(app_pid)"
  if [[ "$after_first_pid" == "$first_pid" ]]; then
    log "PASS: original instance (pid=$first_pid) is still the only one running"
  else
    log "NOTE: original instance pid changed unexpectedly (was $first_pid, now $after_first_pid)"
  fi

  stop_app_gracefully
}

transition_simulated_sleep() {
  section "Transition 5: SIGSTOP sidecar 120s, SIGCONT -> interval applied once (pmset sleepnow is a manual owner step, see README)"
  rm -f "$LOCK_PATH"
  launch_app || return 1
  sleep 3
  local s
  s="$(sidecar_pid)"
  db_status "before SIGSTOP"

  log "SIGSTOP sidecar pid=$s"
  kill -STOP "$s"
  log "sleeping 120s with the sidecar stopped (simulates display sleep; the shell process stays running)"
  sleep 120

  log "SIGCONT sidecar pid=$s"
  kill -CONT "$s"
  sleep 3
  db_status "after SIGCONT (one tick should show a ~120000ms jump, not a repeat)"
  sleep 3
  db_status "one tick later (should be a normal ~1000ms increment, confirming the jump wasn't reapplied)"
  integrity_check "after transition 5"

  stop_app_gracefully
}

main() {
  build_and_sign
  transition_close_window_then_quit
  transition_kill_sidecar_restart
  transition_kill_app_force
  transition_duplicate_start
  transition_simulated_sleep
  section "Done — see $RESULTS_FILE and $APP_LOG"
}

main "$@"
