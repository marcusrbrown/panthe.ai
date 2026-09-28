fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["subscribe_world", "present_event"]),
    ))
    .expect("tauri build configuration should be valid");
}
