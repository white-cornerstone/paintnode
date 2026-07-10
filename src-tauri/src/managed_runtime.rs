//! Independently updated AI provider packages.
//!
//! PaintNode ships a small, stable command contract in the app. Provider SDKs,
//! their native agent engines, and the Node/Python runtime they need live in
//! versioned packages under the app data directory and can update separately.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::ai::apply_ai_cli_environment;
use crate::provider_executable::{ensure_provider_launch_allowed, Provider};

const RUNTIME_PROTOCOL_VERSION: u32 = 1;
const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/white-cornerstone/paintnode/releases/download/provider-runtimes-latest/runtime-manifest.json";

static RUNTIME_ROOT: OnceLock<PathBuf> = OnceLock::new();
static BUSY_PROVIDER: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimePackageManifest {
    pub provider: String,
    pub package_version: String,
    pub sdk_version: String,
    pub engine_version: String,
    pub protocol_version: u32,
    #[serde(rename = "minimumPaintNodeVersion")]
    pub minimum_paintnode_version: String,
    pub runner: String,
    pub capabilities_runner: Option<String>,
    pub node: Option<String>,
    pub executable: String,
    #[serde(default)]
    pub login_args: Vec<String>,
    #[serde(default)]
    pub auth_check_args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReleaseManifest {
    schema_version: u32,
    packages: Vec<RuntimeReleasePackage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReleasePackage {
    provider: String,
    package_version: String,
    sdk_version: String,
    engine_version: String,
    protocol_version: u32,
    #[serde(rename = "minimumPaintNodeVersion")]
    minimum_paintnode_version: String,
    artifacts: Vec<RuntimeArtifact>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeArtifact {
    os: String,
    arch: String,
    url: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedRuntimeStatus {
    provider: String,
    state: String,
    installed_version: Option<String>,
    available_version: Option<String>,
    sdk_version: Option<String>,
    engine_version: Option<String>,
    download_size: Option<u64>,
    authenticated: Option<bool>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedRuntimeProgress {
    provider: String,
    phase: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    message: String,
}

struct BusyGuard;

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut busy) = BUSY_PROVIDER.lock() {
            *busy = None;
        }
    }
}

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate PaintNode app data: {error}"))?
        .join("runtimes");
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create managed runtime directory: {error}"))?;
    let _ = RUNTIME_ROOT.set(root);
    Ok(())
}

pub(crate) fn runtime_root() -> Option<&'static Path> {
    RUNTIME_ROOT.get().map(PathBuf::as_path)
}

fn validate_provider(provider: &str) -> Result<&str, String> {
    match provider {
        "codex" | "claude" => Ok(provider),
        _ => Err(format!("Unsupported managed AI provider: {provider}")),
    }
}

fn provider_root(provider: &str) -> Result<PathBuf, String> {
    validate_provider(provider)?;
    runtime_root()
        .map(|root| root.join(provider))
        .ok_or_else(|| "Managed runtime service has not been initialized.".into())
}

fn active_version(provider: &str) -> Option<String> {
    let path = provider_root(provider).ok()?.join("active.json");
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

fn active_package_dir(provider: &str) -> Option<PathBuf> {
    let version = active_version(provider)?;
    Some(provider_root(provider).ok()?.join("versions").join(version))
}

pub(crate) fn active_package_manifest(provider: &str) -> Option<RuntimePackageManifest> {
    let bytes = fs::read(active_package_dir(provider)?.join("runtime-package.json")).ok()?;
    let manifest: RuntimePackageManifest = serde_json::from_slice(&bytes).ok()?;
    package_is_compatible(&manifest).then_some(manifest)
}

pub(crate) fn managed_runner(provider: &str) -> Option<PathBuf> {
    let package = active_package_dir(provider)?;
    let manifest = active_package_manifest(provider)?;
    Some(package.join(manifest.runner))
}

pub(crate) fn managed_capabilities_runner(provider: &str) -> Option<PathBuf> {
    let package = active_package_dir(provider)?;
    let manifest = active_package_manifest(provider)?;
    Some(package.join(manifest.capabilities_runner.unwrap_or(manifest.runner)))
}

pub(crate) fn managed_node(provider: &str) -> Option<PathBuf> {
    let package = active_package_dir(provider)?;
    let manifest = active_package_manifest(provider)?;
    manifest.node.map(|node| package.join(node))
}

pub(crate) fn managed_executable(provider: &str) -> Option<PathBuf> {
    let package = active_package_dir(provider)?;
    let manifest = active_package_manifest(provider)?;
    Some(package.join(manifest.executable))
}

fn package_is_compatible(manifest: &RuntimePackageManifest) -> bool {
    manifest.protocol_version == RUNTIME_PROTOCOL_VERSION
        && version_at_least(
            env!("CARGO_PKG_VERSION"),
            &manifest.minimum_paintnode_version,
        )
}

fn version_at_least(current: &str, minimum: &str) -> bool {
    match (Version::parse(current), Version::parse(minimum)) {
        (Ok(current), Ok(minimum)) => current >= minimum,
        _ => current == minimum,
    }
}

fn release_manifest_url(override_url: Option<String>) -> String {
    override_url
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
        .or_else(|| std::env::var("PAINTNODE_RUNTIME_MANIFEST_URL").ok())
        .unwrap_or_else(|| DEFAULT_MANIFEST_URL.into())
}

fn current_target() -> (&'static str, &'static str) {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    (os, arch)
}

fn fetch_release_manifest(url: &str) -> Result<RuntimeReleaseManifest, String> {
    let response = reqwest::blocking::get(url)
        .map_err(|error| format!("Could not check provider updates: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Provider update service returned HTTP {}.",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("Could not read provider update manifest: {error}"))?;
    parse_release_manifest(&bytes)
}

fn parse_release_manifest(bytes: &[u8]) -> Result<RuntimeReleaseManifest, String> {
    let manifest: RuntimeReleaseManifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("Provider update manifest is invalid: {error}"))?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "Provider update manifest schema {} is not supported.",
            manifest.schema_version
        ));
    }
    Ok(manifest)
}

fn release_for<'a>(
    manifest: &'a RuntimeReleaseManifest,
    provider: &str,
) -> Result<(&'a RuntimeReleasePackage, &'a RuntimeArtifact), String> {
    let package = manifest
        .packages
        .iter()
        .find(|package| package.provider == provider)
        .ok_or_else(|| format!("No managed {provider} package is currently published."))?;
    if package.protocol_version != RUNTIME_PROTOCOL_VERSION {
        return Err(format!(
            "The available {provider} package requires a newer PaintNode runtime protocol."
        ));
    }
    if !version_at_least(
        env!("CARGO_PKG_VERSION"),
        &package.minimum_paintnode_version,
    ) {
        return Err(format!(
            "Update PaintNode to {} or newer before installing this {provider} package.",
            package.minimum_paintnode_version
        ));
    }
    let (os, arch) = current_target();
    let artifact = package
        .artifacts
        .iter()
        .find(|artifact| artifact.os == os && artifact.arch == arch)
        .ok_or_else(|| format!("No managed {provider} package is available for {os}-{arch}."))?;
    Ok((package, artifact))
}

fn local_status(provider: &str) -> ManagedRuntimeStatus {
    let manifest = active_package_manifest(provider);
    ManagedRuntimeStatus {
        provider: provider.into(),
        state: if manifest.is_some() {
            "ready"
        } else {
            "notInstalled"
        }
        .into(),
        installed_version: manifest.as_ref().map(|item| item.package_version.clone()),
        available_version: None,
        sdk_version: manifest.as_ref().map(|item| item.sdk_version.clone()),
        engine_version: manifest.as_ref().map(|item| item.engine_version.clone()),
        download_size: None,
        authenticated: manifest
            .as_ref()
            .and_then(|item| check_auth(provider, item).ok()),
        message: None,
    }
}

fn check_auth(provider: &str, package: &RuntimePackageManifest) -> Result<bool, String> {
    if package.auth_check_args.is_empty() {
        return Ok(true);
    }
    let executable = managed_executable(provider)
        .ok_or_else(|| format!("Managed {provider} executable is missing."))?;
    ensure_provider_launch_allowed(match provider {
        "codex" => Provider::Codex,
        "claude" => Provider::Claude,
        _ => return Err(format!("Unsupported managed AI provider: {provider}")),
    })?;
    let mut command = Command::new(executable);
    apply_ai_cli_environment(&mut command);
    command
        .args(&package.auth_check_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .status()
        .map(|status| status.success())
        .map_err(|error| format!("Could not check {provider} sign-in: {error}"))
}

#[tauri::command]
pub(crate) async fn managed_runtime_status(
    provider: String,
    check_updates: Option<bool>,
    manifest_url: Option<String>,
) -> Result<ManagedRuntimeStatus, String> {
    validate_provider(&provider)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut status = local_status(&provider);
        if check_updates != Some(true) {
            return Ok(status);
        }
        let url = release_manifest_url(manifest_url);
        match fetch_release_manifest(&url).and_then(|manifest| {
            let (package, artifact) = release_for(&manifest, &provider)?;
            Ok((package.clone(), artifact.clone()))
        }) {
            Ok((package, artifact)) => {
                status.available_version = Some(package.package_version.clone());
                status.download_size = Some(artifact.size);
                if status.installed_version.is_none() {
                    status.sdk_version = Some(package.sdk_version.clone());
                    status.engine_version = Some(package.engine_version.clone());
                }
                if status.installed_version.as_deref() != Some(package.package_version.as_str()) {
                    status.state = if status.installed_version.is_some() {
                        "updateAvailable"
                    } else {
                        "notInstalled"
                    }
                    .into();
                }
            }
            Err(error) if status.installed_version.is_some() => status.message = Some(error),
            Err(error) => return Err(error),
        }
        Ok(status)
    })
    .await
    .map_err(|error| format!("Managed runtime status task failed: {error}"))?
}

fn emit_progress(
    app: &AppHandle,
    provider: &str,
    phase: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "managed-runtime-progress",
        ManagedRuntimeProgress {
            provider: provider.into(),
            phase: phase.into(),
            downloaded_bytes,
            total_bytes,
            message: message.into(),
        },
    );
}

fn download_artifact(
    app: &AppHandle,
    provider: &str,
    artifact: &RuntimeArtifact,
    destination: &Path,
) -> Result<(), String> {
    let mut response = reqwest::blocking::get(&artifact.url)
        .map_err(|error| format!("Could not download {provider}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "{provider} download returned HTTP {}.",
            response.status()
        ));
    }
    let total = response.content_length().or(Some(artifact.size));
    let mut file = File::create(destination)
        .map_err(|error| format!("Could not create {provider} download: {error}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {provider} download: {error}"))?;
        if count == 0 {
            break;
        }
        file.write_all(&buffer[..count])
            .map_err(|error| format!("Could not save {provider} download: {error}"))?;
        hasher.update(&buffer[..count]);
        downloaded += count as u64;
        emit_progress(
            app,
            provider,
            "downloading",
            downloaded,
            total,
            "Downloading provider support…",
        );
    }
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(&artifact.sha256) {
        return Err(format!(
            "The {provider} package failed integrity verification. Expected {}, received {actual}.",
            artifact.sha256
        ));
    }
    Ok(())
}

fn extract_archive(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive_path)
        .map_err(|error| format!("Could not open provider package: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Provider package is not a valid ZIP archive: {error}"))?;
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create provider package directory: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Could not read provider package entry: {error}"))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| "Provider package contains an unsafe path.".to_string())?
            .to_path_buf();
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| format!("Could not create provider directory: {error}"))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create provider directory: {error}"))?;
        }
        let mut target = File::create(&output)
            .map_err(|error| format!("Could not extract provider file: {error}"))?;
        std::io::copy(&mut entry, &mut target)
            .map_err(|error| format!("Could not extract provider file: {error}"))?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&output, fs::Permissions::from_mode(mode))
                .map_err(|error| format!("Could not set provider file permissions: {error}"))?;
        }
    }
    Ok(())
}

fn activate_package(
    provider: &str,
    package_dir: &Path,
    expected_version: &str,
) -> Result<(), String> {
    let bytes = fs::read(package_dir.join("runtime-package.json"))
        .map_err(|error| format!("Provider package manifest is missing: {error}"))?;
    let manifest: RuntimePackageManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Provider package manifest is invalid: {error}"))?;
    if manifest.provider != provider || manifest.package_version != expected_version {
        return Err("Provider package identity does not match the update manifest.".into());
    }
    if !package_is_compatible(&manifest) {
        return Err("Provider package is not compatible with this PaintNode version.".into());
    }
    for required in [&manifest.runner, &manifest.executable] {
        if !package_dir.join(required).is_file() {
            return Err(format!(
                "Provider package is missing required file `{required}`."
            ));
        }
    }
    if let Some(node) = manifest.node.as_deref() {
        if !package_dir.join(node).is_file() {
            return Err(format!(
                "Provider package is missing required file `{node}`."
            ));
        }
    }
    let root = provider_root(provider)?;
    let active_path = root.join("active.json");
    let temporary = root.join("active.json.new");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&serde_json::json!({ "version": expected_version }))
            .map_err(|error| format!("Could not encode provider activation: {error}"))?,
    )
    .map_err(|error| format!("Could not save provider activation: {error}"))?;
    fs::rename(&temporary, &active_path)
        .map_err(|error| format!("Could not activate provider package: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn install_managed_runtime(
    app: AppHandle,
    provider: String,
    manifest_url: Option<String>,
) -> Result<ManagedRuntimeStatus, String> {
    validate_provider(&provider)?;
    {
        let mut busy = BUSY_PROVIDER
            .lock()
            .map_err(|_| "Managed runtime installer is unavailable.".to_string())?;
        if let Some(active) = busy.as_deref() {
            return Err(format!("{active} setup is already in progress."));
        }
        *busy = Some(provider.clone());
    }
    let _guard = BusyGuard;
    tauri::async_runtime::spawn_blocking(move || {
        emit_progress(
            &app,
            &provider,
            "checking",
            0,
            None,
            "Checking the latest compatible version…",
        );
        let manifest = fetch_release_manifest(&release_manifest_url(manifest_url))?;
        let (release, artifact) = release_for(&manifest, &provider)?;
        let release = release.clone();
        let artifact = artifact.clone();
        let root = provider_root(&provider)?;
        let downloads = root.join("downloads");
        let versions = root.join("versions");
        fs::create_dir_all(&downloads)
            .map_err(|error| format!("Could not prepare provider download directory: {error}"))?;
        fs::create_dir_all(&versions)
            .map_err(|error| format!("Could not prepare provider versions directory: {error}"))?;
        let archive = downloads.join(format!("{}.zip.part", release.package_version));
        let staging = versions.join(format!("{}.installing", release.package_version));
        let destination = versions.join(&release.package_version);
        let _ = fs::remove_file(&archive);
        let _ = fs::remove_dir_all(&staging);
        download_artifact(&app, &provider, &artifact, &archive)?;
        emit_progress(
            &app,
            &provider,
            "installing",
            artifact.size,
            Some(artifact.size),
            "Installing provider support…",
        );
        extract_archive(&archive, &staging)?;
        if destination.exists() {
            fs::remove_dir_all(&destination)
                .map_err(|error| format!("Could not replace provider package: {error}"))?;
        }
        fs::rename(&staging, &destination)
            .map_err(|error| format!("Could not finalize provider package: {error}"))?;
        activate_package(&provider, &destination, &release.package_version)?;
        let _ = fs::remove_file(&archive);
        emit_progress(
            &app,
            &provider,
            "ready",
            artifact.size,
            Some(artifact.size),
            "Provider support is ready.",
        );
        Ok(local_status(&provider))
    })
    .await
    .map_err(|error| format!("Managed runtime install task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn login_managed_runtime(
    app: AppHandle,
    provider: String,
) -> Result<ManagedRuntimeStatus, String> {
    validate_provider(&provider)?;
    tauri::async_runtime::spawn_blocking(move || {
        let package = active_package_manifest(&provider)
            .ok_or_else(|| format!("Install {provider} support before signing in."))?;
        let executable = managed_executable(&provider)
            .ok_or_else(|| format!("Managed {provider} executable is missing."))?;
        ensure_provider_launch_allowed(match provider.as_str() {
            "codex" => Provider::Codex,
            "claude" => Provider::Claude,
            _ => return Err(format!("Unsupported managed AI provider: {provider}")),
        })?;
        emit_progress(
            &app,
            &provider,
            "authenticating",
            0,
            None,
            "Continue sign-in in your browser…",
        );
        let mut command = Command::new(executable);
        apply_ai_cli_environment(&mut command);
        command.args(&package.login_args);
        let status = command
            .status()
            .map_err(|error| format!("Could not start {provider} sign-in: {error}"))?;
        if !status.success() {
            return Err(format!("{provider} sign-in did not complete successfully."));
        }
        let status = local_status(&provider);
        if status.authenticated == Some(false) {
            return Err(format!(
                "{provider} did not report an authenticated account."
            ));
        }
        emit_progress(&app, &provider, "ready", 0, None, "Signed in and ready.");
        Ok(status)
    })
    .await
    .map_err(|error| format!("Managed runtime sign-in task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_provider_ids_are_accepted() {
        assert!(validate_provider("codex").is_ok());
        assert!(validate_provider("claude").is_ok());
        assert!(validate_provider("antigravity").is_err());
        assert!(validate_provider("../escape").is_err());
    }

    #[test]
    fn compatibility_requires_protocol_and_app_version() {
        let mut manifest = RuntimePackageManifest {
            provider: "codex".into(),
            package_version: "1.0.0".into(),
            sdk_version: "1.0.0".into(),
            engine_version: "1.0.0".into(),
            protocol_version: RUNTIME_PROTOCOL_VERSION,
            minimum_paintnode_version: env!("CARGO_PKG_VERSION").into(),
            runner: "bridge/runner.mjs".into(),
            capabilities_runner: None,
            node: Some("bin/node".into()),
            executable: "bin/codex".into(),
            login_args: vec!["login".into()],
            auth_check_args: vec!["login".into(), "status".into()],
        };
        assert!(package_is_compatible(&manifest));
        manifest.protocol_version += 1;
        assert!(!package_is_compatible(&manifest));
    }

    #[test]
    fn semver_compatibility_is_not_lexicographic() {
        assert!(version_at_least("0.10.0", "0.9.9"));
        assert!(!version_at_least("0.9.9", "0.10.0"));
    }

    #[test]
    fn release_manifest_parses_json_bytes_without_a_json_content_type() {
        let manifest = parse_release_manifest(
            br#"{
              "schemaVersion": 1,
              "packages": []
            }"#,
        )
        .expect("release manifest should parse from downloaded bytes");

        assert_eq!(manifest.schema_version, 1);
        assert!(manifest.packages.is_empty());
    }

    #[test]
    fn manifests_preserve_paintnode_product_name_casing() {
        let package: RuntimePackageManifest = serde_json::from_str(
            r#"{
              "provider": "codex",
              "packageVersion": "1.0.0",
              "sdkVersion": "0.144.0",
              "engineVersion": "codex-cli 0.144.0",
              "protocolVersion": 1,
              "minimumPaintNodeVersion": "0.2.0",
              "runner": "bridge/codex-sdk-runner.mjs",
              "capabilitiesRunner": "bridge/codex-capabilities.mjs",
              "node": "bin/node",
              "executable": "engine/codex"
            }"#,
        )
        .expect("package manifest should accept the published PaintNode field casing");
        assert_eq!(package.minimum_paintnode_version, "0.2.0");

        let release = parse_release_manifest(
            br#"{
              "schemaVersion": 1,
              "packages": [{
                "provider": "codex",
                "packageVersion": "1.0.0",
                "sdkVersion": "0.144.0",
                "engineVersion": "codex-cli 0.144.0",
                "protocolVersion": 1,
                "minimumPaintNodeVersion": "0.2.0",
                "artifacts": []
              }]
            }"#,
        )
        .expect("release manifest should accept the published PaintNode field casing");
        assert_eq!(release.packages[0].minimum_paintnode_version, "0.2.0");
    }
}
