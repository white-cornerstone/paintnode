use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crate::ai::{
    apply_ai_cli_environment, cleanup_ai_process_tree_after_bridge_exit,
    configure_ai_process_group, join_output_readers_bounded, terminate_ai_process_tree,
    track_ai_process_tree, OUTPUT_READER_JOIN_TIMEOUT,
};

const QA_MODE_ENV: &str = "PAINTNODE_PROVIDER_QA_MODE";
const PROVIDER_FREE_STUDY_PROFILE_ENV: &str = "PAINTNODE_PROVIDER_FREE_STUDY_PROFILE";
const PROVIDER_FREE_STUDY_BOOT_NONCE_ENV: &str = "PAINTNODE_PROVIDER_FREE_STUDY_BOOT_NONCE";
const PROVIDER_FREE_STUDY_BOOT_EVIDENCE_ENV: &str = "PAINTNODE_PROVIDER_FREE_STUDY_BOOT_EVIDENCE";
const PROVIDER_FREE_STUDY_CLEANUP_PROFILE_ENV: &str =
    "PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_PROFILE";
const PROVIDER_FREE_STUDY_CLEANUP_NONCE_ENV: &str = "PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_NONCE";
const PROVIDER_FREE_STUDY_CLEANUP_EVIDENCE_ENV: &str =
    "PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_EVIDENCE";
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
}

impl Provider {
    fn command_name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Antigravity => "agy",
            Self::Claude => "claude",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Antigravity => "Antigravity",
            Self::Claude => "Claude",
        }
    }

    fn qa_path_env(self) -> &'static str {
        match self {
            Self::Codex => "PAINTNODE_QA_CODEX_BIN",
            Self::Antigravity => "PAINTNODE_QA_ANTIGRAVITY_BIN",
            Self::Claude => "PAINTNODE_QA_CLAUDE_BIN",
        }
    }

    fn qa_version_env(self) -> &'static str {
        match self {
            Self::Codex => "PAINTNODE_QA_CODEX_VERSION",
            Self::Antigravity => "PAINTNODE_QA_ANTIGRAVITY_VERSION",
            Self::Claude => "PAINTNODE_QA_CLAUDE_VERSION",
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedProviderExecutable {
    pub(crate) path: String,
    pub(crate) version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileFingerprint {
    len: u64,
    modified: Option<SystemTime>,
}

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
        let metadata = fs::metadata(path).ok()?;
        Some(FileFingerprint {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        })
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
    if provider == Provider::Antigravity {
        if let Some(home) = home {
            candidates.push(home.join(".local/bin/agy"));
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

fn resolve_path_candidate(candidate: &Path, path_env: Option<&OsStr>) -> Option<PathBuf> {
    let is_bare_name = candidate.components().count() == 1;
    let path = if is_bare_name {
        let search_path = path_env
            .map(OsString::from)
            .or_else(|| std::env::var_os("PATH"))?;
        std::env::split_paths(&search_path)
            .map(|directory| directory.join(candidate))
            .find(|path| path.is_file())?
    } else {
        candidate.to_path_buf()
    };
    fs::canonicalize(&path).ok().or(Some(path))
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
    resolve_candidates_with_timeout(
        provider,
        candidates,
        path_env,
        rejected,
        PROVIDER_VERSION_PROBE_TIMEOUT,
    )
}

fn resolve_candidates_with_timeout(
    provider: Provider,
    candidates: Vec<PathBuf>,
    path_env: Option<&OsStr>,
    rejected: &ResolutionCache,
    timeout: Duration,
) -> Result<ResolvedProviderExecutable, String> {
    let mut seen = HashSet::new();
    let mut failures = Vec::new();

    for candidate in candidates {
        let Some(path) = resolve_path_candidate(&candidate, path_env) else {
            failures.push(format!("{} was not found", candidate.display()));
            continue;
        };
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
                    rejected.accept(&path, generation)?;
                    return Ok(ResolvedProviderExecutable {
                        path: path.to_string_lossy().into_owned(),
                        version,
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
        path: path.to_string_lossy().into_owned(),
        version,
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
    path: std::path::PathBuf,
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

fn study_evidence_request(
    profile_env: &str,
    nonce_env: &str,
    path_env: &str,
) -> Result<Option<StudyEvidenceRequest>, String> {
    let Some(raw_profile) = std::env::var_os(profile_env) else {
        return Ok(None);
    };
    if std::env::var(QA_MODE_ENV).as_deref() != Ok("provider-free") {
        return Err("Study lifecycle evidence is available only in Provider Free mode.".into());
    }
    let raw_nonce = std::env::var_os(nonce_env)
        .ok_or_else(|| "Provider Free study lifecycle nonce is missing.".to_string())?;
    let path = std::env::var_os(path_env)
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            "Provider Free study lifecycle evidence path must be absolute.".to_string()
        })?;
    Ok(Some(StudyEvidenceRequest {
        profile: parse_study_hex::<16>(&raw_profile, "Provider Free study profile")?,
        nonce: parse_study_hex::<32>(&raw_nonce, "Provider Free study lifecycle nonce")?,
        path,
    }))
}

pub(crate) fn provider_free_study_boot_evidence() -> Result<Option<StudyEvidenceRequest>, String> {
    study_evidence_request(
        PROVIDER_FREE_STUDY_PROFILE_ENV,
        PROVIDER_FREE_STUDY_BOOT_NONCE_ENV,
        PROVIDER_FREE_STUDY_BOOT_EVIDENCE_ENV,
    )
}

pub(crate) fn provider_free_study_cleanup() -> Result<Option<StudyEvidenceRequest>, String> {
    study_evidence_request(
        PROVIDER_FREE_STUDY_CLEANUP_PROFILE_ENV,
        PROVIDER_FREE_STUDY_CLEANUP_NONCE_ENV,
        PROVIDER_FREE_STUDY_CLEANUP_EVIDENCE_ENV,
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
            path: root.join("boot.json"),
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
        assert!(!evidence.to_string().contains(&"01".repeat(16)));
        assert!(write_study_lifecycle_evidence(&request, "app-boot")
            .expect_err("evidence must be create-once")
            .contains("Could not create"));
        std::fs::remove_dir_all(root).expect("remove evidence fixture");
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

    #[test]
    fn apple_silicon_prefers_configured_then_managed_then_arm_homebrew() {
        let paths = candidate_paths(
            Provider::Codex,
            Some("/configured/codex".into()),
            Some("/managed/codex".into()),
            Some(std::path::Path::new("/Users/test")),
            HostPlatform::MacOsArm64,
        );

        assert_eq!(
            paths,
            [
                "/configured/codex",
                "/managed/codex",
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

        let resolution = resolve_candidates(
            Provider::Codex,
            vec![alias, real],
            None,
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

        let first = resolve_candidates(
            Provider::Codex,
            vec![failed.clone(), valid.clone()],
            None,
            &rejected,
        )
        .expect("fallback provider");
        let second = resolve_candidates(Provider::Codex, vec![failed, valid], None, &rejected)
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
                    resolve_candidates(Provider::Codex, vec![failed, valid], None, &cache)
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

        for provider in [Provider::Codex, Provider::Antigravity] {
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
}
