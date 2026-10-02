// Non-secret model settings (endpoints, role assignments, fallback
// order, offline flag) persisted as `model-settings.json` in the app
// data directory, outside world saves and exports. The JSON is stored
// verbatim: validation lives in the TypeScript config parser, which runs
// in the client before save and again in the sidecar at start. The file
// holds `keyRef`s, never keys.

use std::fmt;
use std::fs::{create_dir_all, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SETTINGS_FILE_NAME: &str = "model-settings.json";
/// Real settings are a few kilobytes; the cap only stops a runaway
/// write or a hand-edited file from being loaded wholesale.
pub const MAX_SETTINGS_BYTES: usize = 256 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum SettingsError {
    TooLarge { limit: usize },
    Io(String),
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { limit } => {
                write!(f, "model settings are larger than the {limit}-byte limit")
            }
            Self::Io(message) => write!(f, "model settings storage failed: {message}"),
        }
    }
}

impl std::error::Error for SettingsError {}

fn io_error(error: std::io::Error) -> SettingsError {
    SettingsError::Io(error.to_string())
}

fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

pub struct SettingsStore {
    dir: PathBuf,
    // Serializes writers so two saves never share the temp file.
    write_lock: Mutex<()>,
}

impl SettingsStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            write_lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(SETTINGS_FILE_NAME)
    }

    /// The stored JSON text, or `None` when no settings were ever saved.
    pub fn read(&self) -> Result<Option<String>, SettingsError> {
        let file = match File::open(self.path()) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        // Read one byte past the cap so a file that grows after any
        // size check still cannot be loaded unbounded.
        let mut bytes = Vec::new();
        file.take(MAX_SETTINGS_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() > MAX_SETTINGS_BYTES {
            return Err(SettingsError::TooLarge {
                limit: MAX_SETTINGS_BYTES,
            });
        }
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| SettingsError::Io("the settings file is not valid UTF-8".to_string()))
    }

    /// Atomically replaces the settings: write a temp file, then rename.
    pub fn write(&self, json: &str) -> Result<(), SettingsError> {
        if json.len() > MAX_SETTINGS_BYTES {
            return Err(SettingsError::TooLarge {
                limit: MAX_SETTINGS_BYTES,
            });
        }
        let _guard = self
            .write_lock
            .lock()
            .expect("settings write mutex poisoned");
        create_dir_all(&self.dir).map_err(io_error)?;
        let temp = self.dir.join(format!("{SETTINGS_FILE_NAME}.tmp"));
        let result =
            write_synced(&temp, json.as_bytes()).and_then(|()| std::fs::rename(&temp, self.path()));
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result.map_err(io_error)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let path = std::env::temp_dir().join(format!(
                "panthea-settings-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&path);
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const SETTINGS: &str = r#"{"endpoints":[{"id":"local","baseUrl":"http://127.0.0.1:11434/v1","model":"llama"}],"offline":false}"#;

    #[test]
    fn a_missing_file_reads_as_no_settings() {
        let dir = TempDir::new();
        let store = SettingsStore::new(&dir.0);
        assert_eq!(store.read(), Ok(None));
    }

    #[test]
    fn save_then_read_returns_the_same_json() {
        let dir = TempDir::new();
        let store = SettingsStore::new(dir.0.join("nested"));
        store.write(SETTINGS).unwrap();
        assert_eq!(store.read(), Ok(Some(SETTINGS.to_string())));
    }

    #[test]
    fn a_second_save_replaces_the_first_and_leaves_no_temp_file() {
        let dir = TempDir::new();
        let store = SettingsStore::new(&dir.0);
        store.write(SETTINGS).unwrap();
        store.write(r#"{"offline":true}"#).unwrap();
        assert_eq!(store.read(), Ok(Some(r#"{"offline":true}"#.to_string())));
        let names: Vec<_> = std::fs::read_dir(&dir.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![SETTINGS_FILE_NAME.to_string()]);
    }

    #[test]
    fn oversized_settings_are_rejected_and_leave_the_old_file() {
        let dir = TempDir::new();
        let store = SettingsStore::new(&dir.0);
        store.write(SETTINGS).unwrap();
        let oversized = "x".repeat(MAX_SETTINGS_BYTES + 1);
        assert_eq!(
            store.write(&oversized),
            Err(SettingsError::TooLarge {
                limit: MAX_SETTINGS_BYTES
            })
        );
        assert_eq!(store.read(), Ok(Some(SETTINGS.to_string())));
    }

    #[test]
    fn settings_at_exactly_the_cap_are_accepted() {
        let dir = TempDir::new();
        let store = SettingsStore::new(&dir.0);
        let at_cap = "x".repeat(MAX_SETTINGS_BYTES);
        store.write(&at_cap).unwrap();
        assert_eq!(
            store.read().unwrap().map(|text| text.len()),
            Some(MAX_SETTINGS_BYTES)
        );
    }

    #[test]
    fn an_oversized_file_on_disk_is_rejected_on_read() {
        let dir = TempDir::new();
        std::fs::create_dir_all(&dir.0).unwrap();
        std::fs::write(
            dir.0.join(SETTINGS_FILE_NAME),
            "x".repeat(MAX_SETTINGS_BYTES + 1),
        )
        .unwrap();
        let store = SettingsStore::new(&dir.0);
        assert_eq!(
            store.read(),
            Err(SettingsError::TooLarge {
                limit: MAX_SETTINGS_BYTES
            })
        );
    }

    #[test]
    fn a_non_utf8_file_is_an_error_not_a_panic() {
        let dir = TempDir::new();
        std::fs::create_dir_all(&dir.0).unwrap();
        std::fs::write(dir.0.join(SETTINGS_FILE_NAME), [0xff, 0xfe, 0xfd]).unwrap();
        let store = SettingsStore::new(&dir.0);
        assert!(matches!(store.read(), Err(SettingsError::Io(_))));
    }

    #[test]
    fn concurrent_saves_never_corrupt_the_file() {
        let dir = TempDir::new();
        let store = std::sync::Arc::new(SettingsStore::new(&dir.0));
        let payloads: Vec<String> = (0..8)
            .map(|n| format!(r#"{{"n":{n},"pad":"{}"}}"#, "p".repeat(10_000)))
            .collect();
        let handles: Vec<_> = payloads
            .iter()
            .cloned()
            .map(|payload| {
                let store = store.clone();
                std::thread::spawn(move || store.write(&payload).unwrap())
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let stored = store.read().unwrap().unwrap();
        assert!(payloads.contains(&stored));
    }
}
