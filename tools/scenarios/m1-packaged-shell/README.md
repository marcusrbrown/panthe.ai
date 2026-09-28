# m1-packaged-shell — packaged desktop smoke test

## Question

Does the packaged `panthea-desktop.app` build, launch, keep ticking offscreen
and in the background, and survive every tray-driven lifecycle transition
(pause, resume, window close, stop, restart, a killed sidecar, and quit)?

## Method

```sh
bun run --cwd apps/desktop tauri build
open apps/desktop/src-tauri/target/release/bundle/macos/panthea-desktop.app
```

The `.app` is launched directly with `open`, never `bun tauri dev`. Process
identity and the parent/child relationship come from `ps -eo pid,ppid,comm`.
World state is read **read-only**, never written, straight from the
persisted store:

```sh
sqlite3 -readonly <appDataDir>/active/world.sqlite 'select tick from clock'
```

`<appDataDir>` is `~/Library/Application Support/ai.panthe.desktop/`
(`tauri.conf.json`'s `identifier`). Ticks are sampled before and after each
transition to confirm advance, pin, or continuity.

**Tray automation note:** an AppleScript `click` on the tray's `menu bar
item` (to open the menu) was unreliable — intermittent `menuCount=0` /
"Invalid index -1719" even though the AX tree was readable once the menu was
actually open. Opening it by physically clicking the icon's screen
coordinates worked every time:

```sh
cliclick c:<icon-x>,<icon-y>
```

With the menu open that way, AppleScript drives the rest reliably:

```applescript
tell application "System Events" to tell process "panthea-desktop"
    click menu item "Pause" of menu 1 of menu bar item 1 of menu bar 2
end tell
```

Checked/unchecked state is read via `AXMenuItemMarkChar` on each menu item,
not by screen color-matching.

## Environment

| Field | Value |
| --- | --- |
| Hardware | MacBookPro18,3 (Apple Silicon, arm64) |
| Memory | 16 GB |
| OS | macOS 15.7.9 (24G830) |
| Date | 2026-09-28 |
| Commit | f395fe8 (main) |
| Bun | 1.4.2 |
| Tauri | 2.12.0 |

**Build:** `bun run --cwd apps/desktop tauri build` — 79.997s (client build
465ms, sidecar compile 181ms, `cargo build --release` 54.44s, remainder
bundling). `panthea-desktop.app`: 73.33 MiB. `.dmg` also built (28.68 MiB,
not required by this fixture).

## Results

| # | Check | Result | Key evidence |
| --- | --- | --- | --- |
| 1 | Build produces `.app` | **PASS** | 73.33 MiB, 79.997s, `.dmg` also built |
| 2 | Exactly one `panthea-sim`, child of the app | **PASS** | `ps`: desktop pid 1101 → sim pid 1106 |
| 3 | App data dir has world store + `lifecycle.lock` | **PASS** | `active/world.sqlite{,-shm,-wal}`, `lifecycle.lock`, `lifecycle.lock-journal` created |
| 4 | World ticking (read-only SQLite) | **PASS** | `clock.tick` 6 → 11 over 5s (1 Hz) |
| 5 | Tray menu readable via AX | **PASS** | full menu dumped via `AXMenuItemMarkChar` |
| 6 | Pause | **PASS** | tick pinned 257/257/257 over 6s, `paused=1`, tray: Paused ✓, Resume enabled |
| 7 | Resume | **PASS** | tick 257 → 260 in 3s, `paused=0`, tray: Running ✓ |
| 8 | Close main window → Background | **PASS** | window count 0, sim still alive (pid 1106), tick 277 → 280, tray: Background ✓ |
| 9 | Stop Background | **PASS** | sim process gone, window shown, tray: Stopped ✓, item relabeled "Restart Simulation" |
| 10 | No respawn 10s after Stop | **PASS** | no `panthea-sim` process after 10s wait |
| 11 | Restart Simulation | **PASS** | new sim pid 2846, tray: Running ✓, tick continued from persisted 287 (caught up to 322, then 322 → 325) — not reset |
| 12 | `kill -9` sidecar → supervisor respawn | **PASS** | respawn delay **0.62s**, tick continued 341 → 344, no reset |
| 13 | Quit | **PASS** | both processes exited in **1s**, zero orphans |
| 14 | Relaunch resumes from persisted tick | **PASS** | tick 358 on launch (caught up from persisted 349) → 358 → 361, continuous |

Full tray menu (Running state):

```
✓ Running (disabled)      Paused (disabled)      Background (disabled)
Stopped (disabled)        Unavailable (disabled)
———
Show (enabled)   Pause (enabled)   Resume (disabled)   Stop Background (enabled)
———
Quit (enabled)
```

## Known dev-machine hazard

The M0 `backend-lifecycle` probe (`tools/probes/backend-lifecycle/`) shares
this machine's `ai.panthe.desktop` app data dir and writes its own JSON
`lifecycle.lock`. The product's lock (`apps/simulation/src/lifecycle.ts`,
SQLite `PRAGMA locking_mode = EXCLUSIVE`) cannot open that file
(`SQLITE_NOTADB`) — the sidecar crashes on every launch attempt until the
stale file is removed. After running the probe, delete
`<appDataDir>/lifecycle.lock` before launching the packaged app.

## Not covered

- The client view — `apps/client` is still a placeholder, so no in-app
  content was exercised.
- A real OS sleep/wake cycle (`pmset sleepnow` / lid close).
- Code signing and notarization.
