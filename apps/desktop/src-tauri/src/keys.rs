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
use std::sync::Arc;

use keyring_core::{CredentialStore, Entry, Error};
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

/// A store over any `keyring-core` credential store. Production passes the
/// Apple Keychain store; tests pass an instance of the crate's mock store.
/// The store is an owned instance: nothing here touches keyring-core's
/// process-global default store.
pub struct KeyringStore {
    store: Arc<CredentialStore>,
}

impl KeyringStore {
    pub fn new(store: Arc<CredentialStore>) -> Self {
        Self { store }
    }

    fn entry(&self, key_ref: &str) -> Result<Entry, KeyError> {
        self.store
            .build(KEY_SERVICE, key_ref, None)
            .map_err(map_keyring_error)
    }
}

impl KeyStore for KeyringStore {
    fn set(&self, key_ref: &str, key: &str) -> Result<(), KeyError> {
        self.entry(key_ref)?
            .set_password(key)
            .map_err(map_keyring_error)
    }

    fn get(&self, key_ref: &str) -> Result<Option<String>, KeyError> {
        match self.entry(key_ref)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn delete(&self, key_ref: &str) -> Result<(), KeyError> {
        match self.entry(key_ref)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
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

/// Stands in when no credential store can be built (an unsupported
/// platform, or a store that failed to initialize): every operation
/// reports the same operator-facing reason.
pub struct UnavailableKeyStore {
    reason: KeyError,
}

impl UnavailableKeyStore {
    pub fn new(reason: KeyError) -> Self {
        Self { reason }
    }
}

impl KeyStore for UnavailableKeyStore {
    fn set(&self, _key_ref: &str, _key: &str) -> Result<(), KeyError> {
        Err(self.reason.clone())
    }

    fn get(&self, _key_ref: &str) -> Result<Option<String>, KeyError> {
        Err(self.reason.clone())
    }

    fn delete(&self, _key_ref: &str) -> Result<(), KeyError> {
        Err(self.reason.clone())
    }

    fn status(&self, _key_ref: &str) -> Result<KeyStatus, KeyError> {
        Err(self.reason.clone())
    }
}

/// The platform credential store, built once at startup. macOS uses the
/// login Keychain; other platforms report that credential storage is not
/// supported (no Windows or Linux store is linked).
pub fn platform_key_store() -> Arc<dyn KeyStore> {
    #[cfg(target_os = "macos")]
    {
        match apple_native_keyring_store::keychain::Store::new() {
            Ok(store) => Arc::new(KeyringStore::new(store)),
            Err(error) => Arc::new(UnavailableKeyStore::new(map_keyring_error(error))),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(UnavailableKeyStore::new(KeyError::new(
            "credential storage is not supported on this platform",
        )))
    }
}

/// Maps a credential-store failure to an operator-facing message. Never
/// formats variants that can carry secret bytes (`BadEncoding`,
/// `BadDataFormat`, `Ambiguous`).
fn map_keyring_error(error: Error) -> KeyError {
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
    use keyring_core::api::CredentialStoreApi;

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
        let platform = || -> Error { Error::PlatformFailure("errSecInteractionNotAllowed".into()) };
        let cases = vec![
            Error::BadEncoding(secret.clone()),
            Error::BadDataFormat(secret.clone(), "malformed".into()),
            Error::Invalid("password".into(), SENTINEL.into()),
            Error::TooLong("password".into(), 10),
            Error::NoDefaultStore,
            Error::NoStorageAccess("denied".into()),
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
        let message = map_keyring_error(Error::NoStorageAccess("denied".into()));
        assert!(message.to_string().contains("locked or denied"));
    }

    #[test]
    fn an_unknown_future_error_still_maps_to_a_message() {
        // Exercises the fallback arm's wording via a variant we do not
        // special-case.
        let message = map_keyring_error(Error::NotSupportedByStore("x".into()));
        assert!(message.to_string().contains("unexpected"));
    }

    // `KeyringStore` over an instance of keyring-core's mock store: real
    // set/get/delete/status behavior and error mapping, no Keychain and no
    // process-global default store.

    fn mock_keyring() -> (KeyringStore, Arc<keyring_core::mock::Store>) {
        let mock = keyring_core::mock::Store::new().unwrap();
        (KeyringStore::new(mock.clone()), mock)
    }

    fn fail_next(mock: &keyring_core::mock::Store, key_ref: &str, error: Error) {
        let entry = mock.build(KEY_SERVICE, key_ref, None).unwrap();
        let cred: &keyring_core::mock::Cred = entry.as_any().downcast_ref().unwrap();
        cred.set_error(error);
    }

    #[test]
    fn the_keyring_store_round_trips_set_status_get_delete() {
        let (store, _mock) = mock_keyring();
        assert_eq!(store.status("a").unwrap(), KeyStatus::Missing);
        assert_eq!(store.get("a").unwrap(), None);
        store.set("a", SENTINEL).unwrap();
        assert_eq!(store.status("a").unwrap(), KeyStatus::Set);
        assert_eq!(store.get("a").unwrap().as_deref(), Some(SENTINEL));
        store.delete("a").unwrap();
        assert_eq!(store.status("a").unwrap(), KeyStatus::Missing);
    }

    #[test]
    fn the_keyring_store_treats_a_missing_entry_as_missing_and_delete_as_idempotent() {
        let (store, _mock) = mock_keyring();
        store.delete("never-set").unwrap();
        assert_eq!(store.get("never-set").unwrap(), None);
    }

    #[test]
    fn the_keyring_store_keeps_each_key_ref_separate() {
        let (store, _mock) = mock_keyring();
        store.set("a", "one").unwrap();
        assert_eq!(store.status("b").unwrap(), KeyStatus::Missing);
    }

    #[test]
    fn a_locked_keychain_on_set_is_reported_without_the_key() {
        let (store, mock) = mock_keyring();
        fail_next(&mock, "a", Error::NoStorageAccess("locked".into()));
        let error = store.set("a", SENTINEL).unwrap_err().to_string();
        assert!(error.contains("locked or denied"));
        assert!(!error.contains(SENTINEL));
    }

    #[test]
    fn an_undecodable_stored_value_is_an_error_that_does_not_echo_it() {
        let (store, mock) = mock_keyring();
        fail_next(&mock, "a", Error::BadEncoding(SENTINEL.as_bytes().to_vec()));
        let error = store.status("a").unwrap_err().to_string();
        assert!(!error.contains(SENTINEL));
    }

    #[test]
    fn an_unavailable_store_reports_its_reason_for_every_operation() {
        let store = UnavailableKeyStore::new(KeyError::new("credential storage is unavailable"));
        let expected = "credential storage is unavailable";
        assert_eq!(store.set("a", SENTINEL).unwrap_err().to_string(), expected);
        assert_eq!(store.get("a").unwrap_err().to_string(), expected);
        assert_eq!(store.delete("a").unwrap_err().to_string(), expected);
        assert_eq!(store.status("a").unwrap_err().to_string(), expected);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_platform_store_builds_without_touching_the_keychain() {
        // Construction only; no entry is read or written, so no Keychain
        // prompt can appear in a test run.
        let _store = platform_key_store();
    }
}
