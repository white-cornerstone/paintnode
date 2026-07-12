use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

#[cfg(windows)]
use sha2::{Digest, Sha256};

use crate::ai::{
    apply_ai_cli_environment, cleanup_ai_process_tree_after_bridge_exit,
    configure_ai_process_group, join_output_readers_bounded, terminate_ai_process_tree,
    track_ai_process_tree, OUTPUT_READER_JOIN_TIMEOUT,
};

const QA_MODE_ENV: &str = "PAINTNODE_PROVIDER_QA_MODE";
const PROVIDER_FREE_STUDY_PROFILE_ENV: &str = "PAINTNODE_PROVIDER_FREE_STUDY_PROFILE";
const PROVIDER_FREE_STUDY_BOOT_NONCE_ENV: &str = "PAINTNODE_PROVIDER_FREE_STUDY_BOOT_NONCE";
const PROVIDER_FREE_STUDY_BOOT_EVIDENCE_ENV: &str = "PAINTNODE_PROVIDER_FREE_STUDY_BOOT_EVIDENCE";
const PROVIDER_FREE_STUDY_BOOT_RELEASE_ENV: &str = "PAINTNODE_PROVIDER_FREE_STUDY_BOOT_RELEASE";
const PROVIDER_FREE_STUDY_BUILD_IDENTITY_ENV: &str = "PAINTNODE_PROVIDER_FREE_STUDY_BUILD_IDENTITY";
const PROVIDER_FREE_STUDY_CLEANUP_PROFILE_ENV: &str =
    "PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_PROFILE";
const PROVIDER_FREE_STUDY_CLEANUP_NONCE_ENV: &str = "PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_NONCE";
const PROVIDER_FREE_STUDY_CLEANUP_EVIDENCE_ENV: &str =
    "PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_EVIDENCE";
const PROVIDER_FREE_STUDY_CLEANUP_RELEASE_ENV: &str =
    "PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_RELEASE";
const QA_PREFLIGHT_ENV: &str = "PAINTNODE_PROVIDER_QA_PREFLIGHT";
const QA_PREFLIGHT_MARKER: &str = "provider-doctor-v1";
/// Keep native discovery aligned with the provider doctor: a version probe may
/// occupy one resolver slot for at most 15 seconds before failing closed.
const PROVIDER_VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const VERSION_PROBE_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Provider {
    Codex,
    Antigravity,
    Claude,
    Grok,
}

impl Provider {
    fn command_name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Antigravity => "agy",
            Self::Claude => "claude",
            Self::Grok => "grok",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Antigravity => "Antigravity",
            Self::Claude => "Claude",
            Self::Grok => "Grok",
        }
    }

    fn qa_path_env(self) -> &'static str {
        match self {
            Self::Codex => "PAINTNODE_QA_CODEX_BIN",
            Self::Antigravity => "PAINTNODE_QA_ANTIGRAVITY_BIN",
            Self::Claude => "PAINTNODE_QA_CLAUDE_BIN",
            Self::Grok => "PAINTNODE_QA_GROK_BIN",
        }
    }

    fn qa_version_env(self) -> &'static str {
        match self {
            Self::Codex => "PAINTNODE_QA_CODEX_VERSION",
            Self::Antigravity => "PAINTNODE_QA_ANTIGRAVITY_VERSION",
            Self::Claude => "PAINTNODE_QA_CLAUDE_VERSION",
            Self::Grok => "PAINTNODE_QA_GROK_VERSION",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HostPlatform {
    MacOsArm64,
    MacOsX64,
    Other,
}

impl HostPlatform {
    fn current() -> Self {
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Self::MacOsArm64
        } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
            Self::MacOsX64
        } else {
            Self::Other
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HostTarget {
    MacOsArm64,
    MacOsX64,
    LinuxArm64,
    LinuxX64,
    WindowsArm64,
    WindowsX64,
    Unsupported,
}

impl HostTarget {
    fn current() -> Self {
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Self::MacOsArm64
        } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
            Self::MacOsX64
        } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
            Self::LinuxArm64
        } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            Self::LinuxX64
        } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
            Self::WindowsArm64
        } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            Self::WindowsX64
        } else {
            Self::Unsupported
        }
    }

    fn is_macos(self) -> bool {
        matches!(self, Self::MacOsArm64 | Self::MacOsX64)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct VerifiedFileIdentity {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
    #[cfg(windows)]
    sha256: [u8; 32],
}

impl VerifiedFileIdentity {
    fn capture(path: &Path) -> Result<Self, String> {
        let metadata = fs::metadata(path).map_err(|error| {
            format!("Could not inspect provider at {}: {error}", path.display())
        })?;
        if !metadata.is_file() {
            return Err(format!("Provider path is not a file: {}", path.display()));
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(unix)]
            changed_seconds: metadata.ctime(),
            #[cfg(unix)]
            changed_nanoseconds: metadata.ctime_nsec(),
            #[cfg(windows)]
            sha256: {
                let mut file = fs::File::open(path).map_err(|error| {
                    format!("Could not hash provider at {}: {error}", path.display())
                })?;
                let mut hasher = Sha256::new();
                let mut buffer = [0_u8; 128 * 1024];
                loop {
                    let count = file.read(&mut buffer).map_err(|error| {
                        format!("Could not hash provider at {}: {error}", path.display())
                    })?;
                    if count == 0 {
                        break;
                    }
                    hasher.update(&buffer[..count]);
                }
                hasher.finalize().into()
            },
        })
    }

    fn launch_json(&self) -> String {
        #[cfg(unix)]
        return serde_json::json!({
            "version": 1,
            "length": self.len.to_string(),
            "unix": {
                "device": self.device.to_string(),
                "inode": self.inode.to_string(),
                "changedSeconds": self.changed_seconds.to_string(),
                "changedNanoseconds": self.changed_nanoseconds.to_string(),
            }
        })
        .to_string();
        #[cfg(windows)]
        return serde_json::json!({
            "version": 1,
            "length": self.len.to_string(),
            "sha256": self.sha256.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        })
        .to_string();
        #[cfg(not(any(unix, windows)))]
        serde_json::json!({
            "version": 1,
            "length": self.len.to_string(),
        })
        .to_string()
    }
}

#[derive(Debug)]
struct PreparedProviderCandidate {
    path: PathBuf,
    identity: VerifiedFileIdentity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedProviderExecutable {
    provider: Provider,
    pub(crate) path: String,
    pub(crate) version: String,
    identity: VerifiedFileIdentity,
}

impl ResolvedProviderExecutable {
    pub(crate) fn revalidate_for_launch(&self) -> Result<&str, String> {
        revalidate_resolved_provider_with(self, &mut verify_macos_provider_trust)
    }

    pub(crate) fn launch_identity_json(&self) -> String {
        self.identity.launch_json()
    }
}

impl std::ops::Deref for ResolvedProviderExecutable {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.path
    }
}

impl std::fmt::Display for ResolvedProviderExecutable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.path)
    }
}

type FileFingerprint = VerifiedFileIdentity;

#[derive(Default)]
struct RejectionCache {
    rejections: HashMap<PathBuf, CachedRejection>,
    in_flight: HashMap<PathBuf, u64>,
    waiters: HashMap<(PathBuf, u64), usize>,
    completed: HashMap<(PathBuf, u64), CompletedProbe>,
    next_generation: u64,
}

#[derive(Clone)]
struct CachedRejection {
    fingerprint: Option<FileFingerprint>,
    reason: String,
}

enum ProbeClaim {
    Owner(u64),
    Rejected(String),
}

#[derive(Clone)]
enum CompletedProbe {
    Accepted,
    Rejected(String),
}

impl RejectionCache {
    fn fingerprint(path: &Path) -> Option<FileFingerprint> {
        VerifiedFileIdentity::capture(path).ok()
    }

    fn unchanged_rejection(&self, path: &Path) -> Option<&CachedRejection> {
        self.rejections
            .get(path)
            .filter(|rejection| rejection.fingerprint == Self::fingerprint(path))
    }

    fn finish(&mut self, path: &Path, generation: u64, outcome: CompletedProbe) {
        if self.in_flight.get(path) != Some(&generation) {
            return;
        }
        self.in_flight.remove(path);
        let key = (path.to_path_buf(), generation);
        if self.waiters.get(&key).copied().unwrap_or_default() > 0 {
            self.completed.insert(key, outcome);
        }
    }

    fn reject(&mut self, path: PathBuf, generation: u64, reason: String) {
        self.rejections.insert(
            path.clone(),
            CachedRejection {
                fingerprint: Self::fingerprint(&path),
                reason: reason.clone(),
            },
        );
        self.finish(&path, generation, CompletedProbe::Rejected(reason));
    }

    fn reject_transient(&mut self, path: &Path, generation: u64, reason: String) {
        self.finish(path, generation, CompletedProbe::Rejected(reason));
    }

    fn accept(&mut self, path: &Path, generation: u64) {
        self.rejections.remove(path);
        self.finish(path, generation, CompletedProbe::Accepted);
    }

    fn consume_completed(&mut self, key: &(PathBuf, u64)) -> Option<CompletedProbe> {
        let completed = self.completed.get(key)?.clone();
        if let Some(waiters) = self.waiters.get_mut(key) {
            *waiters -= 1;
            if *waiters == 0 {
                self.waiters.remove(key);
                self.completed.remove(key);
            }
        }
        Some(completed)
    }
}

#[derive(Default)]
struct ResolutionCache {
    state: Mutex<RejectionCache>,
    probe_finished: Condvar,
}

impl ResolutionCache {
    fn begin_probe(&self, path: &Path) -> Result<ProbeClaim, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Provider executable rejection cache is unavailable.".to_string())?;
        loop {
            if let Some(rejection) = state.unchanged_rejection(path) {
                return Ok(ProbeClaim::Rejected(rejection.reason.clone()));
            }
            let Some(generation) = state.in_flight.get(path).copied() else {
                let generation = state.next_generation;
                state.next_generation = state.next_generation.wrapping_add(1);
                state.in_flight.insert(path.to_path_buf(), generation);
                return Ok(ProbeClaim::Owner(generation));
            };
            let key = (path.to_path_buf(), generation);
            *state.waiters.entry(key.clone()).or_default() += 1;
            loop {
                state = self.probe_finished.wait(state).map_err(|_| {
                    "Provider executable rejection cache is unavailable.".to_string()
                })?;
                if let Some(completed) = state.consume_completed(&key) {
                    match completed {
                        CompletedProbe::Rejected(reason) => {
                            return Ok(ProbeClaim::Rejected(reason));
                        }
                        CompletedProbe::Accepted => break,
                    }
                }
            }
        }
    }

    fn accept(&self, path: &Path, generation: u64) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "Provider executable rejection cache is unavailable.".to_string())?
            .accept(path, generation);
        self.probe_finished.notify_all();
        Ok(())
    }

    fn reject(&self, path: PathBuf, generation: u64, reason: String) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "Provider executable rejection cache is unavailable.".to_string())?
            .reject(path, generation, reason);
        self.probe_finished.notify_all();
        Ok(())
    }

    fn reject_transient(&self, path: &Path, generation: u64, reason: String) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "Provider executable rejection cache is unavailable.".to_string())?
            .reject_transient(path, generation, reason);
        self.probe_finished.notify_all();
        Ok(())
    }
}

static REJECTIONS: OnceLock<ResolutionCache> = OnceLock::new();

fn rejection_cache() -> &'static ResolutionCache {
    REJECTIONS.get_or_init(ResolutionCache::default)
}

fn candidate_paths(
    provider: Provider,
    configured: Option<PathBuf>,
    managed: Option<PathBuf>,
    sdk_bundled: Option<PathBuf>,
    home: Option<&Path>,
    host: HostPlatform,
) -> Vec<PathBuf> {
    let command = provider.command_name();
    let mut candidates = Vec::new();
    if let Some(configured) = configured {
        candidates.push(configured);
    }
    if let Some(managed) = managed {
        candidates.push(managed);
    }
    if let Some(sdk_bundled) = sdk_bundled {
        candidates.push(sdk_bundled);
    }
    if provider == Provider::Antigravity {
        if let Some(home) = home {
            candidates.push(home.join(".local/bin/agy"));
        }
    }
    if provider == Provider::Grok {
        if let Some(home) = home {
            candidates.push(home.join(".local/bin/grok"));
            candidates.push(home.join(".grok/bin/grok"));
        }
    }
    match host {
        HostPlatform::MacOsArm64 => {
            candidates.push(PathBuf::from(format!("/opt/homebrew/bin/{command}")));
            candidates.push(PathBuf::from(format!("/usr/local/bin/{command}")));
        }
        HostPlatform::MacOsX64 => {
            candidates.push(PathBuf::from(format!("/usr/local/bin/{command}")));
            candidates.push(PathBuf::from(format!("/opt/homebrew/bin/{command}")));
        }
        HostPlatform::Other => {}
    }
    candidates.push(PathBuf::from(command));
    candidates
}

fn sdk_bundled_codex_launcher() -> Option<PathBuf> {
    let launcher = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("node_modules/@openai/codex/bin/codex.js");
    launcher.is_file().then_some(launcher)
}

fn resolve_path_candidate_for_host(
    candidate: &Path,
    path_env: Option<&OsStr>,
    path_ext: Option<&OsStr>,
    host: HostTarget,
) -> Option<PathBuf> {
    let is_bare_name = candidate.components().count() == 1;
    let path = if is_bare_name {
        let search_path = path_env
            .map(OsString::from)
            .or_else(|| std::env::var_os("PATH"))?;
        let windows = matches!(host, HostTarget::WindowsArm64 | HostTarget::WindowsX64);
        let extensions = if windows && candidate.extension().is_none() {
            path_ext
                .map(|value| value.to_string_lossy().into_owned())
                .or_else(|| std::env::var("PATHEXT").ok())
                .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
                .split(';')
                .filter(|extension| !extension.is_empty())
                .flat_map(|extension| {
                    [
                        extension.to_string(),
                        extension.to_ascii_lowercase(),
                        extension.to_ascii_uppercase(),
                    ]
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        std::env::split_paths(&search_path)
            .flat_map(|directory| {
                let direct = std::iter::once(directory.join(candidate));
                let extended = extensions.iter().map(move |extension| {
                    directory.join(format!("{}{extension}", candidate.display()))
                });
                direct.chain(extended)
            })
            .find(|path| path.is_file())?
    } else {
        candidate.to_path_buf()
    };
    fs::canonicalize(&path).ok().or(Some(path))
}

fn resolve_path_candidate(
    candidate: &Path,
    path_env: Option<&OsStr>,
    host: HostTarget,
) -> Option<PathBuf> {
    resolve_path_candidate_for_host(
        candidate,
        path_env,
        std::env::var_os("PATHEXT").as_deref(),
        host,
    )
}

fn official_codex_native_target(
    host: HostTarget,
) -> Option<(&'static str, &'static str, &'static str)> {
    match host {
        HostTarget::MacOsArm64 => Some((
            "@openai/codex-darwin-arm64",
            "aarch64-apple-darwin",
            "codex",
        )),
        HostTarget::MacOsX64 => Some(("@openai/codex-darwin-x64", "x86_64-apple-darwin", "codex")),
        HostTarget::LinuxArm64 => Some((
            "@openai/codex-linux-arm64",
            "aarch64-unknown-linux-musl",
            "codex",
        )),
        HostTarget::LinuxX64 => Some((
            "@openai/codex-linux-x64",
            "x86_64-unknown-linux-musl",
            "codex",
        )),
        HostTarget::WindowsArm64 => Some((
            "@openai/codex-win32-arm64",
            "aarch64-pc-windows-msvc",
            "codex.exe",
        )),
        HostTarget::WindowsX64 => Some((
            "@openai/codex-win32-x64",
            "x86_64-pc-windows-msvc",
            "codex.exe",
        )),
        HostTarget::Unsupported => None,
    }
}

fn official_codex_platform_metadata_matches(
    metadata: &serde_json::Value,
    platform_package: &str,
    host: HostTarget,
) -> bool {
    let name = metadata.get("name").and_then(serde_json::Value::as_str);
    if name == Some(platform_package) {
        return true;
    }
    let (expected_os, expected_cpu) = match host {
        HostTarget::MacOsArm64 => ("darwin", "arm64"),
        HostTarget::MacOsX64 => ("darwin", "x64"),
        HostTarget::LinuxArm64 => ("linux", "arm64"),
        HostTarget::LinuxX64 => ("linux", "x64"),
        HostTarget::WindowsArm64 => ("win32", "arm64"),
        HostTarget::WindowsX64 => ("win32", "x64"),
        HostTarget::Unsupported => return false,
    };
    let contains = |field: &str, expected: &str| {
        metadata
            .get(field)
            .and_then(serde_json::Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(expected)))
    };
    name == Some("@openai/codex") && contains("os", expected_os) && contains("cpu", expected_cpu)
}

fn official_codex_native_from_launcher(
    launcher: &Path,
    host: HostTarget,
) -> Result<Option<PathBuf>, String> {
    let package_root = if launcher.file_name() == Some(OsStr::new("codex.js"))
        && launcher.parent().and_then(Path::file_name) == Some(OsStr::new("bin"))
    {
        launcher
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "Codex npm launcher has no package root.".to_string())?
            .to_path_buf()
    } else if matches!(host, HostTarget::WindowsArm64 | HostTarget::WindowsX64)
        && launcher
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| {
                name.eq_ignore_ascii_case("codex.cmd") || name.eq_ignore_ascii_case("codex.ps1")
            })
    {
        let shim_parent = launcher
            .parent()
            .ok_or_else(|| "Codex npm shim has no parent directory.".to_string())?;
        let node_modules = if shim_parent
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.eq_ignore_ascii_case(".bin"))
        {
            shim_parent
                .parent()
                .ok_or_else(|| "Codex local npm shim has no node_modules root.".to_string())?
                .to_path_buf()
        } else {
            shim_parent.join("node_modules")
        };
        node_modules.join("@openai/codex")
    } else {
        return Ok(None);
    };
    let metadata_path = package_root.join("package.json");
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(&metadata_path).map_err(|error| {
            format!(
                "Could not read Codex npm package metadata at {}: {error}",
                metadata_path.display()
            )
        })?)
        .map_err(|error| {
            format!(
                "Codex npm package metadata is malformed at {}: {error}",
                metadata_path.display()
            )
        })?;
    if metadata.get("name").and_then(serde_json::Value::as_str) != Some("@openai/codex") {
        return Err(format!(
            "Codex launcher is not inside the official @openai/codex package: {}",
            launcher.display()
        ));
    }
    let (platform_package, triple, executable) =
        official_codex_native_target(host).ok_or_else(|| {
            "Codex npm launcher is unsupported on this platform and architecture.".to_string()
        })?;
    let mut targets = Vec::new();
    for ancestor in package_root.ancestors() {
        let platform_root = ancestor.join("node_modules").join(platform_package);
        let platform_metadata = platform_root.join("package.json");
        if !platform_metadata.is_file() {
            continue;
        }
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&platform_metadata).map_err(|error| {
                format!(
                    "Could not read Codex platform package metadata at {}: {error}",
                    platform_metadata.display()
                )
            })?)
            .map_err(|error| {
                format!(
                    "Codex platform package metadata is malformed at {}: {error}",
                    platform_metadata.display()
                )
            })?;
        if !official_codex_platform_metadata_matches(&metadata, platform_package, host) {
            return Err(format!(
                "Codex native target is not inside the expected {platform_package} package: {}",
                platform_root.display()
            ));
        }
        targets.push((
            platform_root
                .join("vendor")
                .join(triple)
                .join("bin")
                .join(executable),
            platform_root,
        ));
        break;
    }
    targets.push((
        package_root
            .join("vendor")
            .join(triple)
            .join("bin")
            .join(executable),
        package_root.clone(),
    ));
    targets.push((
        package_root
            .join("vendor")
            .join(triple)
            .join("codex")
            .join(executable),
        package_root.clone(),
    ));
    for (path, trusted_root) in targets {
        if path.is_file() {
            let native = fs::canonicalize(&path).map_err(|error| {
                format!(
                    "Could not canonicalize official Codex native executable at {}: {error}",
                    path.display()
                )
            })?;
            let trusted_root = fs::canonicalize(&trusted_root).map_err(|error| {
                format!(
                    "Could not canonicalize Codex package root at {}: {error}",
                    trusted_root.display()
                )
            })?;
            if !native.starts_with(&trusted_root) {
                return Err(format!(
                    "Official Codex native executable escapes its package root: {}",
                    native.display()
                ));
            }
            return Ok(Some(native));
        }
    }
    Err(format!(
        "Official Codex npm package is missing its native executable for this platform: {}",
        package_root.display()
    ))
}

struct MacTrustInspection<'a> {
    codesign_status: i32,
    gatekeeper_status: i32,
    gatekeeper_raw: &'a str,
}

fn expected_macos_team(provider: Provider) -> Option<&'static str> {
    match provider {
        Provider::Codex => Some("2DC432GLL2"),
        Provider::Antigravity => Some("EQHXZ8M8AV"),
        Provider::Claude => None,
        Provider::Grok => Some("5Y6N3AJ54S"),
    }
}

fn assert_macos_provider_trust(
    provider: Provider,
    inspection: MacTrustInspection<'_>,
) -> Result<(), String> {
    let Some(_) = expected_macos_team(provider) else {
        return Ok(());
    };
    if inspection.codesign_status != 0 {
        return Err(format!(
            "{} executable failed its pinned macOS code-signature requirement.",
            provider.label()
        ));
    }
    let raw = inspection.gatekeeper_raw;
    let structured_pair = |key: &str, value: &str| {
        raw.split_once(&format!("<key>{key}</key>"))
            .is_some_and(|(_, suffix)| suffix.trim_start().starts_with(value))
    };
    let accepted =
        inspection.gatekeeper_status == 0 && structured_pair("assessment:verdict", "<true/>");
    // spctl reports signed standalone CLI binaries as error -67002 because
    // they are valid code but not application bundles. Only the structured
    // raw assessment may grant this narrow exception; stderr echoes the path.
    let valid_standalone_cli = inspection.gatekeeper_status != 0
        && structured_pair("assessment:verdict", "<false/>")
        && structured_pair("assessment:cserror", "<integer>-67002</integer>");
    if !accepted && !valid_standalone_cli {
        return Err(format!(
            "{} executable was rejected by macOS Gatekeeper.",
            provider.label()
        ));
    }
    Ok(())
}

fn trust_command_output(program: &str, args: &[&OsStr]) -> Result<Output, String> {
    let mut command = Command::new(program);
    command.args(args);
    version_probe_output(&mut command, PROVIDER_VERSION_PROBE_TIMEOUT)
        .map_err(|error| format!("Provider trust inspection failed: {}", error.message()))
}

fn verify_macos_provider_trust(provider: Provider, path: &Path) -> Result<(), String> {
    if !HostTarget::current().is_macos() || expected_macos_team(provider).is_none() {
        return Ok(());
    }
    let path_text = path.to_str().ok_or_else(|| {
        format!(
            "{} executable path is not valid UTF-8 for macOS trust inspection.",
            provider.label()
        )
    })?;
    if path_text.chars().any(char::is_control) {
        return Err(format!(
            "{} executable path contains unsafe control characters.",
            provider.label()
        ));
    }
    let expected_team = expected_macos_team(provider).expect("checked provider team");
    let requirement =
        format!("=anchor apple generic and certificate leaf[subject.OU] = \"{expected_team}\"");
    let path_os = path.as_os_str();
    let verify = trust_command_output(
        "/usr/bin/codesign",
        &[
            OsStr::new("--verify"),
            OsStr::new("--strict"),
            OsStr::new("--verbose=2"),
            OsStr::new("-R"),
            OsStr::new(&requirement),
            path_os,
        ],
    )?;
    let gatekeeper = trust_command_output(
        "/usr/sbin/spctl",
        &[
            OsStr::new("--assess"),
            OsStr::new("--type"),
            OsStr::new("execute"),
            OsStr::new("--verbose=4"),
            OsStr::new("--raw"),
            path_os,
        ],
    )?;
    let gatekeeper_raw = String::from_utf8_lossy(&gatekeeper.stdout);
    assert_macos_provider_trust(
        provider,
        MacTrustInspection {
            codesign_status: verify.status.code().unwrap_or(-1),
            gatekeeper_status: gatekeeper.status.code().unwrap_or(-1),
            gatekeeper_raw: &gatekeeper_raw,
        },
    )
}

#[cfg(test)]
fn prepare_provider_candidate_with<Trust>(
    provider: Provider,
    candidate: PathBuf,
    host: HostTarget,
    trust: &mut Trust,
) -> Result<PreparedProviderCandidate, String>
where
    Trust: FnMut(Provider, &Path) -> Result<(), String>,
{
    prepare_provider_candidate_with_options(provider, candidate, host, false, trust)
}

fn prepare_provider_candidate_with_options<Trust>(
    provider: Provider,
    candidate: PathBuf,
    host: HostTarget,
    allow_test_scripts: bool,
    trust: &mut Trust,
) -> Result<PreparedProviderCandidate, String>
where
    Trust: FnMut(Provider, &Path) -> Result<(), String>,
{
    let candidate = fs::canonicalize(&candidate).map_err(|error| {
        format!(
            "Could not canonicalize provider candidate at {}: {error}",
            candidate.display()
        )
    })?;
    let path = if provider == Provider::Codex {
        official_codex_native_from_launcher(&candidate, host)?.unwrap_or(candidate)
    } else {
        candidate
    };
    if !allow_test_scripts
        && matches!(
            provider,
            Provider::Codex | Provider::Antigravity | Provider::Grok
        )
    {
        let mut prefix = [0_u8; 2];
        let mut file = fs::File::open(&path)
            .map_err(|error| format!("Could not read provider at {}: {error}", path.display()))?;
        let prefix_len = file
            .read(&mut prefix)
            .map_err(|error| format!("Could not read provider at {}: {error}", path.display()))?;
        let scripted_extension =
            path.extension()
                .and_then(OsStr::to_str)
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "js" | "cmd" | "bat" | "ps1"
                    )
                });
        if (prefix_len == 2 && prefix == *b"#!") || scripted_extension {
            return Err(format!(
                "{} candidate is an unsupported script or shell shim and will not be executed: {}",
                provider.label(),
                path.display()
            ));
        }
    }
    let identity = VerifiedFileIdentity::capture(&path)?;
    if host.is_macos() && expected_macos_team(provider).is_some() {
        trust(provider, &path)?;
    }
    if VerifiedFileIdentity::capture(&path)? != identity {
        return Err(format!(
            "{} executable changed during trust verification: {}",
            provider.label(),
            path.display()
        ));
    }
    Ok(PreparedProviderCandidate { path, identity })
}

fn revalidate_resolved_provider_with<'a, Trust>(
    resolved: &'a ResolvedProviderExecutable,
    trust: &mut Trust,
) -> Result<&'a str, String>
where
    Trust: FnMut(Provider, &Path) -> Result<(), String>,
{
    ensure_provider_launch_allowed(resolved.provider)?;
    let path = Path::new(&resolved.path);
    if VerifiedFileIdentity::capture(path)? != resolved.identity {
        return Err(format!(
            "{} executable changed after verification: {}",
            resolved.provider.label(),
            path.display()
        ));
    }
    if HostTarget::current().is_macos() && expected_macos_team(resolved.provider).is_some() {
        trust(resolved.provider, path)?;
    }
    if VerifiedFileIdentity::capture(path)? != resolved.identity {
        return Err(format!(
            "{} executable changed during launch revalidation: {}",
            resolved.provider.label(),
            path.display()
        ));
    }
    Ok(&resolved.path)
}

fn version_line(output: &std::process::Output) -> Option<String> {
    [&output.stdout, &output.stderr]
        .into_iter()
        .flat_map(|bytes| {
            String::from_utf8_lossy(bytes)
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .map(|line| line.trim().to_string())
        .find(|line| !line.is_empty())
}

fn capture_probe_stream<R: Read + Send + 'static>(
    mut stream: R,
    sink: Arc<Mutex<Vec<u8>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if stream.read_to_end(&mut bytes).is_ok() {
            if let Ok(mut output) = sink.lock() {
                *output = bytes;
            }
        }
    })
}

enum VersionProbeError {
    TimedOut(String),
    Other(String),
}

impl VersionProbeError {
    fn message(&self) -> &str {
        match self {
            Self::TimedOut(message) | Self::Other(message) => message,
        }
    }
}

fn version_probe_output(
    command: &mut Command,
    timeout: Duration,
) -> Result<Output, VersionProbeError> {
    let launch_gate = configure_ai_process_group(command).map_err(VersionProbeError::Other)?;
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            VersionProbeError::Other(format!("Provider version check could not launch: {error}"))
        })?;
    let mut process_tree =
        track_ai_process_tree(&mut child, launch_gate).map_err(VersionProbeError::Other)?;
    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let mut readers = Vec::new();
    if let Some(stream) = child.stdout.take() {
        readers.push(capture_probe_stream(stream, Arc::clone(&stdout)));
    }
    if let Some(stream) = child.stderr.take() {
        readers.push(capture_probe_stream(stream, Arc::clone(&stderr)));
    }

    enum ProbeOutcome {
        Completed(std::process::ExitStatus, Result<(), String>),
        TimedOut(Result<std::process::ExitStatus, String>),
        PollFailed(std::io::Error, Result<std::process::ExitStatus, String>),
    }

    let deadline = Instant::now() + timeout;
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break ProbeOutcome::Completed(
                    status,
                    cleanup_ai_process_tree_after_bridge_exit(&mut process_tree),
                );
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(VERSION_PROBE_POLL_INTERVAL),
            Ok(None) => {
                break ProbeOutcome::TimedOut(terminate_ai_process_tree(
                    &mut process_tree,
                    &mut child,
                ));
            }
            Err(error) => {
                break ProbeOutcome::PollFailed(
                    error,
                    terminate_ai_process_tree(&mut process_tree, &mut child),
                );
            }
        }
    };

    let reader_cleanup = join_output_readers_bounded(readers, OUTPUT_READER_JOIN_TIMEOUT);
    let status = match outcome {
        ProbeOutcome::Completed(status, cleanup) => {
            cleanup.map_err(VersionProbeError::Other)?;
            reader_cleanup.map_err(VersionProbeError::Other)?;
            status
        }
        ProbeOutcome::TimedOut(cleanup) => {
            let mut message = format!("version check timed out after {} ms", timeout.as_millis());
            if let Err(error) = cleanup {
                message.push_str(&format!(". Process-tree cleanup failed: {error}"));
            }
            if let Err(error) = reader_cleanup {
                message.push_str(&format!(". Output cleanup failed: {error}"));
            }
            return Err(VersionProbeError::TimedOut(message));
        }
        ProbeOutcome::PollFailed(error, cleanup) => {
            let mut message = match cleanup {
                Ok(_) => format!("Provider version check could not be polled: {error}"),
                Err(cleanup_error) => format!(
                    "Provider version check could not be polled: {error}. Cleanup also failed: {cleanup_error}"
                ),
            };
            if let Err(error) = reader_cleanup {
                message.push_str(&format!(". Output cleanup failed: {error}"));
            }
            return Err(VersionProbeError::Other(message));
        }
    };
    let stdout = stdout.lock().map(|bytes| bytes.clone()).map_err(|_| {
        VersionProbeError::Other("Provider version stdout capture is unavailable.".into())
    })?;
    let stderr = stderr.lock().map(|bytes| bytes.clone()).map_err(|_| {
        VersionProbeError::Other("Provider version stderr capture is unavailable.".into())
    })?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn resolve_candidates(
    provider: Provider,
    candidates: Vec<PathBuf>,
    path_env: Option<&OsStr>,
    rejected: &ResolutionCache,
) -> Result<ResolvedProviderExecutable, String> {
    resolve_candidates_with_policy(
        provider,
        candidates,
        path_env,
        rejected,
        PROVIDER_VERSION_PROBE_TIMEOUT,
        HostTarget::current(),
        false,
        &mut verify_macos_provider_trust,
    )
}

#[cfg(test)]
fn resolve_candidates_with_timeout(
    provider: Provider,
    candidates: Vec<PathBuf>,
    path_env: Option<&OsStr>,
    rejected: &ResolutionCache,
    timeout: Duration,
) -> Result<ResolvedProviderExecutable, String> {
    resolve_candidates_with_policy(
        provider,
        candidates,
        path_env,
        rejected,
        timeout,
        HostTarget::LinuxX64,
        true,
        &mut |_, _| Ok(()),
    )
}

#[allow(clippy::too_many_arguments)]
fn resolve_candidates_with_policy<Trust>(
    provider: Provider,
    candidates: Vec<PathBuf>,
    path_env: Option<&OsStr>,
    rejected: &ResolutionCache,
    timeout: Duration,
    host: HostTarget,
    allow_test_scripts: bool,
    trust: &mut Trust,
) -> Result<ResolvedProviderExecutable, String>
where
    Trust: FnMut(Provider, &Path) -> Result<(), String>,
{
    let mut seen = HashSet::new();
    let mut failures = Vec::new();

    for candidate in candidates {
        let Some(candidate_path) = resolve_path_candidate(&candidate, path_env, host) else {
            failures.push(format!("{} was not found", candidate.display()));
            continue;
        };
        let prepared = match prepare_provider_candidate_with_options(
            provider,
            candidate_path,
            host,
            allow_test_scripts,
            trust,
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        let path = prepared.path;
        if !seen.insert(path.clone()) {
            continue;
        }
        let generation = match rejected.begin_probe(&path)? {
            ProbeClaim::Owner(generation) => generation,
            ProbeClaim::Rejected(reason) => {
                failures.push(reason);
                continue;
            }
        };

        let mut command = Command::new(&path);
        apply_ai_cli_environment(&mut command).arg("--version");
        if provider == Provider::Codex {
            command
                .env_remove("OPENAI_API_KEY")
                .env_remove("CODEX_API_KEY");
        }
        match version_probe_output(&mut command, timeout) {
            Ok(output) if output.status.success() => {
                if let Some(version) = version_line(&output) {
                    let current_identity = match VerifiedFileIdentity::capture(&path) {
                        Ok(identity) => identity,
                        Err(error) => {
                            rejected.reject(path.clone(), generation, error.clone())?;
                            failures.push(error);
                            continue;
                        }
                    };
                    if current_identity != prepared.identity {
                        let reason = format!(
                            "{} executable changed during its version check: {}",
                            provider.label(),
                            path.display()
                        );
                        rejected.reject(path.clone(), generation, reason.clone())?;
                        failures.push(reason);
                        continue;
                    }
                    rejected.accept(&path, generation)?;
                    return Ok(ResolvedProviderExecutable {
                        provider,
                        path: path.to_string_lossy().into_owned(),
                        version,
                        identity: current_identity,
                    });
                }
                let reason = format!("{} returned no version", path.display());
                rejected.reject(path.clone(), generation, reason.clone())?;
                failures.push(reason);
            }
            Ok(output) => {
                let reason = format!("{} exited with {}", path.display(), output.status);
                rejected.reject(path.clone(), generation, reason.clone())?;
                failures.push(reason);
            }
            Err(error) => {
                let reason = format!("{} {}", path.display(), error.message());
                match error {
                    VersionProbeError::TimedOut(_) => {
                        rejected.reject_transient(&path, generation, reason.clone())?;
                    }
                    VersionProbeError::Other(_) => {
                        rejected.reject(path.clone(), generation, reason.clone())?;
                    }
                }
                failures.push(reason);
            }
        }
    }

    let detail = failures
        .last()
        .map(|failure| format!(" Last check: {failure}."))
        .unwrap_or_default();
    Err(format!(
        "{} CLI was not found or did not pass its version check. Install {}, or enter the full path to `{}`.{detail}",
        provider.label(),
        provider.label(),
        provider.command_name()
    ))
}

fn configured_path(value: Option<String>) -> Option<PathBuf> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn provider_e2e_preflighted_resolution(
    provider: Provider,
    path_value: Option<OsString>,
    version_value: Option<OsString>,
    marker_value: Option<OsString>,
) -> Result<ResolvedProviderExecutable, String> {
    if marker_value.as_deref() != Some(OsStr::new(QA_PREFLIGHT_MARKER)) {
        return Err(format!(
            "Provider E2E requires the successful repo provider doctor marker in {QA_PREFLIGHT_ENV}."
        ));
    }
    let path = path_value
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            format!(
                "Provider E2E requires an absolute path in {}.",
                provider.qa_path_env()
            )
        })?;
    if !path.is_absolute() {
        return Err(format!(
            "Provider E2E path in {} must be absolute.",
            provider.qa_path_env()
        ));
    }
    let path = fs::canonicalize(&path).map_err(|error| {
        format!(
            "Provider E2E path in {} is unavailable: {error}",
            provider.qa_path_env()
        )
    })?;
    if !path.is_file() {
        return Err(format!(
            "Provider E2E path in {} must identify a file.",
            provider.qa_path_env()
        ));
    }
    let version = version_value
        .and_then(|value| value.into_string().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 256
                && !value.chars().any(|character| character.is_control())
        })
        .ok_or_else(|| {
            format!(
                "Provider E2E requires preflighted version metadata in {}.",
                provider.qa_version_env()
            )
        })?;

    Ok(ResolvedProviderExecutable {
        provider,
        path: path.to_string_lossy().into_owned(),
        version,
        identity: VerifiedFileIdentity::capture(&path)?,
    })
}

pub(crate) fn resolve_provider_executable(
    provider: Provider,
    configured: Option<String>,
    managed: Option<PathBuf>,
) -> Result<ResolvedProviderExecutable, String> {
    let qa_mode = std::env::var(QA_MODE_ENV).unwrap_or_default();
    if qa_mode == "provider-e2e" {
        return provider_e2e_preflighted_resolution(
            provider,
            std::env::var_os(provider.qa_path_env()),
            std::env::var_os(provider.qa_version_env()),
            std::env::var_os(QA_PREFLIGHT_ENV),
        );
    }
    let candidates = match qa_mode.as_str() {
        "provider-free" => {
            return Err(format!(
                "{} launch is disabled in provider-free native QA mode.",
                provider.label()
            ));
        }
        "" => candidate_paths(
            provider,
            configured_path(configured),
            managed,
            (provider == Provider::Codex)
                .then(sdk_bundled_codex_launcher)
                .flatten(),
            std::env::var_os("HOME").as_deref().map(Path::new),
            HostPlatform::current(),
        ),
        other => return Err(format!("Unsupported {QA_MODE_ENV} value `{other}`.")),
    };

    resolve_candidates(
        provider,
        candidates,
        std::env::var_os("PATH").as_deref(),
        rejection_cache(),
    )
}

pub(crate) fn resolve_exact_provider_executable(
    provider: Provider,
    path: PathBuf,
) -> Result<ResolvedProviderExecutable, String> {
    let qa_mode = std::env::var(QA_MODE_ENV).unwrap_or_default();
    if !qa_mode.is_empty() {
        return Err(format!(
            "Exact managed {} resolution is unavailable in {QA_MODE_ENV} mode `{qa_mode}`.",
            provider.label()
        ));
    }
    resolve_candidates(
        provider,
        vec![path],
        std::env::var_os("PATH").as_deref(),
        rejection_cache(),
    )
}

pub(crate) fn ensure_provider_launch_allowed(provider: Provider) -> Result<(), String> {
    ensure_provider_launch_allowed_in_mode(
        provider,
        &std::env::var(QA_MODE_ENV).unwrap_or_default(),
    )
}

pub(crate) fn ensure_provider_launch_allowed_in_mode(
    provider: Provider,
    qa_mode: &str,
) -> Result<(), String> {
    match qa_mode {
        "" | "provider-e2e" => Ok(()),
        "provider-free" => Err(format!(
            "{} launch is disabled in provider-free native QA mode.",
            provider.label()
        )),
        other => Err(format!("Unsupported {QA_MODE_ENV} value `{other}`.")),
    }
}

#[tauri::command]
pub(crate) fn provider_qa_mode() -> Option<String> {
    match std::env::var(QA_MODE_ENV).as_deref() {
        Ok("provider-free") => Some("provider-free".into()),
        Ok("provider-e2e") => Some("provider-e2e".into()),
        _ => None,
    }
}

fn provider_free_study_profile_in_mode(
    qa_mode: &str,
    raw_profile: Option<&std::ffi::OsStr>,
) -> Result<Option<[u8; 16]>, String> {
    let Some(raw_profile) = raw_profile else {
        return Ok(None);
    };
    if qa_mode != "provider-free" {
        return Err("Study profile isolation is available only in Provider Free mode.".into());
    }
    let raw_profile = raw_profile.to_str().ok_or_else(|| {
        "Provider Free study profile must contain exactly 32 hexadecimal characters.".to_string()
    })?;
    if raw_profile.len() != 32 || !raw_profile.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(
            "Provider Free study profile must contain exactly 32 hexadecimal characters.".into(),
        );
    }
    let mut profile = [0_u8; 16];
    for (index, byte) in profile.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&raw_profile[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Provider Free study profile contains invalid hexadecimal data.")?;
    }
    Ok(Some(profile))
}

pub(crate) fn provider_free_study_profile() -> Result<Option<[u8; 16]>, String> {
    provider_free_study_profile_in_mode(
        &std::env::var(QA_MODE_ENV).unwrap_or_default(),
        std::env::var_os(PROVIDER_FREE_STUDY_PROFILE_ENV).as_deref(),
    )
}

pub(crate) struct StudyEvidenceRequest {
    pub profile: [u8; 16],
    nonce: [u8; 32],
    build_identity: Option<[u8; 32]>,
    path: std::path::PathBuf,
    release_path: Option<std::path::PathBuf>,
}

impl StudyEvidenceRequest {
    pub(crate) fn wait_for_parent_release(&self) -> Result<(), String> {
        use sha2::Digest;
        let path = self
            .release_path
            .as_ref()
            .ok_or_else(|| "Provider Free lifecycle parent release path is missing.".to_string())?;
        let expected = format!("{:x}", sha2::Sha256::digest(self.nonce));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match std::fs::read_to_string(path) {
                Ok(value) if value.trim() == expected => return Ok(()),
                Ok(_) => return Err("Provider Free lifecycle release evidence is invalid.".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Could not read Provider Free lifecycle release: {error}"
                    ));
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err("Provider Free lifecycle dynamic-code verification timed out.".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

fn parse_study_hex<const N: usize>(raw: &std::ffi::OsStr, label: &str) -> Result<[u8; N], String> {
    let raw = raw.to_str().ok_or_else(|| {
        format!(
            "{label} must contain exactly {} hexadecimal characters.",
            N * 2
        )
    })?;
    if raw.len() != N * 2 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "{label} must contain exactly {} hexadecimal characters.",
            N * 2
        ));
    }
    let mut bytes = [0_u8; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&raw[index * 2..index * 2 + 2], 16)
            .map_err(|_| format!("{label} contains invalid hexadecimal data."))?;
    }
    Ok(bytes)
}

fn study_evidence_request_in_mode(
    qa_mode: &str,
    raw_profile: Option<&std::ffi::OsStr>,
    raw_nonce: Option<&std::ffi::OsStr>,
    raw_path: Option<&std::ffi::OsStr>,
    raw_build_identity: Option<&std::ffi::OsStr>,
    raw_cleanup_release_path: Option<&std::ffi::OsStr>,
    profile_only_is_resume: bool,
) -> Result<Option<StudyEvidenceRequest>, String> {
    // The study profile is also present for same-session resume launches. Only
    // the dedicated nonce/path pair opts a launch into one-shot lifecycle
    // evidence creation.
    if raw_profile.is_none()
        && raw_nonce.is_none()
        && raw_path.is_none()
        && raw_build_identity.is_none()
        && raw_cleanup_release_path.is_none()
    {
        return Ok(None);
    }
    if profile_only_is_resume
        && raw_profile.is_some()
        && raw_nonce.is_none()
        && raw_path.is_none()
        && raw_build_identity.is_none()
        && raw_cleanup_release_path.is_none()
    {
        return Ok(None);
    }
    if qa_mode != "provider-free" {
        return Err("Study lifecycle evidence is available only in Provider Free mode.".into());
    }
    let raw_profile = raw_profile
        .ok_or_else(|| "Provider Free study lifecycle profile is missing.".to_string())?;
    let raw_nonce =
        raw_nonce.ok_or_else(|| "Provider Free study lifecycle nonce is missing.".to_string())?;
    let path = raw_path
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            "Provider Free study lifecycle evidence path must be absolute.".to_string()
        })?;
    let build_identity = if profile_only_is_resume {
        Some(parse_study_hex::<32>(
            raw_build_identity.ok_or_else(|| {
                "Provider Free study build identity is missing from boot evidence.".to_string()
            })?,
            "Provider Free study build identity",
        )?)
    } else if raw_build_identity.is_some() {
        return Err("Provider Free cleanup must not carry fresh boot build identity.".into());
    } else {
        None
    };
    let release_path = Some(
        raw_cleanup_release_path
            .map(std::path::PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| "Provider Free lifecycle release path must be absolute.".to_string())?,
    );
    Ok(Some(StudyEvidenceRequest {
        profile: parse_study_hex::<16>(raw_profile, "Provider Free study profile")?,
        nonce: parse_study_hex::<32>(raw_nonce, "Provider Free study lifecycle nonce")?,
        build_identity,
        path,
        release_path,
    }))
}

fn study_evidence_request(
    profile_env: &str,
    nonce_env: &str,
    path_env: &str,
    build_identity_env: Option<&str>,
    cleanup_release_env: Option<&str>,
    profile_only_is_resume: bool,
) -> Result<Option<StudyEvidenceRequest>, String> {
    let raw_profile = std::env::var_os(profile_env);
    let raw_nonce = std::env::var_os(nonce_env);
    let raw_path = std::env::var_os(path_env);
    let raw_build_identity = build_identity_env.and_then(std::env::var_os);
    let raw_cleanup_release_path = cleanup_release_env.and_then(std::env::var_os);
    study_evidence_request_in_mode(
        &std::env::var(QA_MODE_ENV).unwrap_or_default(),
        raw_profile.as_deref(),
        raw_nonce.as_deref(),
        raw_path.as_deref(),
        raw_build_identity.as_deref(),
        raw_cleanup_release_path.as_deref(),
        profile_only_is_resume,
    )
}

pub(crate) fn provider_free_study_boot_evidence() -> Result<Option<StudyEvidenceRequest>, String> {
    study_evidence_request(
        PROVIDER_FREE_STUDY_PROFILE_ENV,
        PROVIDER_FREE_STUDY_BOOT_NONCE_ENV,
        PROVIDER_FREE_STUDY_BOOT_EVIDENCE_ENV,
        Some(PROVIDER_FREE_STUDY_BUILD_IDENTITY_ENV),
        Some(PROVIDER_FREE_STUDY_BOOT_RELEASE_ENV),
        true,
    )
}

pub(crate) fn provider_free_study_cleanup() -> Result<Option<StudyEvidenceRequest>, String> {
    study_evidence_request(
        PROVIDER_FREE_STUDY_CLEANUP_PROFILE_ENV,
        PROVIDER_FREE_STUDY_CLEANUP_NONCE_ENV,
        PROVIDER_FREE_STUDY_CLEANUP_EVIDENCE_ENV,
        None,
        Some(PROVIDER_FREE_STUDY_CLEANUP_RELEASE_ENV),
        false,
    )
}

pub(crate) fn write_study_lifecycle_evidence(
    request: &StudyEvidenceRequest,
    event: &str,
) -> Result<(), String> {
    use sha2::Digest;
    let profile_sha256 = format!("{:x}", sha2::Sha256::digest(request.profile));
    let nonce_sha256 = format!("{:x}", sha2::Sha256::digest(request.nonce));
    let nonce_key = if event == "app-boot" {
        "bootNonceSha256"
    } else {
        "cleanupNonceSha256"
    };
    let mut payload = serde_json::Map::from_iter([
        ("version".into(), serde_json::json!(3)),
        ("event".into(), serde_json::json!(event)),
        ("profileSha256".into(), serde_json::json!(profile_sha256)),
    ]);
    payload.insert(nonce_key.into(), serde_json::json!(nonce_sha256));
    if let Some(build_identity) = request.build_identity {
        let build_identity = build_identity
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        payload.insert(
            "buildIdentitySha256".into(),
            serde_json::json!(build_identity),
        );
    }
    let payload = serde_json::Value::Object(payload);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&request.path)
        .map_err(|error| format!("Could not create Provider Free lifecycle evidence: {error}"))?;
    std::io::Write::write_all(&mut file, format!("{payload}\n").as_bytes())
        .map_err(|error| format!("Could not write Provider Free lifecycle evidence: {error}"))
}

fn provider_free_qa_png_in_mode(
    qa_mode: &str,
    width: u32,
    height: u32,
    variant: u8,
) -> Result<Vec<u8>, String> {
    if qa_mode != "provider-free" {
        return Err("QA Fake output is available only in provider-free native QA mode.".into());
    }
    if !matches!((width, height), (1024, 1024) | (1024, 1280) | (1280, 720)) {
        return Err("QA Fake supports only Campaign Composer 1:1, 4:5, and 16:9 outputs.".into());
    }
    if variant > 4 {
        return Err("QA Fake fixture variant must be between 0 and 4.".into());
    }
    let (dark, light, green_start, blue_start) = match variant {
        0 => (38, 69, 60, 70),
        1 => (151, 210, 48, 74),
        2 => (27, 64, 108, 78),
        3 => (91, 148, 47, 112),
        4 => (142, 202, 94, 38),
        _ => unreachable!("variant is bounded above"),
    };
    let grid_size = 128 - u32::from(variant) * 12;
    let image = image::RgbaImage::from_fn(width, height, |x, y| {
        let grid = ((x / grid_size) + (y / grid_size) + u32::from(variant)) % 2;
        let red = if grid == 0 { dark } else { light };
        let green =
            (((x * 120) / width.saturating_sub(1).max(1)) as u8).saturating_add(green_start);
        let blue = (((y * 110) / height.saturating_sub(1).max(1)) as u8).saturating_add(blue_start);
        image::Rgba([red, green, blue, 255])
    });
    crate::png::encode_rgba_png(image, "provider-free QA Campaign")
}

#[tauri::command]
pub(crate) fn provider_free_qa_png(
    width: u32,
    height: u32,
    variant: u8,
) -> Result<Vec<u8>, String> {
    provider_free_qa_png_in_mode(
        &std::env::var(QA_MODE_ENV).unwrap_or_default(),
        width,
        height,
        variant,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::ai::TempJobDir;
    use sha2::Digest;
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn provider_free_study_profile_is_exact_and_mode_gated() {
        let raw = std::ffi::OsStr::new("00112233445566778899aabbccddeeff");
        assert_eq!(
            provider_free_study_profile_in_mode("provider-free", Some(raw))
                .expect("valid Provider Free study profile"),
            Some([
                0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
                0xee, 0xff,
            ])
        );
        assert_eq!(
            provider_free_study_profile_in_mode("provider-free", None)
                .expect("ordinary Provider Free has no study profile"),
            None
        );
        assert!(
            provider_free_study_profile_in_mode("provider-e2e", Some(raw))
                .expect_err("Provider E2E cannot use study isolation")
                .contains("Provider Free")
        );
        assert!(provider_free_study_profile_in_mode(
            "provider-free",
            Some(std::ffi::OsStr::new("not-a-profile"))
        )
        .expect_err("malformed study profile must fail closed")
        .contains("32 hexadecimal"));
    }

    #[test]
    fn study_lifecycle_evidence_is_optional_for_same_session_resume() {
        let profile = std::ffi::OsStr::new("00112233445566778899aabbccddeeff");
        assert!(study_evidence_request_in_mode(
            "provider-free",
            Some(profile),
            None,
            None,
            None,
            None,
            true
        )
        .expect("resume launch does not request new boot evidence")
        .is_none());

        let nonce_text = "11".repeat(32);
        let nonce = std::ffi::OsStr::new(&nonce_text);
        let partial_error = match study_evidence_request_in_mode(
            "provider-free",
            Some(profile),
            Some(nonce),
            None,
            None,
            None,
            true,
        ) {
            Err(error) => error,
            Ok(_) => panic!("partial lifecycle request must fail closed"),
        };
        assert!(partial_error.contains("path must be absolute"));

        let path = std::ffi::OsStr::new("/tmp/paintnode-study-boot-evidence.json");
        let build_identity_text = "22".repeat(32);
        let build_identity = std::ffi::OsStr::new(&build_identity_text);
        let release = std::ffi::OsStr::new("/tmp/paintnode-study-boot-release");
        let request = study_evidence_request_in_mode(
            "provider-free",
            Some(profile),
            Some(nonce),
            Some(path),
            Some(build_identity),
            Some(release),
            true,
        )
        .expect("fresh launch lifecycle request")
        .expect("fresh launch has lifecycle evidence");
        assert_eq!(request.path, std::path::PathBuf::from(path));

        assert!(study_evidence_request_in_mode(
            "provider-free",
            Some(profile),
            None,
            None,
            None,
            None,
            false,
        )
        .is_err());
    }

    #[test]
    fn study_lifecycle_evidence_contains_only_fingerprints_and_is_single_create() {
        let root = std::env::temp_dir().join(format!(
            "paintnode-study-evidence-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create evidence fixture");
        let request = StudyEvidenceRequest {
            profile: [1; 16],
            nonce: [2; 32],
            build_identity: Some([3; 32]),
            path: root.join("boot.json"),
            release_path: None,
        };
        write_study_lifecycle_evidence(&request, "app-boot").expect("write boot evidence");
        let evidence: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&request.path).expect("read boot evidence"))
                .expect("parse boot evidence");
        assert_eq!(evidence["version"], 3);
        assert_eq!(evidence["event"], "app-boot");
        assert!(evidence["profileSha256"]
            .as_str()
            .is_some_and(|value| value.len() == 64));
        assert!(evidence["bootNonceSha256"]
            .as_str()
            .is_some_and(|value| value.len() == 64));
        assert_eq!(evidence["buildIdentitySha256"], "03".repeat(32));
        assert!(!evidence.to_string().contains(&"01".repeat(16)));
        assert!(write_study_lifecycle_evidence(&request, "app-boot")
            .expect_err("evidence must be create-once")
            .contains("Could not create"));
        std::fs::remove_dir_all(root).expect("remove evidence fixture");
    }

    #[test]
    fn study_lifecycle_waits_for_the_parent_dynamic_code_release() {
        use sha2::Digest;
        let root = std::env::temp_dir().join(format!(
            "paintnode-study-cleanup-release-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create release fixture");
        let release_path = root.join("release");
        let request = StudyEvidenceRequest {
            profile: [1; 16],
            nonce: [7; 32],
            build_identity: None,
            path: root.join("cleanup.json"),
            release_path: Some(release_path.clone()),
        };
        std::fs::write(
            &release_path,
            format!("{:x}\n", sha2::Sha256::digest(request.nonce)),
        )
        .expect("write trusted parent release");
        request
            .wait_for_parent_release()
            .expect("matching release permits cleanup");
        std::fs::write(&release_path, "forged\n").expect("write forged release");
        assert!(request.wait_for_parent_release().is_err());
        std::fs::remove_dir_all(root).expect("remove release fixture");
    }

    #[test]
    fn provider_free_qa_campaign_shapes_are_exact_deterministic_pngs_and_mode_gated() {
        for dimensions in [(1024, 1024), (1024, 1280), (1280, 720)] {
            let first =
                provider_free_qa_png_in_mode("provider-free", dimensions.0, dimensions.1, 0)
                    .expect("provider-free QA PNG");
            let second =
                provider_free_qa_png_in_mode("provider-free", dimensions.0, dimensions.1, 0)
                    .expect("deterministic provider-free QA PNG");
            assert_eq!(first, second);
            assert_eq!(
                crate::png::png_dimensions_from_bytes(&first),
                Some(dimensions)
            );
            assert!(crate::png::decode_png_rgba(&first, "provider-free QA Campaign").is_ok());
        }
        let candidate_one = provider_free_qa_png_in_mode("provider-free", 1024, 1024, 1)
            .expect("candidate one fixture");
        let candidate_one_retry = provider_free_qa_png_in_mode("provider-free", 1024, 1024, 1)
            .expect("candidate one retry fixture");
        let candidate_two = provider_free_qa_png_in_mode("provider-free", 1024, 1024, 2)
            .expect("candidate two fixture");
        assert_eq!(candidate_one, candidate_one_retry);
        assert_ne!(candidate_one, candidate_two);
        assert_ne!(
            sha2::Sha256::digest(&candidate_one),
            sha2::Sha256::digest(&candidate_two)
        );

        assert!(provider_free_qa_png_in_mode("provider-free", 640, 640, 0)
            .expect_err("unsupported shape must be rejected")
            .contains("1:1, 4:5, and 16:9"));

        assert!(provider_free_qa_png_in_mode("provider-free", 1024, 1024, 9)
            .expect_err("unsupported variant must be rejected")
            .contains("variant"));

        for mode in ["", "provider-e2e", "unexpected"] {
            assert!(provider_free_qa_png_in_mode(mode, 1024, 1024, 0)
                .expect_err("non-provider-free modes must be rejected")
                .contains("only in provider-free"));
        }
    }
    #[cfg(unix)]
    fn executable(path: &std::path::Path, body: &str) {
        fs::write(path, format!("#!/bin/sh\n{body}\n")).expect("write fake provider");
        let mut permissions = fs::metadata(path)
            .expect("fake provider metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("make fake provider executable");
    }

    fn resolve_test_candidates(
        provider: Provider,
        candidates: Vec<PathBuf>,
        rejected: &ResolutionCache,
    ) -> Result<ResolvedProviderExecutable, String> {
        resolve_candidates_with_policy(
            provider,
            candidates,
            None,
            rejected,
            PROVIDER_VERSION_PROBE_TIMEOUT,
            HostTarget::LinuxX64,
            true,
            &mut |_, _| Ok(()),
        )
    }

    #[test]
    fn apple_silicon_prefers_configured_managed_and_sdk_before_homebrew() {
        let paths = candidate_paths(
            Provider::Codex,
            Some("/configured/codex".into()),
            Some("/managed/codex".into()),
            Some("/sdk/codex.js".into()),
            Some(std::path::Path::new("/Users/test")),
            HostPlatform::MacOsArm64,
        );

        assert_eq!(
            paths,
            [
                "/configured/codex",
                "/managed/codex",
                "/sdk/codex.js",
                "/opt/homebrew/bin/codex",
                "/usr/local/bin/codex",
                "codex",
            ]
            .map(std::path::PathBuf::from)
        );
    }

    #[test]
    fn intel_macos_prefers_intel_homebrew_before_arm_compatibility_path() {
        let paths = candidate_paths(
            Provider::Codex,
            None,
            None,
            None,
            Some(std::path::Path::new("/Users/test")),
            HostPlatform::MacOsX64,
        );

        assert_eq!(
            paths,
            ["/usr/local/bin/codex", "/opt/homebrew/bin/codex", "codex",]
                .map(std::path::PathBuf::from)
        );
    }

    #[test]
    fn grok_discovery_includes_vendor_and_user_install_locations() {
        let paths = candidate_paths(
            Provider::Grok,
            None,
            None,
            None,
            Some(std::path::Path::new("/Users/test")),
            HostPlatform::MacOsArm64,
        );

        assert_eq!(
            paths,
            [
                "/Users/test/.local/bin/grok",
                "/Users/test/.grok/bin/grok",
                "/opt/homebrew/bin/grok",
                "/usr/local/bin/grok",
                "grok",
            ]
            .map(std::path::PathBuf::from)
        );
    }

    #[test]
    fn official_codex_native_targets_match_supported_platform_packages() {
        assert_eq!(
            official_codex_native_target(HostTarget::MacOsArm64),
            Some((
                "@openai/codex-darwin-arm64",
                "aarch64-apple-darwin",
                "codex"
            ))
        );
        assert_eq!(
            official_codex_native_target(HostTarget::MacOsX64),
            Some(("@openai/codex-darwin-x64", "x86_64-apple-darwin", "codex"))
        );
        assert_eq!(
            official_codex_native_target(HostTarget::LinuxArm64),
            Some((
                "@openai/codex-linux-arm64",
                "aarch64-unknown-linux-musl",
                "codex"
            ))
        );
        assert_eq!(
            official_codex_native_target(HostTarget::LinuxX64),
            Some((
                "@openai/codex-linux-x64",
                "x86_64-unknown-linux-musl",
                "codex"
            ))
        );
        assert_eq!(
            official_codex_native_target(HostTarget::WindowsArm64),
            Some((
                "@openai/codex-win32-arm64",
                "aarch64-pc-windows-msvc",
                "codex.exe"
            ))
        );
        assert_eq!(
            official_codex_native_target(HostTarget::WindowsX64),
            Some((
                "@openai/codex-win32-x64",
                "x86_64-pc-windows-msvc",
                "codex.exe"
            ))
        );
        assert_eq!(official_codex_native_target(HostTarget::Unsupported), None);
    }

    #[test]
    #[cfg(unix)]
    fn official_codex_npm_launcher_is_unwrapped_without_executing_the_wrapper() {
        let dir = TempJobDir::new("paintnode-codex-wrapper-test").expect("temp dir");
        let package = dir.path().join("lib/node_modules/@openai/codex");
        let wrapper = package.join("bin/codex.js");
        let native = package
            .join("node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex");
        fs::create_dir_all(wrapper.parent().expect("wrapper parent")).expect("wrapper dir");
        fs::create_dir_all(native.parent().expect("native parent")).expect("native dir");
        fs::write(
            package.join("package.json"),
            r#"{"name":"@openai/codex","version":"9.8.7"}"#,
        )
        .expect("package metadata");
        fs::write(
            package.join("node_modules/@openai/codex-darwin-arm64/package.json"),
            r#"{"name":"@openai/codex-darwin-arm64","version":"9.8.7"}"#,
        )
        .expect("platform package metadata");
        let sentinel = dir.path().join("wrapper-executed");
        executable(&wrapper, &format!("touch '{}'", sentinel.display()));
        executable(&native, "echo codex-cli 9.8.7");
        let mut trusted = None;

        let prepared = prepare_provider_candidate_with_options(
            Provider::Codex,
            wrapper,
            HostTarget::MacOsArm64,
            true,
            &mut |provider, path| {
                trusted = Some((provider, path.to_path_buf()));
                Ok(())
            },
        )
        .expect("official wrapper");

        assert_eq!(
            prepared.path,
            fs::canonicalize(&native).expect("native path")
        );
        assert_eq!(trusted, Some((Provider::Codex, prepared.path.clone())));
        assert!(!sentinel.exists(), "the npm launcher must never execute");
    }

    #[test]
    #[cfg(unix)]
    fn malformed_missing_and_unsupported_codex_launchers_fail_before_execution() {
        let dir = TempJobDir::new("paintnode-codex-wrapper-reject-test").expect("temp dir");
        let package = dir.path().join("lib/node_modules/@openai/codex");
        let wrapper = package.join("bin/codex.js");
        fs::create_dir_all(wrapper.parent().expect("wrapper parent")).expect("wrapper dir");
        let sentinel = dir.path().join("wrapper-executed");
        executable(&wrapper, &format!("touch '{}'", sentinel.display()));

        for (metadata, host, expected) in [
            ("not-json", HostTarget::MacOsArm64, "metadata"),
            (
                r#"{"name":"not-codex"}"#,
                HostTarget::MacOsArm64,
                "official",
            ),
            (
                r#"{"name":"@openai/codex"}"#,
                HostTarget::MacOsArm64,
                "native",
            ),
            (
                r#"{"name":"@openai/codex"}"#,
                HostTarget::Unsupported,
                "platform",
            ),
        ] {
            fs::write(package.join("package.json"), metadata).expect("package metadata");
            let error = prepare_provider_candidate_with(
                Provider::Codex,
                wrapper.clone(),
                host,
                &mut |_, _| panic!("rejected wrapper must not reach trust inspection"),
            )
            .expect_err("invalid launcher must fail closed");
            assert!(error.to_ascii_lowercase().contains(expected), "{error}");
        }
        assert!(
            !sentinel.exists(),
            "a rejected npm launcher must never execute"
        );
    }

    #[test]
    #[cfg(unix)]
    fn official_codex_launcher_resolves_a_hoisted_platform_dependency() {
        let dir = TempJobDir::new("paintnode-codex-hoisted-wrapper-test").expect("temp dir");
        let modules = dir.path().join("node_modules/@openai");
        let package = modules.join("codex");
        let platform = modules.join("codex-darwin-arm64");
        let wrapper = package.join("bin/codex.js");
        let native = platform.join("vendor/aarch64-apple-darwin/bin/codex");
        fs::create_dir_all(wrapper.parent().expect("wrapper parent")).expect("wrapper dir");
        fs::create_dir_all(native.parent().expect("native parent")).expect("native dir");
        fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#)
            .expect("package metadata");
        fs::write(
            platform.join("package.json"),
            r#"{"name":"@openai/codex","version":"1.2.3-linux-x64","os":["linux"],"cpu":["x64"]}"#,
        )
        .expect("platform metadata");
        executable(&wrapper, "exit 99");
        executable(&native, "echo codex-cli 1.2.3");

        let error = prepare_provider_candidate_with_options(
            Provider::Codex,
            wrapper.clone(),
            HostTarget::MacOsArm64,
            true,
            &mut |_, _| panic!("wrong-platform package must not reach trust inspection"),
        )
        .expect_err("wrong-platform package metadata");
        assert!(error.contains("expected"), "{error}");
        fs::write(
            platform.join("package.json"),
            r#"{"name":"@openai/codex","version":"1.2.3-darwin-arm64","os":["darwin"],"cpu":["arm64"]}"#,
        )
        .expect("correct platform metadata");

        let prepared = prepare_provider_candidate_with_options(
            Provider::Codex,
            wrapper,
            HostTarget::MacOsArm64,
            true,
            &mut |_, _| Ok(()),
        )
        .expect("hoisted native target");
        assert_eq!(
            prepared.path,
            fs::canonicalize(native).expect("native path")
        );
    }

    #[test]
    #[cfg(unix)]
    fn windows_pathext_finds_and_unwraps_official_npm_shims_without_execution() {
        let dir = TempJobDir::new("paintnode-codex-windows-shim-test").expect("temp dir");
        let modules = dir.path().join("node_modules");
        let shim = modules.join(".bin/codex.cmd");
        let package = modules.join("@openai/codex");
        let platform = modules.join("@openai/codex-win32-x64");
        let native = platform.join("vendor/x86_64-pc-windows-msvc/bin/codex.exe");
        let sentinel = dir.path().join("shim-executed");
        fs::create_dir_all(shim.parent().expect("shim parent")).expect("shim dir");
        fs::create_dir_all(package.join("bin")).expect("package dir");
        fs::create_dir_all(native.parent().expect("native parent")).expect("native dir");
        executable(&shim, &format!("touch '{}'", sentinel.display()));
        executable(&native, "echo codex-cli 1.2.3");
        fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#)
            .expect("package metadata");
        fs::write(
            platform.join("package.json"),
            r#"{"name":"@openai/codex","os":["win32"],"cpu":["x64"]}"#,
        )
        .expect("platform metadata");

        let discovered = resolve_path_candidate_for_host(
            Path::new("codex"),
            Some(modules.join(".bin").as_os_str()),
            Some(OsStr::new(".EXE;.CMD;.PS1")),
            HostTarget::WindowsX64,
        )
        .expect("PATHEXT shim");
        assert_eq!(discovered, fs::canonicalize(&shim).expect("canonical shim"));
        let prepared = prepare_provider_candidate_with_options(
            Provider::Codex,
            discovered,
            HostTarget::WindowsX64,
            true,
            &mut |_, _| Ok(()),
        )
        .expect("official Windows npm shim");
        assert_eq!(prepared.path, fs::canonicalize(&native).expect("native"));
        assert!(!sentinel.exists(), "npm shim must never execute");
    }

    #[test]
    #[cfg(unix)]
    fn windows_global_prefix_cmd_and_ps1_shims_unwrap_without_execution() {
        let dir = TempJobDir::new("paintnode-codex-windows-global-test").expect("temp dir");
        let prefix = dir.path().join("npm");
        let modules = prefix.join("node_modules");
        let package = modules.join("@openai/codex");
        let platform = modules.join("@openai/codex-win32-x64");
        let native = platform.join("vendor/x86_64-pc-windows-msvc/bin/codex.exe");
        fs::create_dir_all(package.join("bin")).expect("package dir");
        fs::create_dir_all(native.parent().expect("native parent")).expect("native dir");
        executable(&native, "echo codex-cli 1.2.3");
        fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#)
            .expect("package metadata");
        fs::write(
            platform.join("package.json"),
            r#"{"name":"@openai/codex","os":["win32"],"cpu":["x64"]}"#,
        )
        .expect("platform metadata");

        let cmd = prefix.join("codex.cmd");
        let ps1 = prefix.join("codex.ps1");
        let cmd_sentinel = dir.path().join("cmd-executed");
        let ps1_sentinel = dir.path().join("ps1-executed");
        executable(&cmd, &format!("touch '{}'", cmd_sentinel.display()));
        executable(&ps1, &format!("touch '{}'", ps1_sentinel.display()));

        let discovered = resolve_path_candidate_for_host(
            Path::new("codex"),
            Some(prefix.as_os_str()),
            Some(OsStr::new(".eXe;.CmD;.Ps1")),
            HostTarget::WindowsX64,
        )
        .expect("mixed-case PATHEXT global shim");
        assert_eq!(discovered, fs::canonicalize(&cmd).expect("canonical cmd"));
        for shim in [discovered, fs::canonicalize(&ps1).expect("canonical ps1")] {
            let prepared = prepare_provider_candidate_with_options(
                Provider::Codex,
                shim,
                HostTarget::WindowsX64,
                true,
                &mut |_, _| Ok(()),
            )
            .expect("official global npm shim");
            assert_eq!(prepared.path, fs::canonicalize(&native).expect("native"));
        }
        assert!(!cmd_sentinel.exists(), "global cmd shim must never execute");
        assert!(!ps1_sentinel.exists(), "global ps1 shim must never execute");
    }

    #[test]
    #[cfg(unix)]
    fn windows_global_prefix_lookalike_shims_fail_closed_without_execution() {
        let dir = TempJobDir::new("paintnode-codex-windows-lookalike-test").expect("temp dir");
        let prefix = dir.path().join("npm");
        let package = prefix.join("node_modules/@openai/codex");
        fs::create_dir_all(&package).expect("lookalike package dir");
        fs::write(
            package.join("package.json"),
            r#"{"name":"not-openai-codex"}"#,
        )
        .expect("lookalike metadata");

        for extension in ["cmd", "ps1"] {
            let shim = prefix.join(format!("codex.{extension}"));
            let sentinel = dir.path().join(format!("{extension}-executed"));
            executable(&shim, &format!("touch '{}'", sentinel.display()));
            let error = prepare_provider_candidate_with_options(
                Provider::Codex,
                shim,
                HostTarget::WindowsX64,
                true,
                &mut |_, _| panic!("lookalike shim must not reach trust inspection"),
            )
            .expect_err("lookalike global shim");
            assert!(error.contains("official @openai/codex"), "{error}");
            assert!(!sentinel.exists(), "lookalike shim must never execute");
        }
    }

    #[test]
    #[cfg(unix)]
    fn mac_provider_trust_rejection_precedes_any_candidate_execution() {
        let dir = TempJobDir::new("paintnode-provider-trust-reject-test").expect("temp dir");
        let codex = dir.path().join("codex");
        let sentinel = dir.path().join("executed");
        executable(
            &codex,
            &format!("touch '{}'; echo codex-cli 1.0.0", sentinel.display()),
        );

        let error = prepare_provider_candidate_with_options(
            Provider::Codex,
            codex,
            HostTarget::MacOsArm64,
            true,
            &mut |_, _| Err("revoked vendor identity".into()),
        )
        .expect_err("revoked candidate");

        assert!(error.contains("revoked"));
        assert!(
            !sentinel.exists(),
            "trust rejection must happen before launch"
        );
    }

    #[test]
    #[cfg(unix)]
    fn direct_vendor_provider_shell_shims_are_never_executed() {
        let dir = TempJobDir::new("paintnode-provider-shell-shim-test").expect("temp dir");
        for provider in [Provider::Codex, Provider::Antigravity, Provider::Grok] {
            let shim = dir.path().join(provider.command_name());
            let sentinel = dir
                .path()
                .join(format!("{}-executed", provider.command_name()));
            executable(&shim, &format!("touch '{}'", sentinel.display()));
            let error = prepare_provider_candidate_with(
                provider,
                shim,
                HostTarget::LinuxX64,
                &mut |_, _| Ok(()),
            )
            .expect_err("shell shim must fail closed");
            assert!(error.contains("script or shell shim"), "{error}");
            assert!(!sentinel.exists(), "a shell shim must never execute");
        }
    }

    #[test]
    fn mac_provider_trust_parser_uses_only_structured_gatekeeper_output() {
        let cli_gatekeeper = r#"<plist><dict><key>assessment:cserror</key><integer>-67002</integer><key>assessment:verdict</key><false/></dict></plist>"#;
        let accepted_gatekeeper =
            r#"<plist><dict><key>assessment:verdict</key><true/></dict></plist>"#;
        assert!(assert_macos_provider_trust(
            Provider::Codex,
            MacTrustInspection {
                codesign_status: 0,
                gatekeeper_status: 1,
                gatekeeper_raw: cli_gatekeeper,
            },
        )
        .is_ok());
        assert!(assert_macos_provider_trust(
            Provider::Antigravity,
            MacTrustInspection {
                codesign_status: 0,
                gatekeeper_status: 0,
                gatekeeper_raw: accepted_gatekeeper,
            },
        )
        .is_ok());
        for inspection in [
            MacTrustInspection {
                codesign_status: 1,
                gatekeeper_status: 1,
                gatekeeper_raw: cli_gatekeeper,
            },
            MacTrustInspection {
                codesign_status: 0,
                gatekeeper_status: 1,
                gatekeeper_raw: r#"<plist><dict><key>assessment:cserror</key><integer>-67030</integer><key>assessment:verdict</key><false/></dict></plist>"#,
            },
            MacTrustInspection {
                codesign_status: 0,
                gatekeeper_status: 1,
                gatekeeper_raw: "injected/path: the code is valid but does not seem to be an app",
            },
        ] {
            assert!(assert_macos_provider_trust(Provider::Codex, inspection).is_err());
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn newline_path_cannot_inject_vendor_identity_or_gatekeeper_acceptance() {
        let dir = TempJobDir::new("paintnode-provider-newline-trust-test").expect("temp dir");
        for (provider, command, team) in [
            (Provider::Codex, "codex", "2DC432GLL2"),
            (Provider::Antigravity, "agy", "EQHXZ8M8AV"),
            (Provider::Grok, "grok", "5Y6N3AJ54S"),
        ] {
            let injected = dir.path().join(format!(
                "{command}\nTeamIdentifier={team}\nthe code is valid but does not seem to be an app"
            ));
            fs::copy("/usr/bin/true", &injected).expect("copy Mach-O fixture");
            let status = Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-"])
                .arg(&injected)
                .status()
                .expect("ad-hoc sign fixture");
            assert!(status.success(), "fixture must be ad-hoc signed");

            let error = verify_macos_provider_trust(provider, &injected)
                .expect_err("unsafe path must fail before trust commands");
            assert!(error.contains("unsafe control characters"), "{error}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn resolved_identity_swap_is_rejected_before_invocation() {
        let dir = TempJobDir::new("paintnode-provider-identity-swap-test").expect("temp dir");
        let provider = dir.path().join("agy");
        executable(&provider, "echo 1.0.0");
        let prepared = prepare_provider_candidate_with_options(
            Provider::Antigravity,
            provider.clone(),
            HostTarget::MacOsArm64,
            true,
            &mut |_, _| Ok(()),
        )
        .expect("trusted provider");
        let resolved = ResolvedProviderExecutable {
            provider: Provider::Antigravity,
            path: prepared.path.to_string_lossy().into_owned(),
            version: "1.0.0".into(),
            identity: prepared.identity,
        };
        fs::remove_file(&provider).expect("remove old provider");
        executable(&provider, "echo 2.0.0");

        let error = revalidate_resolved_provider_with(&resolved, &mut |_, _| Ok(()))
            .expect_err("identity swap must fail closed");
        assert!(error.contains("changed after verification"), "{error}");
    }

    #[test]
    #[cfg(unix)]
    fn resolved_symlink_retarget_cannot_redirect_provider_invocation() {
        let dir = TempJobDir::new("paintnode-provider-symlink-swap-test").expect("temp dir");
        let first = dir.path().join("agy-first");
        let second = dir.path().join("agy-second");
        let alias = dir.path().join("agy");
        executable(&first, "echo 1.0.0");
        executable(&second, "echo 2.0.0");
        symlink(&first, &alias).expect("provider alias");
        let prepared = prepare_provider_candidate_with_options(
            Provider::Antigravity,
            alias.clone(),
            HostTarget::MacOsArm64,
            true,
            &mut |_, _| Ok(()),
        )
        .expect("trusted provider");
        let resolved = ResolvedProviderExecutable {
            provider: Provider::Antigravity,
            path: prepared.path.to_string_lossy().into_owned(),
            version: "1.0.0".into(),
            identity: prepared.identity,
        };
        fs::remove_file(&alias).expect("remove old alias");
        symlink(&second, &alias).expect("retarget provider alias");

        assert_eq!(
            revalidate_resolved_provider_with(&resolved, &mut |_, _| Ok(()))
                .expect("canonical provider remains trusted"),
            fs::canonicalize(&first)
                .expect("first provider")
                .to_string_lossy()
        );
        assert_ne!(
            resolved.path,
            fs::canonicalize(&alias)
                .expect("new alias target")
                .to_string_lossy()
        );
    }

    #[test]
    #[cfg(unix)]
    fn canonical_aliases_are_probed_only_once() {
        let dir = TempJobDir::new("paintnode-provider-alias-test").expect("temp dir");
        let real = dir.path().join("codex-real");
        let alias = dir.path().join("codex-alias");
        let count = dir.path().join("count");
        executable(
            &real,
            &format!("echo run >> '{}'; echo codex-cli 1.0.0", count.display()),
        );
        symlink(&real, &alias).expect("alias");

        let resolution = resolve_test_candidates(
            Provider::Codex,
            vec![alias, real],
            &ResolutionCache::default(),
        )
        .expect("provider resolution");

        assert_eq!(resolution.version, "codex-cli 1.0.0");
        assert_eq!(
            fs::read_to_string(count)
                .expect("probe count")
                .lines()
                .count(),
            1
        );
    }

    #[test]
    #[cfg(unix)]
    fn non_zero_candidates_are_rejected_and_unchanged_failures_are_not_retried() {
        let dir = TempJobDir::new("paintnode-provider-rejection-test").expect("temp dir");
        let failed = dir.path().join("failed-codex");
        let valid = dir.path().join("valid-codex");
        let failed_count = dir.path().join("failed-count");
        executable(
            &failed,
            &format!(
                "echo failed >> '{}'; echo stale >&2; exit 23",
                failed_count.display()
            ),
        );
        executable(&valid, "echo codex-cli 2.0.0");
        let rejected = ResolutionCache::default();

        let first = resolve_test_candidates(
            Provider::Codex,
            vec![failed.clone(), valid.clone()],
            &rejected,
        )
        .expect("fallback provider");
        let second = resolve_test_candidates(Provider::Codex, vec![failed, valid], &rejected)
            .expect("cached fallback provider");

        assert_eq!(first.version, "codex-cli 2.0.0");
        assert_eq!(second.version, "codex-cli 2.0.0");
        assert_eq!(
            fs::read_to_string(failed_count)
                .expect("failed probe count")
                .lines()
                .count(),
            1
        );
    }

    #[test]
    #[cfg(unix)]
    fn rejected_cache_retries_a_replaced_same_size_same_mtime_file_identity() {
        let dir = TempJobDir::new("paintnode-provider-cache-identity-test").expect("temp dir");
        let provider = dir.path().join("codex");
        executable(&provider, "echo codex-cli 0.0.0; exit 1");
        let original_modified = fs::metadata(&provider)
            .expect("provider metadata")
            .modified()
            .expect("provider modified time");
        let original_len = fs::metadata(&provider).expect("provider metadata").len();
        let cache = ResolutionCache::default();
        resolve_test_candidates(Provider::Codex, vec![provider.clone()], &cache)
            .expect_err("first identity is rejected");

        fs::remove_file(&provider).expect("remove rejected identity");
        executable(&provider, "echo codex-cli 9.9.9; exit 0");
        assert_eq!(
            fs::metadata(&provider).expect("replacement metadata").len(),
            original_len
        );
        fs::File::open(&provider)
            .expect("replacement provider")
            .set_times(std::fs::FileTimes::new().set_modified(original_modified))
            .expect("restore modified time");

        let resolved = resolve_test_candidates(Provider::Codex, vec![provider], &cache)
            .expect("new file identity retries");
        assert_eq!(resolved.version, "codex-cli 9.9.9");
    }

    #[test]
    #[cfg(unix)]
    fn parallel_detection_waits_for_the_same_candidate_instead_of_bypassing_it() {
        let dir = TempJobDir::new("paintnode-provider-parallel-test").expect("temp dir");
        let failed = dir.path().join("failed-codex");
        let valid = dir.path().join("valid-codex");
        let failed_count = dir.path().join("failed-count");
        executable(
            &failed,
            &format!(
                "echo failed >> '{}'; sleep 1; exit 23",
                failed_count.display()
            ),
        );
        executable(&valid, "echo codex-cli 3.0.0");
        let cache = std::sync::Arc::new(ResolutionCache::default());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));

        let handles = (0..2)
            .map(|_| {
                let failed = failed.clone();
                let valid = valid.clone();
                let cache = std::sync::Arc::clone(&cache);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    resolve_test_candidates(Provider::Codex, vec![failed, valid], &cache)
                        .expect("parallel provider resolution")
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();

        for handle in handles {
            assert_eq!(
                handle.join().expect("detection thread").version,
                "codex-cli 3.0.0"
            );
        }
        assert_eq!(
            fs::read_to_string(failed_count)
                .expect("failed probe count")
                .lines()
                .count(),
            1
        );
    }

    #[test]
    #[cfg(unix)]
    fn hung_version_probe_times_out_reaps_its_process_tree_and_allows_retry() {
        let dir = TempJobDir::new("paintnode-provider-timeout-test").expect("temp dir");
        let provider = dir.path().join("codex");
        let direct_pid = dir.path().join("direct.pid");
        let descendant_pid = dir.path().join("descendant.pid");
        let first_attempt = dir.path().join("first-attempt");
        executable(
            &provider,
            &format!(
                "if [ ! -f '{}' ]; then touch '{}'; echo $$ > '{}'; sleep 30 & echo $! > '{}'; wait; else echo codex-cli 4.0.0; fi",
                first_attempt.display(),
                first_attempt.display(),
                direct_pid.display(),
                descendant_pid.display()
            ),
        );
        let cache = ResolutionCache::default();

        let error = resolve_candidates_with_timeout(
            Provider::Codex,
            vec![provider.clone()],
            None,
            &cache,
            std::time::Duration::from_secs(2),
        )
        .expect_err("hung version probe must fail closed");

        assert!(error.contains("timed out after 2000 ms"), "{error}");
        for pid_file in [&direct_pid, &descendant_pid] {
            let pid = fs::read_to_string(pid_file)
                .expect("hung fixture pid")
                .trim()
                .parse::<i32>()
                .expect("numeric hung fixture pid");
            assert_ne!(
                unsafe { libc::kill(pid, 0) },
                0,
                "timed-out provider process survived: {pid}"
            );
        }

        let retried = resolve_candidates_with_timeout(
            Provider::Codex,
            vec![provider],
            None,
            &cache,
            std::time::Duration::from_secs(2),
        )
        .expect("fixed provider retries after timeout");
        assert_eq!(retried.version, "codex-cli 4.0.0");
    }

    #[test]
    #[cfg(unix)]
    fn concurrent_waiters_share_one_hung_probe_and_receive_the_same_timeout() {
        let dir = TempJobDir::new("paintnode-provider-timeout-waiters-test").expect("temp dir");
        let provider = dir.path().join("codex");
        let probe_count = dir.path().join("probe-count");
        executable(
            &provider,
            &format!("echo probe >> '{}'; sleep 30", probe_count.display()),
        );
        let cache = std::sync::Arc::new(ResolutionCache::default());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));

        let handles = (0..3)
            .map(|_| {
                let provider = provider.clone();
                let cache = std::sync::Arc::clone(&cache);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    resolve_candidates_with_timeout(
                        Provider::Codex,
                        vec![provider],
                        None,
                        &cache,
                        std::time::Duration::from_secs(2),
                    )
                    .expect_err("hung provider must fail every waiter")
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();

        let errors = handles
            .into_iter()
            .map(|handle| handle.join().expect("resolver waiter"))
            .collect::<Vec<_>>();
        assert!(
            errors.windows(2).all(|pair| pair[0] == pair[1]),
            "{errors:?}"
        );
        assert!(
            errors[0].contains("timed out after 2000 ms"),
            "{}",
            errors[0]
        );
        assert_eq!(
            fs::read_to_string(probe_count)
                .expect("probe count")
                .lines()
                .count(),
            1,
            "concurrent waiters must not launch duplicate probes"
        );
    }

    #[test]
    #[cfg(unix)]
    fn provider_e2e_accepts_preflighted_metadata_without_executing_the_provider() {
        let dir = TempJobDir::new("paintnode-provider-preflight-metadata-test").expect("temp dir");
        let provider = dir.path().join("codex");
        let sentinel = dir.path().join("executed");
        executable(
            &provider,
            &format!("touch '{}'; echo should-not-run", sentinel.display()),
        );

        let resolved = provider_e2e_preflighted_resolution(
            Provider::Codex,
            Some(provider.into_os_string()),
            Some(OsString::from("codex-cli 9.8.7")),
            Some(OsString::from("provider-doctor-v1")),
        )
        .expect("preflighted provider metadata");

        assert_eq!(resolved.version, "codex-cli 9.8.7");
        assert!(
            !sentinel.exists(),
            "Rust metadata validation must not execute the provider"
        );
    }

    #[test]
    fn provider_e2e_metadata_fails_closed_without_marker_absolute_path_or_version() {
        for (path, version, marker) in [
            (
                Some(OsString::from("/trusted/codex")),
                Some(OsString::from("codex-cli 1.0.0")),
                None,
            ),
            (
                Some(OsString::from("codex")),
                Some(OsString::from("codex-cli 1.0.0")),
                Some(OsString::from("provider-doctor-v1")),
            ),
            (
                Some(OsString::from("/trusted/codex")),
                Some(OsString::from("  ")),
                Some(OsString::from("provider-doctor-v1")),
            ),
        ] {
            assert!(
                provider_e2e_preflighted_resolution(Provider::Codex, path, version, marker)
                    .is_err()
            );
        }
    }

    #[test]
    #[ignore = "explicit no-cost provider-doctor metadata handoff; run through npm run qa:native:provider-e2e"]
    fn explicit_provider_e2e_accepts_provider_doctor_handoff() {
        assert_eq!(std::env::var(QA_MODE_ENV).as_deref(), Ok("provider-e2e"));

        for provider in [Provider::Codex, Provider::Antigravity, Provider::Grok] {
            let resolved = resolve_provider_executable(provider, None, None)
                .unwrap_or_else(|error| panic!("{} detection failed: {error}", provider.label()));
            eprintln!(
                "{} accepted from provider doctor at {} ({})",
                provider.label(),
                resolved.path,
                resolved.version
            );
        }
    }

    #[test]
    #[ignore = "explicit no-generation normal-mode trust probe; set PAINTNODE_TEST_CODEX_BIN, PAINTNODE_TEST_ANTIGRAVITY_BIN, and PAINTNODE_TEST_GROK_BIN"]
    fn explicit_normal_mode_unwraps_and_revalidates_vendor_providers() {
        assert!(std::env::var(QA_MODE_ENV).unwrap_or_default().is_empty());
        for (provider, variable) in [
            (Provider::Codex, "PAINTNODE_TEST_CODEX_BIN"),
            (Provider::Antigravity, "PAINTNODE_TEST_ANTIGRAVITY_BIN"),
            (Provider::Grok, "PAINTNODE_TEST_GROK_BIN"),
        ] {
            let configured = std::env::var(variable)
                .unwrap_or_else(|_| panic!("{variable} is required for the explicit trust probe"));
            let resolved = resolve_provider_executable(provider, Some(configured), None)
                .unwrap_or_else(|error| panic!("{} trust probe failed: {error}", provider.label()));
            resolved.revalidate_for_launch().unwrap_or_else(|error| {
                panic!("{} revalidation failed: {error}", provider.label())
            });
            assert!(!resolved.path.ends_with("/bin/codex.js"));
            eprintln!(
                "{} trusted at {} ({})",
                provider.label(),
                resolved.path,
                resolved.version
            );
        }
    }
}
