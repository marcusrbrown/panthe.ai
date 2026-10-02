// Spawns the real simulation sidecar (`bun apps/simulation/src/index.ts`)
// against a temp app-data directory, feeds it a token on stdin exactly
// as the shell does, and exercises the shell's actual proxy client
// against it: `/frame` polls succeed with the right token and fail with
// a wrong one, and pause/resume take effect.
//
// Skips (rather than fails) if `bun` is not on PATH, so this test never
// blocks a Rust-only toolchain from running `cargo test`.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use panthea_desktop_lib::keys::{KeyError, UnavailableKeyStore};
use panthea_desktop_lib::launch::build_launch_line;
use panthea_desktop_lib::proxy;
use panthea_desktop_lib::sidecar::parse_panthea_port;

struct SidecarGuard {
    child: Child,
    /// Kept open for the guard's whole lifetime: closing the sidecar's
    /// stdin is its EOF-triggers-graceful-shutdown signal, not just a
    /// one-shot token delivery pipe.
    #[allow(dead_code)]
    stdin: std::process::ChildStdin,
}

impl Drop for SidecarGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn simulation_entry() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("simulation")
        .join("src")
        .join("index.ts")
}

fn bun_available() -> bool {
    Command::new("bun")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Spawns the sidecar, writes `token` to its stdin, and reads stdout
/// lines until `PANTHEA_PORT` appears. Returns the guard (kills the
/// child on drop) and the discovered port.
fn spawn_sidecar(app_data_dir: &Path, token: &str) -> Option<(SidecarGuard, u16)> {
    let mut child = Command::new("bun")
        .arg("run")
        .arg(simulation_entry())
        .env("PANTHEA_APP_DATA_DIR", app_data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdin = child.stdin.take()?;
    // The token line, then the launch config line, built by the shell's own
    // code: no settings saved, so no key is read.
    let launch = build_launch_line(Ok(None), &UnavailableKeyStore::new(KeyError::new("unused")));
    writeln!(stdin, "{token}\n{}", launch.line).ok()?;

    let stdout = child.stdout.take()?;
    let mut reader = BufReader::new(stdout);
    for _ in 0..200 {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if let Some(port) = parse_panthea_port(&line) {
                    return Some((SidecarGuard { child, stdin }, port));
                }
            }
        }
    }

    let _ = child.kill();
    None
}

#[test]
fn proxy_client_polls_pauses_resumes_and_rejects_a_wrong_token_against_a_real_sidecar() {
    if !bun_available() {
        eprintln!("skipping proxy_integration: bun not found on PATH");
        return;
    }

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(run());
}

async fn run() {
    let app_data_dir =
        std::env::temp_dir().join(format!("panthea-desktop-proxy-it-{}", std::process::id()));
    std::fs::create_dir_all(&app_data_dir).expect("create temp app data dir");

    let token = "integration-test-launch-token";
    let Some((_guard, port)) = spawn_sidecar(&app_data_dir, token) else {
        std::fs::remove_dir_all(&app_data_dir).ok();
        panic!("sidecar never printed PANTHEA_PORT");
    };

    let frame = proxy::fetch_frame(port, token)
        .await
        .expect("a frame poll with the right token should succeed");
    assert_eq!(
        frame.get("status").and_then(|value| value.as_str()),
        Some("running")
    );

    let wrong_token = proxy::fetch_frame(port, "the-wrong-token").await;
    assert!(
        wrong_token.is_err(),
        "a frame poll with the wrong token should fail"
    );

    proxy::pause(port, token)
        .await
        .expect("pause should succeed");
    let paused = proxy::fetch_frame(port, token)
        .await
        .expect("a frame poll after pause should succeed");
    assert_eq!(
        paused.get("status").and_then(|value| value.as_str()),
        Some("paused")
    );

    proxy::resume(port, token)
        .await
        .expect("resume should succeed");
    let resumed = proxy::fetch_frame(port, token)
        .await
        .expect("a frame poll after resume should succeed");
    assert_eq!(
        resumed.get("status").and_then(|value| value.as_str()),
        Some("running")
    );

    std::fs::remove_dir_all(&app_data_dir).ok();
}
