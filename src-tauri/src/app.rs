//! App-level utility commands: clipboard, memory stats, native file drops, quit.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Serialize;
use sysinfo::Pid;
use sysinfo::System;
use tauri::menu::MenuItemKind;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::Runtime;

use crate::project::mime_for_path;

const NATIVE_OPEN_FILES_EVENT: &str = "native-open-files";

#[derive(Clone, Default)]
pub(crate) struct PendingOpenPaths(Arc<Mutex<Vec<String>>>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppMemoryInfo {
    resident_bytes: u64,
    process_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeDroppedFile {
    path: String,
    name: String,
    bytes: Vec<u8>,
    size: u64,
    modified_at: u128,
    mime: Option<String>,
}

pub(crate) fn queue_native_open_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    app.state::<PendingOpenPaths>()
        .0
        .lock()
        .map(|mut pending| pending.extend(paths.clone()))
        .ok();
    let _ = app.emit(NATIVE_OPEN_FILES_EVENT, paths);
}

#[tauri::command]
pub(crate) fn take_pending_open_paths(state: tauri::State<'_, PendingOpenPaths>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn clipboard_read_text() -> Result<Option<String>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("Clipboard unavailable: {error}"))?;
    Ok(clipboard.get_text().ok())
}

#[tauri::command]
pub(crate) fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("Clipboard unavailable: {error}"))?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("Clipboard write failed: {error}"))
}

#[tauri::command]
pub(crate) fn app_memory_info() -> Result<AppMemoryInfo, String> {
    let mut system = System::new_all();
    system.refresh_all();

    let root_pid = Pid::from_u32(std::process::id());
    let mut resident_bytes = 0_u64;
    let mut process_count = 0_usize;

    for (pid, process) in system.processes() {
        let mut current = Some(*pid);
        let mut depth = 0;
        let mut belongs_to_app = false;

        while let Some(candidate) = current {
            if candidate == root_pid {
                belongs_to_app = true;
                break;
            }
            depth += 1;
            if depth > 64 {
                break;
            }
            current = system.process(candidate).and_then(|item| item.parent());
        }

        if belongs_to_app {
            resident_bytes = resident_bytes.saturating_add(process.memory());
            process_count += 1;
        }
    }

    Ok(AppMemoryInfo {
        resident_bytes,
        process_count,
    })
}

fn find_menu_item<R: Runtime>(items: Vec<MenuItemKind<R>>, id: &str) -> Option<MenuItemKind<R>> {
    for item in items {
        if item.id().as_ref() == id {
            return Some(item);
        }
        if let MenuItemKind::Submenu(submenu) = &item {
            if let Ok(children) = submenu.items() {
                if let Some(found) = find_menu_item(children, id) {
                    return Some(found);
                }
            }
        }
    }
    None
}

fn set_menu_item_enabled<R: Runtime>(item: &MenuItemKind<R>, enabled: bool) -> tauri::Result<()> {
    match item {
        MenuItemKind::MenuItem(item) => item.set_enabled(enabled),
        MenuItemKind::Submenu(item) => item.set_enabled(enabled),
        MenuItemKind::Check(item) => item.set_enabled(enabled),
        MenuItemKind::Icon(item) => item.set_enabled(enabled),
        MenuItemKind::Predefined(_) => Ok(()),
    }
}

#[tauri::command]
pub(crate) fn set_app_menu_enabled(
    app: AppHandle,
    enabled: HashMap<String, bool>,
) -> Result<(), String> {
    let menu = app
        .menu()
        .ok_or_else(|| "Application menu is unavailable".to_string())?;
    for (id, is_enabled) in enabled {
        let items = menu.items().map_err(|error| error.to_string())?;
        if let Some(item) = find_menu_item(items, &id) {
            set_menu_item_enabled(&item, is_enabled).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn read_dropped_file(path: String) -> Result<NativeDroppedFile, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<NativeDroppedFile, String> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err("Dropped file path is empty.".into());
        }

        let path = PathBuf::from(trimmed);
        if !path.is_file() {
            return Err(format!("Dropped path is not a file: {}", path.display()));
        }

        let metadata = fs::metadata(&path).map_err(|e| {
            format!(
                "Failed to read dropped file metadata at {}: {e}",
                path.display()
            )
        })?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let bytes = fs::read(&path)
            .map_err(|e| format!("Failed to read dropped file at {}: {e}", path.display()))?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("untitled")
            .to_string();

        Ok(NativeDroppedFile {
            path: path.to_string_lossy().to_string(),
            name,
            bytes,
            size: metadata.len(),
            modified_at,
            mime: mime_for_path(&path),
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) fn quit_app(app: AppHandle) {
    app.exit(0);
}
