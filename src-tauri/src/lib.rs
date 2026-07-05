mod ai;
mod app;
mod menu;
mod png;
mod project;
#[cfg(test)]
mod test_util;

use tauri::{Emitter, RunEvent};

use app::{queue_native_open_paths, PendingOpenPaths};
use menu::build_app_menu;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingOpenPaths::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let menu = build_app_menu(app.handle())?;
            app.handle().set_menu(menu)?;
            app.handle().on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id.starts_with("app:") {
                    let _ = app.emit("app-menu", id.to_string());
                }
            });
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app::clipboard_read_text,
            app::clipboard_write_text,
            app::app_memory_info,
            ai::generate_image,
            ai::codex::detect_codex,
            ai::antigravity::detect_antigravity,
            ai::codex::generate_codex_image,
            ai::codex::generate_codex_fill_image,
            ai::codex::generate_codex_retouch_image,
            ai::codex::upscale_codex_image,
            ai::codex::decouple_codex_image,
            ai::codex::compose_codex_workflow,
            ai::antigravity::generate_antigravity_image,
            ai::antigravity::generate_antigravity_fill_image,
            ai::antigravity::generate_antigravity_retouch_image,
            ai::antigravity::upscale_antigravity_image,
            ai::antigravity::decouple_antigravity_image,
            ai::antigravity::compose_antigravity_workflow,
            project::project_open_folder,
            project::project_refresh,
            project::project_store_asset_bytes,
            project::project_read_asset,
            project::project_reveal,
            project::project_reveal_file,
            project::project_read_file,
            app::read_dropped_file,
            app::take_pending_open_paths,
            app::quit_app,
            project::project_delete_asset,
            project::project_write_document,
            project::project_write_document_path,
            project::project_save_document_as
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let RunEvent::Opened { urls } = event {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                queue_native_open_paths(app, paths);
            }
        });
}
