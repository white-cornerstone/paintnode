use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::SystemTime;

use crate::ai::apply_ai_cli_environment;

const QA_MODE_ENV: &str = "PAINTNODE_PROVIDER_QA_MODE";
const QA_PREFLIGHT_ENV: &str = "PAINTNODE_PROVIDER_QA_PREFLIGHT";
const QA_PREFLIGHT_MARKER: &str = "provider-doctor-v1";

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
    fingerprints: HashMap<PathBuf, Option<FileFingerprint>>,
    in_flight: HashSet<PathBuf>,
}

impl RejectionCache {
    fn fingerprint(path: &Path) -> Option<FileFingerprint> {
        let metadata = fs::metadata(path).ok()?;
        Some(FileFingerprint {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }

    fn is_unchanged_rejection(&self, path: &Path) -> bool {
        self.fingerprints
            .get(path)
            .is_some_and(|fingerprint| *fingerprint == Self::fingerprint(path))
    }

    fn reject(&mut self, path: PathBuf) {
        self.fingerprints
            .insert(path.clone(), Self::fingerprint(&path));
        self.in_flight.remove(&path);
    }

    fn accept(&mut self, path: &Path) {
        self.in_flight.remove(path);
        self.fingerprints.remove(path);
    }
}

#[derive(Default)]
struct ResolutionCache {
    state: Mutex<RejectionCache>,
    probe_finished: Condvar,
}

impl ResolutionCache {
    fn begin_probe(&self, path: &Path) -> Result<bool, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Provider executable rejection cache is unavailable.".to_string())?;
        loop {
            if state.is_unchanged_rejection(path) {
                return Ok(false);
            }
            if state.in_flight.insert(path.to_path_buf()) {
                return Ok(true);
            }
            state = self
                .probe_finished
                .wait(state)
                .map_err(|_| "Provider executable rejection cache is unavailable.".to_string())?;
        }
    }

    fn accept(&self, path: &Path) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "Provider executable rejection cache is unavailable.".to_string())?
            .accept(path);
        self.probe_finished.notify_all();
        Ok(())
    }

    fn reject(&self, path: PathBuf) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "Provider executable rejection cache is unavailable.".to_string())?
            .reject(path);
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

fn resolve_candidates(
    provider: Provider,
    candidates: Vec<PathBuf>,
    path_env: Option<&OsStr>,
    rejected: &ResolutionCache,
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
        let should_probe = rejected.begin_probe(&path)?;
        if !should_probe {
            failures.push(format!("{} remains rejected", path.display()));
            continue;
        }

        let mut command = Command::new(&path);
        apply_ai_cli_environment(&mut command).arg("--version");
        if provider == Provider::Codex {
            command
                .env_remove("OPENAI_API_KEY")
                .env_remove("CODEX_API_KEY");
        }
        match command.output() {
            Ok(output) if output.status.success() => {
                if let Some(version) = version_line(&output) {
                    rejected.accept(&path)?;
                    return Ok(ResolvedProviderExecutable {
                        path: path.to_string_lossy().into_owned(),
                        version,
                    });
                }
                rejected.reject(path.clone())?;
                failures.push(format!("{} returned no version", path.display()));
            }
            Ok(output) => {
                rejected.reject(path.clone())?;
                failures.push(format!("{} exited with {}", path.display(), output.status));
            }
            Err(error) => {
                rejected.reject(path.clone())?;
                failures.push(format!("{} could not launch: {error}", path.display()));
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

fn provider_free_qa_png_in_mode(qa_mode: &str, width: u32, height: u32) -> Result<Vec<u8>, String> {
    if qa_mode != "provider-free" {
        return Err("QA Fake output is available only in provider-free native QA mode.".into());
    }
    if !matches!((width, height), (1024, 1024) | (1024, 1280) | (1280, 720)) {
        return Err("QA Fake supports only Campaign Composer 1:1, 4:5, and 16:9 outputs.".into());
    }
    let image = image::RgbaImage::from_fn(width, height, |x, y| {
        let grid = ((x / 128) + (y / 128)) % 2;
        let red = if grid == 0 { 38 } else { 69 };
        let green = ((x * 160) / width.saturating_sub(1).max(1)) as u8 + 60;
        let blue = ((y * 150) / height.saturating_sub(1).max(1)) as u8 + 70;
        image::Rgba([red, green, blue, 255])
    });
    crate::png::encode_rgba_png(image, "provider-free QA Campaign")
}

#[tauri::command]
pub(crate) fn provider_free_qa_png(width: u32, height: u32) -> Result<Vec<u8>, String> {
    provider_free_qa_png_in_mode(
        &std::env::var(QA_MODE_ENV).unwrap_or_default(),
        width,
        height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::ai::TempJobDir;
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn provider_free_qa_campaign_shapes_are_exact_deterministic_pngs_and_mode_gated() {
        for dimensions in [(1024, 1024), (1024, 1280), (1280, 720)] {
            let first = provider_free_qa_png_in_mode("provider-free", dimensions.0, dimensions.1)
                .expect("provider-free QA PNG");
            let second = provider_free_qa_png_in_mode("provider-free", dimensions.0, dimensions.1)
                .expect("deterministic provider-free QA PNG");
            assert_eq!(first, second);
            assert_eq!(
                crate::png::png_dimensions_from_bytes(&first),
                Some(dimensions)
            );
            assert!(crate::png::decode_png_rgba(&first, "provider-free QA Campaign").is_ok());
        }
        assert!(provider_free_qa_png_in_mode("provider-free", 640, 640)
            .expect_err("unsupported shape must be rejected")
            .contains("1:1, 4:5, and 16:9"));

        for mode in ["", "provider-e2e", "unexpected"] {
            assert!(provider_free_qa_png_in_mode(mode, 1024, 1024)
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
