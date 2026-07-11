mod ai;
mod app;
mod managed_runtime;
mod menu;
mod png;
mod project;
mod provider_executable;
#[cfg(test)]
mod test_util;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use tauri::{Emitter, Manager, RunEvent};

use app::{queue_native_open_paths, PendingOpenPaths};
use menu::build_app_menu;

#[derive(Default)]
struct StudyCleanupLifecycle {
    pending: Mutex<Option<provider_executable::StudyEvidenceRequest>>,
    running: AtomicBool,
    allow_exit: AtomicBool,
}

impl StudyCleanupLifecycle {
    fn schedule(&self, cleanup: provider_executable::StudyEvidenceRequest) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Provider Free study cleanup state is unavailable.".to_string())?;
        if pending.replace(cleanup).is_some() {
            return Err("Provider Free study cleanup was scheduled more than once.".into());
        }
        Ok(())
    }

    fn begin(&self) -> Option<provider_executable::StudyEvidenceRequest> {
        let cleanup = self.pending.lock().ok()?.take()?;
        self.running.store(true, Ordering::Release);
        Some(cleanup)
    }

    fn finish(&self) {
        self.allow_exit.store(true, Ordering::Release);
        self.running.store(false, Ordering::Release);
    }

    fn must_hold_process(&self) -> bool {
        if self.allow_exit.load(Ordering::Acquire) {
            return false;
        }
        self.running.load(Ordering::Acquire)
            || self
                .pending
                .lock()
                .map(|pending| pending.is_some())
                .unwrap_or(true)
    }
}

#[cfg(target_os = "macos")]
fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingOpenPaths::default())
        .manage(StudyCleanupLifecycle::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if let Some(cleanup) = provider_executable::provider_free_study_cleanup()
                .map_err(std::io::Error::other)?
            {
                #[cfg(target_vendor = "apple")]
                {
                    app.state::<StudyCleanupLifecycle>()
                        .schedule(cleanup)
                        .map_err(std::io::Error::other)?;
                    tauri::WebviewWindowBuilder::new(
                        app,
                        "provider-free-study-cleanup",
                        tauri::WebviewUrl::App("index.html".into()),
                    )
                    .visible(false)
                    .build()?;
                    return Ok(());
                }
                #[cfg(not(target_vendor = "apple"))]
                return Err(std::io::Error::other(
                    "Provider Free study cleanup requires macOS 14 or newer.",
                )
                .into());
            }
            let study_profile = provider_executable::provider_free_study_profile()
                .map_err(std::io::Error::other)?;
            let boot_evidence = provider_executable::provider_free_study_boot_evidence()
                .map_err(std::io::Error::other)?;
            let deferred_main = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main" && !config.create);
            match (study_profile, deferred_main) {
                (Some(profile), Some(config)) => {
                    tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
                        .data_store_identifier(profile)
                        .build()?;
                    if let Some(evidence) = boot_evidence.as_ref() {
                        if evidence.profile != profile {
                            return Err(std::io::Error::other(
                                "Provider Free boot evidence profile does not match the window profile.",
                            )
                            .into());
                        }
                        provider_executable::write_study_lifecycle_evidence(
                            evidence,
                            "app-boot",
                        )
                        .map_err(std::io::Error::other)?;
                    }
                }
                (Some(_), None) => {
                    return Err(std::io::Error::other(
                        "Provider Free study profile requires a deferred main window.",
                    )
                    .into());
                }
                (None, Some(_)) => {
                    return Err(std::io::Error::other(
                        "Provider Free study bundle must be launched through the repository QA command.",
                    )
                    .into());
                }
                (None, None) => {}
            }
            managed_runtime::initialize(app.handle()).map_err(std::io::Error::other)?;
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
            app::set_app_menu_enabled,
            ai::cancel_ai_run,
            ai::submit_ai_director_input,
            ai::workflow_director::draft_workflow_with_director,
            ai::workflow_director::revise_workflow_with_director,
            ai::codex::detect_codex,
            ai::codex::discover_codex_capabilities,
            ai::claude::detect_claude,
            ai::claude::discover_claude_capabilities,
            ai::antigravity::detect_antigravity,
            ai::antigravity::discover_antigravity_capabilities,
            managed_runtime::managed_runtime_status,
            managed_runtime::install_managed_runtime,
            managed_runtime::login_managed_runtime,
            provider_executable::provider_qa_mode,
            provider_executable::provider_free_qa_png,
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
            project::project_commit_workflow_editor_return,
            project::project_finalize_workflow_editor_return,
            project::project_rollback_workflow_editor_return,
            project::project_read_asset,
            project::project_resolve_asset_material,
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
            if let RunEvent::ExitRequested { api, .. } = &event {
                if app.state::<StudyCleanupLifecycle>().must_hold_process() {
                    api.prevent_exit();
                }
            }

            if matches!(event, RunEvent::Ready) {
                if let Some(cleanup) = app.state::<StudyCleanupLifecycle>().begin() {
                    let handle = app.clone();
                    let watchdog_handle = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(30));
                        let lifecycle = watchdog_handle.state::<StudyCleanupLifecycle>();
                        if lifecycle.must_hold_process() {
                            eprintln!(
                                "[provider-free-study-cleanup] WebKit cleanup timed out after 30 seconds"
                            );
                            lifecycle.finish();
                            watchdog_handle.exit(1);
                        }
                    });
                    tauri::async_runtime::spawn(async move {
                        let result = async {
                            cleanup.wait_for_cleanup_release()?;
                            let identifiers = handle
                                .fetch_data_store_identifiers()
                                .await
                                .map_err(|error| error.to_string())?;
                            if identifiers.contains(&cleanup.profile) {
                                handle
                                    .remove_data_store(cleanup.profile)
                                    .await
                                    .map_err(|error| error.to_string())?;
                            }
                            provider_executable::write_study_lifecycle_evidence(
                                &cleanup,
                                "profile-removed",
                            )
                        }
                        .await;
                        handle.state::<StudyCleanupLifecycle>().finish();
                        if let Err(error) = result {
                            eprintln!("[provider-free-study-cleanup] {error}");
                            handle.exit(1);
                        } else {
                            handle.exit(0);
                        }
                    });
                }
            }

            #[cfg(target_os = "macos")]
            if matches!(event, RunEvent::Ready) {
                focus_main_window(app);
            }

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

pub fn run_ai_provider_wrapper_if_requested() -> Option<i32> {
    ai::run_provider_process_wrapper_if_requested()
}
