// Invoke commands exposed to the main window's webview: subscribing to
// the frame stream, relaying a presentation receipt, and the model
// settings and endpoint-key commands. No other command is reachable from
// the renderer (see capabilities/proxy.json). Key commands are
// write-only: set, delete, and a set/missing status. None returns a key
// value, and `KeyStore::get` has no command.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::keys::{key_statuses, KeyError, KeyStatus, KeyStore};
use crate::settings::SettingsStore;
use crate::state::SidecarState;

/// Managed state wrapping the credential store: the one seam the
/// commands (and, in a later unit, the sidecar spawn path) go through.
pub struct KeyVault(pub Arc<dyn KeyStore>);

/// Credential-store calls block and can raise an OS prompt, so they run
/// off the main thread and the async runtime's workers.
async fn run_key_op<T: Send + 'static>(
    vault: &KeyVault,
    op: impl FnOnce(&dyn KeyStore) -> Result<T, KeyError> + Send + 'static,
) -> Result<T, String> {
    let store = vault.0.clone();
    tauri::async_runtime::spawn_blocking(move || op(store.as_ref()))
        .await
        .map_err(|_| "the Keychain operation did not complete".to_string())?
        .map_err(|error| error.to_string())
}

/// The saved settings JSON, or `null` when none were saved yet.
#[tauri::command]
pub fn read_model_settings(store: State<SettingsStore>) -> Result<Option<String>, String> {
    store.read().map_err(|error| error.to_string())
}

/// Stores the settings JSON verbatim. The caller validates; the shell
/// only caps its size.
#[tauri::command]
pub fn save_model_settings(store: State<SettingsStore>, settings: String) -> Result<(), String> {
    store.write(&settings).map_err(|error| error.to_string())
}

/// Stores an endpoint's key in the Keychain. The error text never
/// includes the key.
#[tauri::command]
pub async fn set_endpoint_key(
    vault: State<'_, KeyVault>,
    key_ref: String,
    key: String,
) -> Result<(), String> {
    run_key_op(&vault, move |store| store.set(&key_ref, &key)).await
}

#[tauri::command]
pub async fn delete_endpoint_key(
    vault: State<'_, KeyVault>,
    key_ref: String,
) -> Result<(), String> {
    run_key_op(&vault, move |store| store.delete(&key_ref)).await
}

/// `set` or `missing` for each `key_ref`; never a value.
#[tauri::command]
pub async fn endpoint_key_status(
    vault: State<'_, KeyVault>,
    key_refs: Vec<String>,
) -> Result<BTreeMap<String, KeyStatus>, String> {
    run_key_op(&vault, move |store| key_statuses(store, &key_refs)).await
}

/// Stores `frames` as the subscribed Channel; a resubscribe (e.g. after
/// the webview reloads) replaces whatever channel was stored before.
/// Pushed to on every subsequent poll by the proxy's poll task -- but if
/// a frame has already been polled, that cached frame is sent right
/// away too, so a newly (re)subscribing webview sees the world's
/// current state immediately rather than waiting up to a second for the
/// next poll.
#[tauri::command]
pub fn subscribe_world(state: State<SidecarState>, frames: Channel<Value>) {
    let mut lifecycle = state
        .lifecycle
        .lock()
        .expect("sidecar state mutex poisoned");
    crate::proxy::apply_subscribe(&mut lifecycle, frames);
}

/// Relays a presentation receipt for `event_id`, attributed to the
/// current sidecar session. Fails if no sidecar session is active yet.
#[tauri::command]
pub async fn present_event(app: AppHandle, event_id: String) -> Result<(), String> {
    let (session, session_id) = {
        let state = app.state::<SidecarState>();
        let lifecycle = state
            .lifecycle
            .lock()
            .expect("sidecar state mutex poisoned");
        let session = lifecycle
            .session
            .clone()
            .ok_or_else(|| "no active sidecar session".to_string())?;
        let session_id = lifecycle
            .last_frame
            .as_ref()
            .map(|frame| frame.session_id.clone())
            .ok_or_else(|| "no frame received yet".to_string())?;
        (session, session_id)
    };
    crate::proxy::present_event(session.port, &session.token, &session_id, &event_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::testing::MemoryKeyStore;

    const SENTINEL: &str = "sk-sentinel-DO-NOT-LEAK-0123456789";

    fn vault(store: MemoryKeyStore) -> KeyVault {
        KeyVault(Arc::new(store))
    }

    // These drive `run_key_op` with the same closures the commands pass,
    // so the commands' wiring and error mapping are covered without a
    // running app.

    #[test]
    fn set_then_status_then_delete_round_trips_through_the_command_path() {
        let vault = vault(MemoryKeyStore::default());
        tauri::async_runtime::block_on(async {
            run_key_op(&vault, |store| store.set("zeus-key", SENTINEL))
                .await
                .unwrap();
            let refs = vec!["zeus-key".to_string()];
            let statuses = run_key_op(&vault, {
                let refs = refs.clone();
                move |store| key_statuses(store, &refs)
            })
            .await
            .unwrap();
            assert_eq!(statuses["zeus-key"], KeyStatus::Set);

            run_key_op(&vault, |store| store.delete("zeus-key"))
                .await
                .unwrap();
            let statuses = run_key_op(&vault, move |store| key_statuses(store, &refs))
                .await
                .unwrap();
            assert_eq!(statuses["zeus-key"], KeyStatus::Missing);
        });
    }

    #[test]
    fn a_failing_store_returns_an_error_string_without_the_key() {
        let vault = vault(MemoryKeyStore::failing());
        let error = tauri::async_runtime::block_on(run_key_op(&vault, |store| {
            store.set("zeus-key", SENTINEL)
        }))
        .unwrap_err();
        assert!(!error.is_empty());
        assert!(!error.contains(SENTINEL));
    }

    #[test]
    fn what_a_status_command_returns_serializes_without_the_key() {
        let vault = vault(MemoryKeyStore::default());
        let json = tauri::async_runtime::block_on(async {
            run_key_op(&vault, |store| store.set("zeus-key", SENTINEL))
                .await
                .unwrap();
            let statuses = run_key_op(&vault, |store| {
                key_statuses(store, &["zeus-key".to_string()])
            })
            .await
            .unwrap();
            serde_json::to_string(&statuses).unwrap()
        });
        assert_eq!(json, r#"{"zeus-key":"set"}"#);
        assert!(!json.contains(SENTINEL));
    }
}
