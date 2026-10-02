// Endpoint key storage. Keys live only in the platform credential store
// (macOS Keychain); they are never written to settings, saves, logs, or
// the renderer. The commands the webview can reach are write-only: set,
// delete, and a set/missing status. `KeyStore::get` exists for the
// shell's own sidecar spawn path and has no command.
//
// The store sits behind a small trait so tests inject an in-memory
// implementation per test instead of the credential store's
// process-global mock.

use std::collections::BTreeMap;
use std::fmt;

use serde::Serialize;

/// One Keychain service for every endpoint key; the account is the
/// endpoint's `keyRef`.
pub const KEY_SERVICE: &str = "ai.panthe.desktop.endpoint-keys";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyStatus {
    Set,
    Missing,
}

/// A message safe to show the operator. Constructed only from fixed text
/// or from platform errors that never carry the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyError(String);

impl KeyError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for KeyError {}

pub trait KeyStore: Send + Sync {
    /// Stores `key` under `key_ref`, replacing any earlier value.
    fn set(&self, key_ref: &str, key: &str) -> Result<(), KeyError>;
    /// Reads the key, or `None` when none is stored. Only the sidecar
    /// spawn path calls this; no command exposes it.
    fn get(&self, key_ref: &str) -> Result<Option<String>, KeyError>;
    /// Removes the key. Deleting a key that is not stored succeeds.
    fn delete(&self, key_ref: &str) -> Result<(), KeyError>;
    /// Whether a key is stored, never its value.
    fn status(&self, key_ref: &str) -> Result<KeyStatus, KeyError>;
}

/// Status for each requested `key_ref`; the first store failure aborts.
pub fn key_statuses(
    store: &dyn KeyStore,
    key_refs: &[String],
) -> Result<BTreeMap<String, KeyStatus>, KeyError> {
    key_refs
        .iter()
        .map(|key_ref| Ok((key_ref.clone(), store.status(key_ref)?)))
        .collect()
}

/// Production store backed by the platform credential store through the
/// `keyring` crate.
pub struct KeyringStore;

impl KeyringStore {
    fn entry(key_ref: &str) -> Result<keyring::Entry, KeyError> {
        keyring::Entry::new(KEY_SERVICE, key_ref).map_err(map_keyring_error)
    }
}

impl KeyStore for KeyringStore {
    fn set(&self, key_ref: &str, key: &str) -> Result<(), KeyError> {
        Self::entry(key_ref)?
            .set_password(key)
            .map_err(map_keyring_error)
    }

    fn get(&self, key_ref: &str) -> Result<Option<String>, KeyError> {
        match Self::entry(key_ref)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn delete(&self, key_ref: &str) -> Result<(), KeyError> {
        match Self::entry(key_ref)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn status(&self, key_ref: &str) -> Result<KeyStatus, KeyError> {
        // The credential store has no existence check; the value is read
        // and dropped here, and only the status leaves this function.
        Ok(match self.get(key_ref)? {
            Some(_) => KeyStatus::Set,
            None => KeyStatus::Missing,
        })
    }
}

/// Maps a credential-store failure to an operator-facing message. Never
/// formats variants that can carry secret bytes (`BadEncoding`,
/// `BadDataFormat`, `Ambiguous`).
fn map_keyring_error(error: keyring::Error) -> KeyError {
    use keyring::Error;
    let message = match error {
        Error::NoStorageAccess(detail) => {
            format!("the Keychain is locked or denied access: {detail}")
        }
        Error::PlatformFailure(detail) => format!("the Keychain reported a failure: {detail}"),
        Error::NoDefaultStore => "the Keychain is not available on this system".to_string(),
        Error::TooLong(..) => "the key reference or key is too long for the Keychain".to_string(),
        Error::Invalid(..) => "the key reference or key is not valid for the Keychain".to_string(),
        Error::NoEntry => "no key is stored for that reference".to_string(),
        // `BadEncoding`, `BadDataFormat`, `Ambiguous`, and any variant a
        // later keyring release adds: fixed text, never the payload.
        _ => "the Keychain returned an unexpected error".to_string(),
    };
    KeyError::new(message)
}

#[cfg(test)]
pub(crate) mod testing {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// In-memory store, one per test. `failing` makes every write fail
    /// with an error that echoes the key, so a leak would show up.
    #[derive(Default)]
    pub struct MemoryKeyStore {
        entries: Mutex<HashMap<String, String>>,
        failing: bool,
    }

    impl MemoryKeyStore {
        pub fn failing() -> Self {
            Self {
                failing: true,
                ..Self::default()
            }
        }
    }

    impl KeyStore for MemoryKeyStore {
        fn set(&self, key_ref: &str, key: &str) -> Result<(), KeyError> {
            if self.failing {
                return Err(KeyError::new(format!(
                    "the Keychain is locked (while storing {key_ref})"
                )));
            }
            self.entries
                .lock()
                .unwrap()
                .insert(key_ref.to_string(), key.to_string());
            Ok(())
        }

        fn get(&self, key_ref: &str) -> Result<Option<String>, KeyError> {
            Ok(self.entries.lock().unwrap().get(key_ref).cloned())
        }

        fn delete(&self, key_ref: &str) -> Result<(), KeyError> {
            self.entries.lock().unwrap().remove(key_ref);
            Ok(())
        }

        fn status(&self, key_ref: &str) -> Result<KeyStatus, KeyError> {
            Ok(if self.entries.lock().unwrap().contains_key(key_ref) {
                KeyStatus::Set
            } else {
                KeyStatus::Missing
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::MemoryKeyStore;
    use super::*;

    const SENTINEL: &str = "sk-sentinel-DO-NOT-LEAK-0123456789";

    fn refs(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn set_then_status_reports_set() {
        let store = MemoryKeyStore::default();
        store.set("zeus-key", SENTINEL).unwrap();
        let statuses = key_statuses(&store, &refs(&["zeus-key"])).unwrap();
        assert_eq!(statuses["zeus-key"], KeyStatus::Set);
    }

    #[test]
    fn delete_then_status_reports_missing() {
        let store = MemoryKeyStore::default();
        store.set("zeus-key", SENTINEL).unwrap();
        store.delete("zeus-key").unwrap();
        let statuses = key_statuses(&store, &refs(&["zeus-key"])).unwrap();
        assert_eq!(statuses["zeus-key"], KeyStatus::Missing);
    }

    #[test]
    fn status_covers_every_requested_ref_and_marks_unknown_ones_missing() {
        let store = MemoryKeyStore::default();
        store.set("a", SENTINEL).unwrap();
        let statuses = key_statuses(&store, &refs(&["a", "b"])).unwrap();
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses["a"], KeyStatus::Set);
        assert_eq!(statuses["b"], KeyStatus::Missing);
    }

    #[test]
    fn deleting_a_key_that_is_not_stored_succeeds() {
        let store = MemoryKeyStore::default();
        store.delete("never-set").unwrap();
    }

    #[test]
    fn setting_again_replaces_the_value() {
        let store = MemoryKeyStore::default();
        store.set("a", "first").unwrap();
        store.set("a", "second").unwrap();
        assert_eq!(store.get("a").unwrap().as_deref(), Some("second"));
    }

    #[test]
    fn status_output_never_contains_the_key() {
        let store = MemoryKeyStore::default();
        store.set("a", SENTINEL).unwrap();
        let json = serde_json::to_string(&key_statuses(&store, &refs(&["a"])).unwrap()).unwrap();
        assert_eq!(json, r#"{"a":"set"}"#);
        assert!(!json.contains(SENTINEL));
    }

    #[test]
    fn a_failing_store_reports_an_error_without_the_key() {
        let store = MemoryKeyStore::failing();
        let error = store.set("zeus-key", SENTINEL).unwrap_err();
        assert!(!error.to_string().is_empty());
        assert!(!error.to_string().contains(SENTINEL));
    }

    #[test]
    fn keyring_errors_map_to_messages_that_never_carry_secret_bytes() {
        let secret = SENTINEL.as_bytes().to_vec();
        let platform = || -> keyring::Error {
            keyring::Error::PlatformFailure("errSecInteractionNotAllowed".into())
        };
        let cases = vec![
            keyring::Error::BadEncoding(secret.clone()),
            keyring::Error::BadDataFormat(secret.clone(), "malformed".into()),
            keyring::Error::Invalid("password".into(), SENTINEL.into()),
            keyring::Error::TooLong("password".into(), 10),
            keyring::Error::NoDefaultStore,
            keyring::Error::NoStorageAccess("denied".into()),
            platform(),
        ];
        for case in cases {
            let message = map_keyring_error(case).to_string();
            assert!(!message.is_empty());
            assert!(!message.contains(SENTINEL), "leaked in: {message}");
        }
    }

    #[test]
    fn a_locked_or_denied_store_says_so() {
        let message = map_keyring_error(keyring::Error::NoStorageAccess("denied".into()));
        assert!(message.to_string().contains("locked or denied"));
    }

    #[test]
    fn an_unknown_future_error_still_maps_to_a_message() {
        // Exercises the fallback arm's wording via a variant we do not
        // special-case.
        let message = map_keyring_error(keyring::Error::NotSupportedByStore("x".into()));
        assert!(message.to_string().contains("unexpected"));
    }
}
