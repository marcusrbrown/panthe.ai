// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

/// Prints a JSON metrics snapshot to stdout. The probe's frontend calls this
/// (via `invoke("dump_metrics", { json })`) so a packaged run's metrics land
/// in the process's stdout stream, not just the WKWebView console — the
/// M0 run protocol captures this stdout for the probe README.
#[tauri::command]
fn dump_metrics(json: String) {
    println!("{json}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![dump_metrics])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
