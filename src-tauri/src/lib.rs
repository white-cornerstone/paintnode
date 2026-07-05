mod ai;
mod app;
mod menu;
mod png;
mod project;
#[cfg(test)]
mod test_util;

use tauri::{Emitter, Manager, RunEvent};

use app::{queue_native_open_paths, PendingOpenPaths};
use menu::build_app_menu;

const APP_ICON_BYTES: &[u8] = include_bytes!("../icons/icon.png");

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

            set_application_icon();

            let icon_image = image::load_from_memory(APP_ICON_BYTES)?.to_rgba8();
            let (icon_width, icon_height) = icon_image.dimensions();
            let icon = tauri::image::Image::new_owned(icon_image.into_raw(), icon_width, icon_height);
            for window in app.webview_windows().values() {
                window.set_icon(icon.clone())?;
            }

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
            ai::cancel_ai_run,
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

#[cfg(target_os = "macos")]
fn set_application_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    let icon_data = NSData::with_bytes(APP_ICON_BYTES);
    let Some(icon_image) = NSImage::initWithData(NSImage::alloc(), &icon_data) else {
        return;
    };

    unsafe {
        NSApplication::sharedApplication(main_thread).setApplicationIconImage(Some(&icon_image));
    }
}

#[cfg(not(target_os = "macos"))]
fn set_application_icon() {}
