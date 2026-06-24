use base64::Engine;
use std::process::Command;

/// Run a user-configured local command to generate an image, then return it as a PNG data URL.
///
/// Security model: the command + args come from the app's own settings (local, user-entered),
/// and are executed via an **argv array — never a shell** (`std::process::Command`), so the
/// prompt text cannot inject shell syntax. `{prompt}` and `{output}` placeholders in the args
/// are substituted as single argv elements; `{output}` is a temp PNG path the tool must write.
#[tauri::command]
async fn generate_image(bin: String, args: Vec<String>, prompt: String) -> Result<String, String> {
    if bin.trim().is_empty() {
        return Err("No generator command configured.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // Unique temp output path for the tool to write into.
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut out_path = std::env::temp_dir();
        out_path.push(format!("cxpaint-gen-{ts}.png"));
        let out_str = out_path.to_string_lossy().to_string();

        let final_args: Vec<String> = args
            .iter()
            .map(|a| a.replace("{prompt}", &prompt).replace("{output}", &out_str))
            .collect();

        let output = Command::new(&bin)
            .args(&final_args)
            .output()
            .map_err(|e| format!("Failed to launch '{bin}': {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Generator exited with {}: {}",
                output.status,
                stderr.trim()
            ));
        }

        let bytes = std::fs::read(&out_path)
            .map_err(|e| format!("No output image found at {out_str}: {e}"))?;
        let _ = std::fs::remove_file(&out_path);

        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:image/png;base64,{b64}"))
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![generate_image])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
