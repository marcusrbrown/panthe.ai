// The launch config line: what the shell writes to the sidecar's stdin right
// after the launch token, as one JSON line `{ models, offline, keys }`.
//
// `models` and `offline` come from the saved settings (`model-settings.json`,
// shaped `{ "models": <routing config>, "offline": <bool> }`), passed through
// without judgement: the sidecar parses them again and degrades god turns on
// anything it cannot use. `keys` holds a key only for each `keyRef` the
// config's endpoints reference, read from the credential store here and
// nowhere else. The line carries keys, so it is never logged, never put on
// argv or env, and dropped as soon as it is written. `notes` are the only
// strings meant for logs, and none can contain a key.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::keys::KeyStore;
use crate::settings::SettingsError;

pub struct LaunchLine {
    /// One line of JSON, without the trailing newline.
    pub line: String,
    /// Messages safe to log: why settings or a key could not be used.
    pub notes: Vec<String>,
}

/// Builds the launch config line from the saved settings (or the reason they
/// could not be read) and the credential store. Never fails: a spawn must not
/// be blocked by an unreadable file or a locked Keychain.
pub fn build_launch_line(
    settings: Result<Option<String>, SettingsError>,
    store: &dyn KeyStore,
) -> LaunchLine {
    let mut notes = Vec::new();
    let (models, offline) = match settings {
        Ok(None) => (Value::Null, json!(false)),
        Ok(Some(text)) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(mut fields)) => (
                fields.remove("models").unwrap_or(Value::Null),
                fields.remove("offline").unwrap_or(json!(false)),
            ),
            _ => {
                notes.push("model settings are not a JSON object".to_string());
                (unusable_models(), json!(false))
            }
        },
        Err(error) => {
            notes.push(error.to_string());
            (unusable_models(), json!(false))
        }
    };

    let mut keys = BTreeMap::new();
    for key_ref in referenced_key_refs(&models) {
        match store.get(&key_ref) {
            Ok(Some(key)) => {
                keys.insert(key_ref, key);
            }
            // No key stored: the endpoint is sent without one and its
            // requests fail with the router's own missing-key reason.
            Ok(None) => {}
            Err(error) => {
                notes.push(format!("the key for {key_ref} could not be read: {error}"));
            }
        }
    }

    let line = json!({ "models": models, "offline": offline, "keys": keys }).to_string();
    LaunchLine { line, notes }
}

/// Settings the shell could not read or parse still reach the sidecar, as a
/// value its parser rejects, so the world starts with god turns off under
/// `model-degraded` and the parse error is logged there.
fn unusable_models() -> Value {
    Value::String("the model settings file could not be read".to_string())
}

/// The distinct `keyRef` strings of `models.endpoints`, in order. Anything
/// else (a missing array, a non-string `keyRef`) is ignored here: the sidecar
/// is the validator.
fn referenced_key_refs(models: &Value) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();
    let Some(endpoints) = models.get("endpoints").and_then(Value::as_array) else {
        return refs;
    };
    for endpoint in endpoints {
        if let Some(key_ref) = endpoint.get("keyRef").and_then(Value::as_str) {
            if !refs.iter().any(|seen| seen == key_ref) {
                refs.push(key_ref.to_string());
            }
        }
    }
    refs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::testing::MemoryKeyStore;

    const SENTINEL: &str = "sk-sentinel-DO-NOT-LEAK-0123456789";

    fn settings_with_key_ref(key_ref: &str) -> String {
        json!({
            "models": {
                "endpoints": [{
                    "id": "hosted",
                    "baseUrl": "https://api.example.com/v1",
                    "model": "big",
                    "keyRef": key_ref
                }],
                "roles": { "zeus": { "endpoint": "hosted" } }
            },
            "offline": false
        })
        .to_string()
    }

    fn parsed(line: &LaunchLine) -> Value {
        assert!(!line.line.contains('\n'), "the launch line is one line");
        serde_json::from_str(&line.line).unwrap()
    }

    #[test]
    fn no_settings_means_no_models_online_and_no_keys() {
        let line = build_launch_line(Ok(None), &MemoryKeyStore::default());
        assert_eq!(
            parsed(&line),
            json!({ "models": null, "offline": false, "keys": {} })
        );
        assert!(line.notes.is_empty());
    }

    #[test]
    fn the_models_and_offline_switch_pass_through_verbatim() {
        let settings = json!({
            "models": { "endpoints": [], "roles": {} },
            "offline": true
        });
        let line = build_launch_line(Ok(Some(settings.to_string())), &MemoryKeyStore::default());
        let value = parsed(&line);
        assert_eq!(value["models"], settings["models"]);
        assert_eq!(value["offline"], json!(true));
    }

    #[test]
    fn a_referenced_key_is_read_from_the_store_and_included() {
        let store = MemoryKeyStore::default();
        store.set("hosted-key", SENTINEL).unwrap();
        let line = build_launch_line(Ok(Some(settings_with_key_ref("hosted-key"))), &store);
        assert_eq!(parsed(&line)["keys"], json!({ "hosted-key": SENTINEL }));
    }

    #[test]
    fn a_stored_key_the_config_does_not_reference_is_not_sent() {
        let store = MemoryKeyStore::default();
        store.set("hosted-key", SENTINEL).unwrap();
        store.set("stale-key", "stale-secret").unwrap();
        let line = build_launch_line(Ok(Some(settings_with_key_ref("hosted-key"))), &store);
        assert_eq!(parsed(&line)["keys"], json!({ "hosted-key": SENTINEL }));
        assert!(!line.line.contains("stale-secret"));
    }

    #[test]
    fn a_changed_key_changes_the_line() {
        let store = MemoryKeyStore::default();
        let settings = settings_with_key_ref("hosted-key");
        store.set("hosted-key", "first").unwrap();
        let before = build_launch_line(Ok(Some(settings.clone())), &store);
        store.set("hosted-key", "second").unwrap();
        let after = build_launch_line(Ok(Some(settings)), &store);
        assert_eq!(parsed(&before)["keys"]["hosted-key"], json!("first"));
        assert_eq!(parsed(&after)["keys"]["hosted-key"], json!("second"));
    }

    #[test]
    fn a_referenced_key_that_is_missing_is_left_out() {
        let line = build_launch_line(
            Ok(Some(settings_with_key_ref("never-set"))),
            &MemoryKeyStore::default(),
        );
        assert_eq!(parsed(&line)["keys"], json!({}));
        assert!(line.notes.is_empty());
    }

    #[test]
    fn a_failing_store_leaves_the_key_out_and_notes_it_without_the_key() {
        let line = build_launch_line(
            Ok(Some(settings_with_key_ref("hosted-key"))),
            &MemoryKeyStore::failing_reads(),
        );
        assert_eq!(parsed(&line)["keys"], json!({}));
        assert_eq!(line.notes.len(), 1);
        assert!(line.notes[0].contains("hosted-key"));
        assert!(!line.notes[0].contains(SENTINEL));
    }

    #[test]
    fn a_key_with_a_line_break_still_makes_one_line() {
        let store = MemoryKeyStore::default();
        store.set("hosted-key", "first\nsecond\r\nthird").unwrap();
        let line = build_launch_line(Ok(Some(settings_with_key_ref("hosted-key"))), &store);
        assert_eq!(
            parsed(&line)["keys"]["hosted-key"],
            json!("first\nsecond\r\nthird")
        );
    }

    #[test]
    fn settings_that_are_not_json_reach_the_sidecar_as_unusable_models() {
        let line = build_launch_line(
            Ok(Some("{ not json".to_string())),
            &MemoryKeyStore::default(),
        );
        let value = parsed(&line);
        assert!(
            value["models"].is_string(),
            "a string fails the sidecar's parser"
        );
        assert_eq!(value["offline"], json!(false));
        assert_eq!(value["keys"], json!({}));
        assert_eq!(line.notes.len(), 1);
    }

    #[test]
    fn settings_that_are_not_an_object_reach_the_sidecar_as_unusable_models() {
        let line = build_launch_line(Ok(Some("[1,2]".to_string())), &MemoryKeyStore::default());
        assert!(parsed(&line)["models"].is_string());
    }

    #[test]
    fn a_settings_object_without_models_means_no_models() {
        let line = build_launch_line(
            Ok(Some(r#"{"offline":true}"#.to_string())),
            &MemoryKeyStore::default(),
        );
        assert_eq!(
            parsed(&line),
            json!({ "models": null, "offline": true, "keys": {} })
        );
    }

    #[test]
    fn a_settings_file_that_cannot_be_read_reaches_the_sidecar_as_unusable_models() {
        let line = build_launch_line(
            Err(SettingsError::TooLarge { limit: 10 }),
            &MemoryKeyStore::default(),
        );
        assert!(parsed(&line)["models"].is_string());
        assert_eq!(line.notes.len(), 1);
    }

    #[test]
    fn key_refs_that_are_not_strings_are_ignored() {
        let settings = json!({
            "models": { "endpoints": [{ "id": "a", "keyRef": 7 }, { "id": "b" }, 3] },
            "offline": false
        });
        let store = MemoryKeyStore::default();
        store.set("7", SENTINEL).unwrap();
        let line = build_launch_line(Ok(Some(settings.to_string())), &store);
        assert_eq!(parsed(&line)["keys"], json!({}));
    }

    #[test]
    fn the_notes_never_contain_a_key() {
        let store = MemoryKeyStore::failing_reads();
        let line = build_launch_line(Ok(Some(settings_with_key_ref("hosted-key"))), &store);
        for note in &line.notes {
            assert!(!note.contains(SENTINEL));
        }
    }
}
