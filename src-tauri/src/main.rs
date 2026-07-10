// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = paintnode_lib::run_ai_provider_wrapper_if_requested() {
        std::process::exit(code);
    }
    paintnode_lib::run();
}
