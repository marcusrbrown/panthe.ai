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
use std::net::{Ipv4Addr, Ipv6Addr};

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
    for key_ref in referenced_key_refs(&models, offline_on(&offline)) {
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

/// Whether the settings turn offline mode on. Anything but `true` is online:
/// the sidecar rejects a non-boolean and starts with god turns off.
fn offline_on(offline: &Value) -> bool {
    offline.as_bool().unwrap_or(false)
}

/// Whether an endpoint's `baseUrl` is local: the Rust mirror of `isLocalUrl`
/// in packages/agents/src/config.ts.
///
/// Local means loopback (127.0.0.0/8, ::1), `localhost`, a private LAN address
/// (10/8, 172.16/12, 192.168/16, IPv6 fc00::/7 and fe80::/10, an IPv4-mapped
/// IPv6 address judged as the IPv4 it carries), or a `*.local` name. Anything
/// else, and anything that does not parse, is hosted. Judged from the host the
/// WHATWG URL parser resolves (so `127.1` and `0x7f.0.0.1` are loopback), with
/// no DNS lookup.
fn is_local_base_url(base_url: &str) -> bool {
    let Ok(url) = tauri::Url::parse(base_url) else {
        return false;
    };
    // The parser has already normalized the host: IPv4 as dotted decimal, IPv6
    // canonical in brackets, a name lowercased.
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(address) = host.parse::<Ipv4Addr>() {
        return is_local_ipv4(address);
    }
    if let Ok(address) = host.parse::<Ipv6Addr>() {
        return is_local_ipv6(address);
    }
    let name = host.to_ascii_lowercase();
    let name = name.strip_suffix('.').unwrap_or(&name);
    name == "localhost" || name.ends_with(".local")
}

fn is_local_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, ..] = address.octets();
    a == 127 || a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}

fn is_local_ipv6(address: Ipv6Addr) -> bool {
    if address.is_loopback() {
        return true;
    }
    let groups = address.segments();
    if groups[..5].iter().all(|group| *group == 0) && groups[5] == 0xffff {
        let [a, b] = groups[6].to_be_bytes();
        let [c, d] = groups[7].to_be_bytes();
        return is_local_ipv4(Ipv4Addr::new(a, b, c, d));
    }
    (groups[0] & 0xfe00) == 0xfc00 || (groups[0] & 0xffc0) == 0xfe80
}

/// Settings the shell could not read or parse still reach the sidecar, as a
/// value its parser rejects, so the world starts with god turns off under
/// `model-degraded` and the parse error is logged there.
fn unusable_models() -> Value {
    Value::String("the model settings file could not be read".to_string())
}

/// The distinct `keyRef` strings of `models.endpoints`, in order; offline, only
/// those of local endpoints. Anything
/// else (a missing array, a non-string `keyRef`) is ignored here: the sidecar
/// is the validator.
fn referenced_key_refs(models: &Value, offline: bool) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();
    let Some(endpoints) = models.get("endpoints").and_then(Value::as_array) else {
        return refs;
    };
    for endpoint in endpoints {
        // Offline mode drops hosted endpoints before any key is touched, so
        // their keys are not read here either.
        if offline
            && !endpoint
                .get("baseUrl")
                .and_then(Value::as_str)
                .is_some_and(is_local_base_url)
        {
            continue;
        }
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

    // --- Offline: only local endpoints' keys are read ----------------------

    fn mixed_settings(offline: bool) -> String {
        json!({
            "models": {
                "endpoints": [
                    { "id": "hosted", "baseUrl": "https://api.example.com/v1", "model": "big", "keyRef": "hosted-key" },
                    { "id": "lan", "baseUrl": "http://192.168.1.20:8080/v1", "model": "m", "keyRef": "lan-key" },
                    { "id": "nokey", "baseUrl": "http://localhost:11434/v1", "model": "m" }
                ],
                "roles": {}
            },
            "offline": offline
        })
        .to_string()
    }

    fn stocked_store() -> MemoryKeyStore {
        let store = MemoryKeyStore::default();
        store.set("hosted-key", "hosted-secret").unwrap();
        store.set("lan-key", "lan-secret").unwrap();
        store
    }

    #[test]
    fn offline_never_reads_a_hosted_endpoints_key_and_still_reads_a_local_ones() {
        let store = stocked_store();
        let line = build_launch_line(Ok(Some(mixed_settings(true))), &store);

        assert_eq!(store.reads(), vec!["lan-key".to_string()]);
        assert_eq!(parsed(&line)["keys"], json!({ "lan-key": "lan-secret" }));
        assert!(!line.line.contains("hosted-secret"));
        assert_eq!(parsed(&line)["offline"], json!(true));
    }

    #[test]
    fn online_control_reads_both_the_hosted_and_the_local_key() {
        let store = stocked_store();
        let line = build_launch_line(Ok(Some(mixed_settings(false))), &store);

        assert_eq!(
            store.reads(),
            vec!["hosted-key".to_string(), "lan-key".to_string()]
        );
        assert_eq!(
            parsed(&line)["keys"],
            json!({ "hosted-key": "hosted-secret", "lan-key": "lan-secret" })
        );
    }

    #[test]
    fn offline_an_endpoint_whose_base_url_is_missing_or_not_a_url_counts_as_hosted() {
        let settings = json!({
            "models": { "endpoints": [
                { "id": "a", "keyRef": "a-key" },
                { "id": "b", "baseUrl": 5, "keyRef": "b-key" },
                { "id": "c", "baseUrl": "not a url", "keyRef": "c-key" }
            ] },
            "offline": true
        })
        .to_string();
        let store = MemoryKeyStore::default();
        build_launch_line(Ok(Some(settings)), &store);
        assert!(store.reads().is_empty());
    }

    #[test]
    fn a_key_shared_by_a_local_and_a_hosted_endpoint_is_read_once_offline() {
        let settings = json!({
            "models": { "endpoints": [
                { "id": "h", "baseUrl": "https://api.example.com/v1", "keyRef": "shared" },
                { "id": "l", "baseUrl": "http://127.0.0.1:1/v1", "keyRef": "shared" }
            ] },
            "offline": true
        })
        .to_string();
        let store = MemoryKeyStore::default();
        store.set("shared", "s").unwrap();
        let line = build_launch_line(Ok(Some(settings)), &store);
        assert_eq!(store.reads(), vec!["shared".to_string()]);
        assert_eq!(parsed(&line)["keys"], json!({ "shared": "s" }));
    }

    /// The hosts packages/agents/src/config.test.ts holds `isLocalHost` to:
    /// the Rust rule must agree on each of them.
    #[test]
    fn locality_matches_the_agent_layers_rule() {
        let local = [
            "127.0.0.1",
            "127.255.255.254",
            "localhost",
            "LOCALHOST",
            "[::1]",
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.0.1",
            "192.168.255.255",
            "[fc00::1]",
            "[fd12:3456:789a::1]",
            "[fdff::1]",
            "[fe80::1]",
            "[febf::1]",
            "studio.local",
            "a.b.studio.local",
            "studio.local.",
            "[::ffff:127.0.0.1]",
            "[::ffff:192.168.1.5]",
        ];
        for host in local {
            assert!(
                is_local_base_url(&format!("http://{host}:1/v1")),
                "{host} is local"
            );
        }
        let hosted = [
            "example.com",
            "api.opencode.ai",
            "8.8.8.8",
            "1.1.1.1",
            "172.15.0.1",
            "172.32.0.1",
            "192.167.0.1",
            "11.0.0.1",
            "100.64.0.1",
            "169.254.1.1",
            "128.0.0.1",
            "[2001:4860:4860::8888]",
            "[fe00::1]",
            "[fec0::1]",
            "[fbff::1]",
            "[::ffff:8.8.8.8]",
            "localhost.example.com",
            "127.0.0.1.example.com",
            "notlocal",
            "local",
            "studio.local.example.com",
            "foo.localhost",
        ];
        for host in hosted {
            assert!(
                !is_local_base_url(&format!("http://{host}:1/v1")),
                "{host} is not local"
            );
        }
    }

    #[test]
    fn locality_is_judged_on_the_host_the_url_parser_resolves() {
        // Shorthand and encoded IPv4 forms normalize to loopback.
        assert!(is_local_base_url("http://127.1:11434/v1"));
        assert!(is_local_base_url("http://0x7f.0.0.1/v1"));
        assert!(is_local_base_url("http://[::1]:11434/v1"));
        // A loopback lookalike in the userinfo or a subdomain is a public host.
        assert!(!is_local_base_url("http://127.0.0.1@example.com/v1"));
        assert!(!is_local_base_url("http://localhost.example.com/v1"));
        assert!(!is_local_base_url("https://api.example.com/v1"));
        assert!(!is_local_base_url("https://8.8.8.8/v1"));
        assert!(!is_local_base_url("not a url"));
        assert!(!is_local_base_url(""));
    }
}
