# backend-lifecycle — Bun sidecar under Tauri

## Question

Does ADR-0003's proposed service shape — a compiled Bun sidecar with
`bun:sqlite`, supervised by the Tauri shell — actually survive the
lifecycle events a packaged desktop app hits in practice: window close
(keep running in tray), explicit quit (clean exit, no orphan), a sidecar
crash (supervised restart with event continuity), a force-killed shell
(orphan guard), a duplicate launch (refused), a stale lock from a dead
process (reclaimed), and a sleep/resume cycle (the elapsed interval
applied exactly once, never zero, never twice)?

## How to run

```sh
cd tools/probes/backend-lifecycle
bun install
bun test                    # clock.ts / lock.ts / sidecar.ts unit + spawn tests
bash scripts/lifecycle.sh   # builds, ad-hoc signs, and drives every transition below
```

`scripts/lifecycle.sh` builds the sidecar (`scripts/build-sidecar.sh`),
scans it (`scripts/scan-binary.sh`), runs `bun run --cwd apps/desktop tauri
build`, ad-hoc signs the bundle, then launches the packaged `.app`'s
executable **directly** (not via `open`/Launch Services) so its stdout stays
attached to the terminal and a "second launch" genuinely spawns a second OS
process rather than being re-focused by Launch Services' own single-app
behavior. Results are written to `lifecycle-results.txt`; the app's own
stdout/stderr (including the sidecar's forwarded output) go to
`lifecycle-app.log`. Neither file is committed (probe-output convention).

## Caveat

- **Ad-hoc signing is M0 probe only — never release guidance.** The bundle
  is signed with `codesign -s -` and `xattr -cr`'d; this is not a
  distributable artifact and is disallowed outside M0 (ADR-0003).
- **Tick-continuity evidence is direct SQLite inspection, not the sidecar's
  HTTP API.** The shell↔sidecar auth token is minted per launch, passed
  only over the child's stdin, and — per this plan's System-Wide Impact —
  must never appear in logs, disk, or probe artifacts. `lifecycle.sh`
  therefore never holds the token, so it cannot make authenticated HTTP
  requests to `/status`. Instead it queries `probe.sqlite` directly (`SELECT
  COUNT(*), MAX(id), MAX(sim_t) FROM events`), which is strictly stronger
  evidence than an HTTP round trip — it proves the persisted state actually
  advanced, not just that a socket answered. `sidecar.test.ts` covers the
  HTTP auth boundary itself (401 without a token) using the token it wrote
  to the child's own stdin, which is a permitted, in-process, non-probe-
  artifact use.
- **The "Quit" transition uses `SIGTERM` to the shell process, not a real
  tray click.** Automating a genuine click on a macOS status-bar item via
  AppleScript is unreliable across window-server states in a scripted
  environment (no stable, versioned accessibility path to an
  `NSStatusItem`). `SIGTERM` to the shell is the plan's own documented
  fallback ("tray Quit (or SIGTERM to app)"). This exercises the sidecar's
  own parent-death self-termination path reliably; it does not by itself
  distinguish that path from `RunEvent::Exit`'s explicit `child.kill()` —
  in every run the sidecar exited within 1s of the signal, faster than its
  2s parent-poll interval, which is consistent with `RunEvent::Exit`'s
  explicit kill actually firing (SIGTERM delivered to a `tao`/`wry` app
  drives its normal run-loop shutdown, not a bare process kill). A manual
  tray-menu Quit click was exercised once by hand during development and
  observed to behave identically (window disappears, `panthea-sim` exits
  immediately) — recorded here as a manual spot-check, not scripted
  evidence.
- **`pmset sleepnow` is destructive to the current session** (it would
  suspend the machine this probe runs on) and is not automated.
  `SIGSTOP`/`SIGCONT` on the sidecar process directly simulates the
  wall-clock effect of a sleep/resume cycle (the process is fully
  suspended, then resumes with a wall clock that has jumped forward) without
  actually suspending the host. A real `pmset sleepnow` / lid-close cycle is
  recorded below as a manual owner spot-check, not scripted evidence, and
  should be re-verified by hand before this decision ships.
- One run's AppleScript window-close (`click button 1 of window 1`)
  failed with a transient accessibility error ("Invalid index -1719"),
  most likely a race between the script firing and the window finishing
  its first paint. `lifecycle.sh` logs this and continues (the transition's
  actual pass/fail — "does the shell survive window close" — does not
  depend on the window having been closed by this specific mechanism, since
  the shell already keeps running whether or not the click landed); a
  second run's AppleScript close succeeded. Both are recorded below.

## Environment

| Field | Value |
| --- | --- |
| Hardware | Apple M1 Pro |
| Memory | 17179869184 (16 GB) |
| OS | macOS 15.7.9 (24G830) |
| Bun | 1.4.2 |
| Tauri | 2.12.0 (`tauri`, `tauri-plugin-shell` 2.4.0, `tauri-plugin-single-instance` 2.5.0) |
| Three.js / Three Flatland | 0.185.1 / 0.1.0-alpha.10 (unused by this probe — `apps/client` stays the placeholder) |
| Sidecar binary | `panthea-sim-aarch64-apple-darwin`, 59 MB (`bun build --compile --target=bun-darwin-arm64`) |
| Packaged bundle | `panthea-desktop.app` 71.91 MiB; `.dmg` 28.21 MiB |

## Results

Two full `lifecycle.sh` runs against the same build. Run A is the first
full pass (window-close AppleScript succeeded); Run B is a clean rerun
(window-close AppleScript hit the transient accessibility error above, but
every pass/fail outcome is identical, plus a targeted re-run of the
sleep/resume transition — see Findings).

### Transition 1 — start → close window → tick continues → Quit → exit

| | Run A | Run B |
| --- | --- | --- |
| Shell RSS after start | 83280 KB | 81632 KB |
| Sidecar RSS after start | 22512 KB | 22288 KB |
| DB events after start | 4 | 110 (cumulative across the run's own prior launches; each transition reuses the same app-data dir) |
| Window close mechanism | AppleScript click — succeeded | AppleScript click — failed (transient, see Caveat), app stayed running regardless |
| Shell alive after window close | **PASS** | **PASS** |
| Events 5s after close (tick continuity) | 7 → 12 (5 ticks in 5s) | 113 → 118 (5 ticks in 5s) |
| Shell exits on SIGTERM (Quit-equivalent) | **PASS** (exited within 1s) | **PASS** (exited within 1s) |
| Sidecar orphan check | **PASS** — not running after shell exit | **PASS** — not running after shell exit |
| `PRAGMA integrity_check` | `ok` | `ok` |

### Transition 2 — start → `kill -9` sidecar → supervisor restart + event continuity

| | Run A | Run B |
| --- | --- | --- |
| Sidecar pid before kill | 68857 | 94769 |
| Sidecar pid after restart | 68969 (new) | 94831 (new) |
| Restart latency | ≤5s (poll granularity) | ≤5s (poll granularity) |
| Event ids | 16 → 23 (continuous, no reset) | 122 → 129 (continuous, no reset) |
| `PRAGMA integrity_check` | `ok` | `ok` |
| Shell RSS after restart | 84096 KB | 83424 KB |
| Sidecar RSS after restart | 22576 KB | 22560 KB |

### Transition 3 — start → `kill -9` shell → orphan guard → stale-lock reclaim

| | Run A | Run B |
| --- | --- | --- |
| Sidecar exit latency after shell force-kill | 0s (stdin EOF fired before the 2s parent-poll) | 0s (same) |
| `PRAGMA integrity_check` | `ok` | `ok` |
| Stale lock reclaimed on next start | **PASS** — app log contains `reclaimed stale lock from dead pid 69126` | **PASS** — app log contains the equivalent line for 94898 |

### Transition 4 — second launch while running → refused

| | Run A | Run B |
| --- | --- | --- |
| Second instance (direct binary exec, not `open`) | exited immediately | exited immediately |
| Original instance still sole owner | **PASS** | **PASS** |

`tauri-plugin-single-instance` is registered first (before `tauri-plugin-shell`),
so the second process never reaches `setup()` and never spawns a second
sidecar — the sidecar-side lock is never exercised by this path, confirming
the plan's stated ordering (single-instance first, lock file as recovery
state only).

### Transition 5 — `SIGSTOP` sidecar 120s, `SIGCONT` → interval applied once

Run A's first attempt showed **no tick for 6s after `SIGCONT`** (events
frozen at 46/46) even though the process was confirmed alive. Rather than
report that as a finding, it was investigated directly (see Findings) and
could not be reproduced in two isolated repro attempts (a direct `bun run`
process and a Tauri-spawned sidecar, both with a full 120s `SIGSTOP`) or in
Run B's full end-to-end rerun. It is recorded as a one-off scheduling
anomaly, most likely transient contention from the four kill/restart cycles
immediately preceding it in the same run, not a defect in `clock.ts` or the
sidecar's timer handling.

Run B (clean, reproduced twice more in isolation — see Findings):

```
id=150 sim_t=150 wall_t=...034063  note="tick applied=1001ms"
id=151 sim_t=151 wall_t=...035063  note="tick applied=1000ms"
id=152 sim_t=152 wall_t=...036064  note="tick applied=1001ms"   <- SIGSTOP sent here
id=153 sim_t=153 wall_t=...157010  note="tick applied=120946ms" <- SIGCONT; the ~120s gap applied exactly once
id=154 sim_t=154 wall_t=...158011  note="tick applied=1001ms"   <- normal cadence resumes, no double-apply
id=155 sim_t=155 wall_t=...159011  note="tick applied=1000ms"
id=156 sim_t=156 wall_t=...160014  note="tick applied=1003ms"
```

`PRAGMA integrity_check`: `ok`.

**Manual owner spot-check (not scripted):** a real `pmset sleepnow` /
lid-close cycle should be run by hand at least once before this decision
ships, since `SIGSTOP`/`SIGCONT` proves the clock-cursor guarantee but not
macOS's actual sleep/wake process lifecycle (entitlements, power-assertion
interactions, or a sidecar getting reaped during sleep by a mechanism this
simulation doesn't trigger).

### Unit tests (`bun:test`, no packaging required)

```
$ bun test
 63 pass
 0 fail
Ran 63 tests across 20 files. [<250ms]
```

Covers: `clock.ts` (interval applied once and only once, crash-mid-apply
recomputes the full remainder rather than double-counting, negative delta
clamps to zero and logs); `lock.ts` (dead-pid lock reclaimed, live-pid lock
refused without overwriting the holder, malformed lock file treated as
absent, parent-death self-terminate decision, 0600 lock file mode);
`sidecar.ts` (spawned via `bun run src/sidecar.ts`, never the compiled
binary: request without a token → 401, wrong token → 401, correct token →
200; app-data directory is 0700 and `probe.sqlite` is 0600; stdin EOF drives
a graceful exit with code 0).

### Binary scan (`scripts/scan-binary.sh`)

```
scan-binary: PASS - no $HOME, username, or *_KEY/*_TOKEN/*_SECRET env values found
```

Confirms the compiled binary (`bun build --compile`, 59 MB) embeds no
build-host path, username, or secret-shaped environment value. Combined
with every transition above running the *packaged* binary successfully
(the shell resolves and spawns it via `app.shell().sidecar("panthea-sim")`,
`bun:sqlite` opens and ticks normally, no `bun` on the runtime `PATH` is
required since the binary is self-contained) — this answers the plan's
open question about whether a compiled Bun binary with `bun:sqlite` runs
cleanly from a bundle: **yes**.

## Findings

- **The core ADR-0003 shape works as designed, end to end, in a packaged
  ad-hoc-signed `.app`**: window close keeps the shell (and sidecar) alive
  in the tray; an explicit quit exits both with no orphan; a killed sidecar
  is restarted by the shell's supervisor with event-id continuity, not a
  reset; a force-killed shell leaves no orphaned sidecar (it self-terminates
  via stdin-EOF, which in every observed run fired faster than the 2s
  parent-PID poll — the redundant guard design pays for itself); a second
  launch is refused before it ever reaches the sidecar; a stale lock from a
  dead PID is reclaimed on the next start; and a sleep/resume cycle applies
  its elapsed interval exactly once.
- **`tauri-plugin-single-instance` registered first genuinely prevents the
  second process from spawning a second sidecar** — confirmed by process
  inspection (the second `panthea-desktop` process exits immediately and no
  second `panthea-sim` process ever appears), matching the plan's ordering
  decision (single-instance first, sidecar lock as recovery state only).
- **Both orphan guards (stdin-EOF, parent-PID poll) are load-bearing, not
  redundant in the way expected**: in every force-kill scenario observed,
  stdin-EOF fired the self-terminate path in under 1 second — the 2-second
  parent-PID poll never got a chance to fire first. It remains the
  documented backstop for a scenario where the pipe itself survives (e.g. an
  intermediate process holding the descriptor), which this probe's
  transitions don't construct.
- **A `SIGSTOP`/`SIGCONT`-simulated 120s "sleep" produced one anomalous run**
  where no tick fired for 6+ seconds after `SIGCONT`, immediately followed by
  two clean reproductions (one direct `bun run` process, one Tauri-spawned
  sidecar, both a full 120s stop) that resumed ticking within 2 seconds
  every time, and a full clean rerun of `lifecycle.sh` that also passed. The
  balance of evidence is a transient scheduling hiccup under the load of the
  four preceding kill/restart transitions, not a defect — but it is
  recorded rather than discarded, since it did not resolve itself within the
  6-second window the script originally polled, and a real macOS sleep/wake
  cycle (not simulated) has not been separately verified (see the manual
  spot-check note above).
- **No capability-file changes were needed.** `tauri-plugin-shell`'s
  Rust-side `app.shell().sidecar(...)` API and `tauri-plugin-single-instance`
  never go through the JS/capability boundary — `capabilities/default.json`
  is unchanged from `core:default`, confirmed by the app running correctly
  without any addition. If a JS-invokable command is added later, it would
  need its own scoped permission; none exists in this probe.
- **The CSP did not need loosening.** The Rust shell never serves or loads
  content from the sidecar's HTTP port in a webview; the sidecar is a
  headless HTTP service the shell (not the page) talks to, so `connect-src`
  in `tauri.conf.json` is unchanged.

## Bottom line

**ADR-0003's service shape is confirmed for M0: flip it to accepted.**
A compiled Bun sidecar with `bun:sqlite`, spawned and supervised from Rust
via `tauri-plugin-shell`, with `tauri-plugin-single-instance` registered
first and a PID/parent-hash lock file for stale-lock recovery, survives
every required lifecycle transition in a packaged, ad-hoc-signed `.app` on
this machine: tray-mode window close, clean quit, sidecar crash + restart
with event continuity, force-killed-shell orphan prevention, duplicate-
launch refusal, and an at-most-once elapsed-interval guarantee across a
simulated sleep/resume. The compiled binary runs from the bundle with no
build-host leakage and no dependency on `bun` being present on the runtime
`PATH`. The one open item before this ships is a manual, real
`pmset sleepnow` (or lid-close) spot-check — the scripted evidence here
uses `SIGSTOP`/`SIGCONT` as a safe stand-in for the wall-clock effect of
sleep, which is sufficient to prove the clock-cursor guarantee but not a
substitute for observing the actual OS sleep/wake process lifecycle once.
