#!/usr/bin/env bash
# Drives the packaged Tauri app through every ADR-0003 lifecycle transition
# and records process-tree snapshots, tick continuity (via direct SQLite
# inspection — see README "Caveat" for why this isn't the HTTP API), and
# `PRAGMA integrity_check` results after every kill.
#
# `set -euo pipefail`: every transition asserts its condition and the
# script exits non-zero (immediately, fail-fast) the moment one doesn't
# hold, rather than logging a soft "FAIL" and continuing into a state a
# later transition would silently misinterpret.
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
set -euo pipefail

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

fail() {
  log "FAIL: $*"
  exit 1
}

pass() {
  log "PASS: $*"
}

# --- process helpers -------------------------------------------------------
# Every helper below always exits 0 itself (an absent process is a valid,
# expected outcome to report as an empty string) so callers can assign
# `x="$(helper)"` safely under `set -e` — bash does not apply `-e` to the
# right-hand side of `||`, so the guard belongs inside each helper.

app_pid() { pgrep -f "$APP_BIN" 2>/dev/null | head -n1 || true; }
sidecar_pid() { pgrep -f "src-tauri/target/release/bundle/macos/$PRODUCT_NAME.app/Contents/MacOS/panthea-sim" 2>/dev/null | head -n1 || true; }
sidecar_count() { pgrep -f "src-tauri/target/release/bundle/macos/$PRODUCT_NAME.app/Contents/MacOS/panthea-sim" 2>/dev/null | wc -l | tr -d ' ' || true; }

is_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

window_count() {
  local pid="$1"
  osascript -e "tell application \"System Events\" to count windows of (first process whose unix id is $pid)" 2>/dev/null || echo "-1"
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

# Prints `<event count> <max id>` for the current DB (0 0 if absent/empty).
event_snapshot() {
  if [[ ! -f "$DB_PATH" ]]; then
    echo "0 0"
    return
  fi
  sqlite3 "$DB_PATH" "SELECT COUNT(*), COALESCE(MAX(id), 0) FROM events;" | tr '|' ' '
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

# Asserts `PRAGMA integrity_check` is exactly "ok" — a real assertion, not
# just a logged observation.
integrity_check() {
  local label="$1"
  if [[ ! -f "$DB_PATH" ]]; then
    fail "integrity_check ($label): no db at $DB_PATH"
  fi
  local result
  result="$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')"
  if [[ "$result" != "ok" ]]; then
    fail "integrity_check ($label): expected 'ok', got '$result'"
  fi
  pass "integrity_check ($label): ok"
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
    fail "app did not stay running after launch"
  fi
  log "app pid=$a"
  # Wait for the sidecar to appear and bind + start ticking, rather than a
  # fixed guess — poll up to 10s.
  local s=""
  for _ in $(seq 1 20); do
    s="$(sidecar_pid)"
    [[ -n "$s" ]] && break
    sleep 0.5
  done
  if [[ -z "$s" ]]; then
    fail "sidecar did not appear within 10s of shell launch"
  fi
  log "sidecar pid=$s"
}

stop_app_gracefully() {
  local a
  a="$(app_pid)"
  if [[ -z "$a" ]]; then
    return 0
  fi
  log "SIGTERM app pid=$a (Quit-equivalent — see README Caveat on tray automation)"
  kill -TERM "$a" 2>/dev/null || true
  for _ in $(seq 1 20); do
    is_alive "$a" || break
    sleep 0.5
  done
  if is_alive "$a"; then
    fail "app pid=$a did not exit within 10s of SIGTERM"
  fi
}

# --- build -----------------------------------------------------------------

build_and_sign() {
  section "Build + ad-hoc sign"
  bash "$SCRIPT_DIR/build-sidecar.sh" 2>&1 | tee -a "$RESULTS_FILE"
  bash "$SCRIPT_DIR/scan-binary.sh" 2>&1 | tee -a "$RESULTS_FILE"

  log "running: bun run --cwd $DESKTOP_DIR tauri build"
  (cd "$DESKTOP_DIR" && bun run tauri build) 2>&1 | tee -a "$RESULTS_FILE"

  if [[ ! -d "$APP_BUNDLE" ]]; then
    fail "expected bundle not found at $APP_BUNDLE"
  fi

  log "ad-hoc signing (M0 probe only — never release guidance): codesign -s - + xattr -cr"
  codesign -s - --force --deep "$APP_BUNDLE" 2>&1 | tee -a "$RESULTS_FILE"
  xattr -cr "$APP_BUNDLE"
  codesign -dv "$APP_BUNDLE" 2>&1 | tee -a "$RESULTS_FILE" || true
}

# --- transitions -----------------------------------------------------------

transition_close_window_then_quit() {
  section "Transition 1: start -> close window -> verify tick continues -> Quit -> verify exit"
  rm -f "$LOCK_PATH"
  launch_app
  rss_snapshot "after start"
  db_status "after start"

  local a
  a="$(app_pid)"

  log "waiting for the main window to appear (pid=$a)"
  local before=-1
  for _ in $(seq 1 20); do
    before="$(window_count "$a")"
    [[ "$before" -ge 1 ]] && break
    sleep 0.5
  done
  if [[ "$before" -lt 1 ]]; then
    fail "main window never appeared for pid $a (window_count=$before)"
  fi

  log "closing main window via AppleScript (System Events)"
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $a) to click button 1 of window 1" \
    2>&1 | tee -a "$RESULTS_FILE" || true

  local after=-1
  for _ in $(seq 1 20); do
    after="$(window_count "$a")"
    [[ "$after" -eq 0 ]] && break
    sleep 0.5
  done
  if [[ "$after" -ne 0 ]]; then
    fail "window count did not drop to 0 within 10s of the close click (still $after)"
  fi
  pass "window count dropped from $before to 0 after close"

  if ! is_alive "$a"; then
    fail "shell process exited on window close (tray behavior not working)"
  fi
  pass "shell process still alive after window close (kept running in tray)"

  local events_before max_id_before
  read -r events_before max_id_before <<<"$(event_snapshot)"
  db_status "before waiting for tick after close"
  sleep 5
  local events_after max_id_after
  read -r events_after max_id_after <<<"$(event_snapshot)"
  db_status "after waiting 5s post-close (tick should have advanced)"
  if [[ "$events_after" -le "$events_before" ]]; then
    fail "event count did not strictly increase after window close ($events_before -> $events_after)"
  fi
  pass "event count strictly increased after window close ($events_before -> $events_after)"

  stop_app_gracefully
  pass "shell process exited after Quit-equivalent SIGTERM"

  if is_alive "$(sidecar_pid)"; then
    fail "sidecar still alive after shell exit (orphan)"
  fi
  pass "sidecar not running after shell exit (no orphan)"

  integrity_check "after transition 1"
  lock_status "after transition 1"
}

transition_kill_sidecar_restart() {
  section "Transition 2: start -> kill -9 sidecar -> verify supervisor restarts + event continuity"
  rm -f "$LOCK_PATH"
  launch_app
  db_status "before kill"

  local before_sidecar_pid
  before_sidecar_pid="$(sidecar_pid)"
  if [[ -z "$before_sidecar_pid" ]]; then
    fail "no sidecar process found to kill"
  fi
  log "sidecar pid before kill: $before_sidecar_pid"

  local events_before
  events_before="$(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM events;')"

  kill -9 "$before_sidecar_pid"
  log "sent kill -9 to sidecar pid $before_sidecar_pid"

  local after_sidecar_pid=""
  for _ in $(seq 1 10); do
    sleep 1
    after_sidecar_pid="$(sidecar_pid)"
    [[ -n "$after_sidecar_pid" && "$after_sidecar_pid" != "$before_sidecar_pid" ]] && break
  done
  if [[ -z "$after_sidecar_pid" || "$after_sidecar_pid" == "$before_sidecar_pid" ]]; then
    fail "supervisor did not restart the sidecar with a new pid within 10s (pid=$after_sidecar_pid)"
  fi
  pass "supervisor restarted the sidecar with a new pid ($before_sidecar_pid -> $after_sidecar_pid)"

  sleep 3
  db_status "after restart (event ids should continue increasing, not reset)"
  local events_after
  events_after="$(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM events;')"
  if [[ "$events_after" -le "$events_before" ]]; then
    fail "event count did not strictly increase across the restart ($events_before -> $events_after)"
  fi
  pass "event count strictly increased across the restart ($events_before -> $events_after, no reset)"

  integrity_check "after transition 2"
  rss_snapshot "after transition 2"

  stop_app_gracefully
}

transition_kill_app_force() {
  section "Transition 3: start -> kill -9 app -> verify sidecar exits <=10s and lock reclaimable"
  rm -f "$LOCK_PATH"
  launch_app
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
    fail "sidecar still alive ${waited}s after app force-kill (orphaned)"
  fi
  pass "sidecar exited within ${waited}s of app force-kill (no orphan)"

  integrity_check "after transition 3"
  lock_status "after transition 3 (pid $s should now be dead)"

  log "starting a fresh app instance to verify the stale lock is reclaimed"
  launch_app
  sleep 2
  lock_status "after reclaim attempt (pid should be the new sidecar's pid)"
  if ! grep -q "reclaimed stale lock" "$APP_LOG"; then
    fail "app log does not show the stale lock was reclaimed (expected 'reclaimed stale lock' in $APP_LOG)"
  fi
  pass "app log shows the stale lock was reclaimed"
  stop_app_gracefully
}

transition_duplicate_start() {
  section "Transition 4: second launch while running -> refused"
  rm -f "$LOCK_PATH"
  launch_app
  local first_pid
  first_pid="$(app_pid)"
  log "first instance pid=$first_pid"

  log "launching a second instance directly (bypassing Launch Services single-instance re-focus)"
  "$APP_BIN" >"$PROBE_DIR/lifecycle-second-instance.log" 2>&1 &
  local second_pid=$!
  sleep 2

  if is_alive "$second_pid"; then
    kill -9 "$second_pid" 2>/dev/null || true
    fail "second instance still running as its own process (single-instance plugin did not refuse it)"
  fi
  pass "second instance exited immediately (tauri-plugin-single-instance refused it)"

  local after_first_pid
  after_first_pid="$(app_pid)"
  if [[ "$after_first_pid" != "$first_pid" ]]; then
    fail "original instance pid changed unexpectedly (was $first_pid, now $after_first_pid)"
  fi
  pass "original instance (pid=$first_pid) is still the only one running"

  local second_sidecar_count
  second_sidecar_count="$(sidecar_count)"
  if [[ "$second_sidecar_count" -ne 1 ]]; then
    fail "expected exactly 1 sidecar process after the refused duplicate launch, found $second_sidecar_count"
  fi
  pass "exactly 1 sidecar process running (the duplicate launch never reached spawn_sidecar)"

  stop_app_gracefully
}

transition_simulated_sleep() {
  section "Transition 5: SIGSTOP sidecar 120s, SIGCONT -> interval applied exactly once (pmset sleepnow is a manual owner step, see README)"
  rm -f "$LOCK_PATH"
  launch_app
  sleep 3
  local s
  s="$(sidecar_pid)"

  local last_id_before
  last_id_before="$(sqlite3 "$DB_PATH" 'SELECT COALESCE(MAX(id), 0) FROM events;')"
  db_status "before SIGSTOP"

  local stop_duration_s=120
  log "SIGSTOP sidecar pid=$s"
  kill -STOP "$s"
  log "sleeping ${stop_duration_s}s with the sidecar stopped (simulates display sleep; the shell process stays running)"
  sleep "$stop_duration_s"

  log "SIGCONT sidecar pid=$s"
  kill -CONT "$s"

  local resumed=0
  local last_id_after="$last_id_before"
  for _ in $(seq 1 30); do
    sleep 1
    last_id_after="$(sqlite3 "$DB_PATH" 'SELECT COALESCE(MAX(id), 0) FROM events;')"
    if [[ "$last_id_after" -gt "$last_id_before" ]]; then
      resumed=1
      break
    fi
  done
  if [[ "$resumed" -ne 1 ]]; then
    fail "no new tick within 30s of SIGCONT (last_id stayed at $last_id_before)"
  fi
  pass "ticking resumed after SIGCONT (last_id $last_id_before -> $last_id_after)"

  # A few more seconds so the post-resume window is stable before asserting
  # on it (the catch-up tick plus at least one or two normal-cadence ticks).
  sleep 3
  db_status "after SIGCONT (one tick should show a jump >= the stop duration, not a repeat)"

  local threshold_ms=$((stop_duration_s * 1000))
  local big_count
  big_count="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM events WHERE id > $last_id_before AND CAST(REPLACE(REPLACE(note, 'tick applied=', ''), 'ms', '') AS INTEGER) >= $threshold_ms;")"
  if [[ "$big_count" -ne 1 ]]; then
    fail "expected exactly 1 catch-up tick >= ${threshold_ms}ms after resume, found $big_count"
  fi
  pass "exactly one catch-up tick >= ${threshold_ms}ms found (interval applied once, not zero, not twice)"

  local max_applied_ms
  max_applied_ms="$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(CAST(REPLACE(REPLACE(note, 'tick applied=', ''), 'ms', '') AS INTEGER)), 0) FROM events WHERE id > $last_id_before;")"
  if [[ "$max_applied_ms" -lt "$threshold_ms" ]]; then
    fail "catch-up tick applied=${max_applied_ms}ms is less than the stop duration ${threshold_ms}ms"
  fi
  pass "catch-up tick applied=${max_applied_ms}ms >= stop duration ${threshold_ms}ms"

  db_status "one tick later (confirming the jump wasn't reapplied)"
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
  section "Done — every transition asserted PASS. See $RESULTS_FILE and $APP_LOG"
}

main "$@"
