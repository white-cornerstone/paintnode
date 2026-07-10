//! Shared AI-job infrastructure: job dirs, process running, progress events, common types.

pub(crate) mod antigravity;
pub(crate) mod canvas;
pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod director;
pub(crate) mod fill_storyboard;
pub(crate) mod placement;
pub(crate) mod workflow_director;

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
#[cfg(any(windows, test))]
use std::io::Write;
#[cfg(any(windows, test))]
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::ExitStatus;
use std::process::Output;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;

use serde::Deserialize;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;

use crate::png::{file_has_png_signature, is_png, png_dimensions_from_bytes, PNG_SIGNATURE};
use crate::project::{
    default_documents_project_dir, ensure_project_dirs, safe_file_name, safe_stem, ProjectAssetView,
};

pub(crate) const AI_RUN_STOPPED_MESSAGE: &str = "The task was stopped.";

static CANCELLED_AI_RUNS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static PENDING_DIRECTOR_INPUTS: OnceLock<(Mutex<HashMap<String, PendingDirectorInput>>, Condvar)> =
    OnceLock::new();

const DIRECTOR_INPUT_EVENT: &str = "ai-director-input-required";

#[derive(Clone, Debug)]
struct DirectorInputResponse {
    answer: String,
    cancelled: bool,
}

#[derive(Debug)]
struct PendingDirectorInput {
    run_id: String,
    response: Option<DirectorInputResponse>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectorInputPayload {
    run_id: String,
    request_id: String,
    provider: String,
    question: String,
    options: Vec<String>,
    allow_custom: bool,
}

fn cancelled_ai_runs() -> &'static Mutex<HashSet<String>> {
    CANCELLED_AI_RUNS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn pending_director_inputs() -> &'static (Mutex<HashMap<String, PendingDirectorInput>>, Condvar) {
    PENDING_DIRECTOR_INPUTS.get_or_init(|| (Mutex::new(HashMap::new()), Condvar::new()))
}

/// Flag a running AI job for cancellation; its CLI process is killed at the
/// runner's next poll and the task fails with [`AI_RUN_STOPPED_MESSAGE`].
#[tauri::command]
pub(crate) async fn cancel_ai_run(run_id: String) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    if run_id.is_empty() {
        return Err("Missing run id.".into());
    }
    request_ai_run_cancel(&run_id)
}

pub(crate) fn request_ai_run_cancel(run_id: &str) -> Result<(), String> {
    cancelled_ai_runs()
        .lock()
        .map_err(|_| "Cancellation registry is unavailable.".to_string())?
        .insert(run_id.to_string());
    pending_director_inputs().1.notify_all();
    Ok(())
}

#[tauri::command]
pub(crate) async fn submit_ai_director_input(
    run_id: String,
    request_id: String,
    answer: String,
    cancelled: bool,
) -> Result<(), String> {
    let (inputs, ready) = pending_director_inputs();
    let mut inputs = inputs
        .lock()
        .map_err(|_| "AI Director input registry is unavailable.".to_string())?;
    let pending = inputs.get_mut(request_id.trim()).ok_or_else(|| {
        "This AI Director question is no longer waiting for an answer.".to_string()
    })?;
    if pending.run_id != run_id.trim() {
        return Err("AI Director question does not belong to this task.".into());
    }
    pending.response = Some(DirectorInputResponse { answer, cancelled });
    ready.notify_all();
    Ok(())
}

pub(crate) fn request_ai_director_input(
    app: &AppHandle,
    run_id: &str,
    provider_label: &str,
    turn: usize,
    question: &str,
    options: &[String],
    allow_custom: bool,
) -> Result<String, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("AI Director requested user input without a question.".into());
    }
    let options = options
        .iter()
        .map(|option| option.trim())
        .filter(|option| !option.is_empty())
        .take(4)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if options.is_empty() && !allow_custom {
        return Err(
            "AI Director question must provide an answer option or allow a custom answer.".into(),
        );
    }
    let request_id = format!("{run_id}-director-{turn}-{}", now_id());
    let payload = DirectorInputPayload {
        run_id: run_id.to_string(),
        request_id: request_id.clone(),
        provider: provider_label.to_string(),
        question: question.to_string(),
        options,
        allow_custom,
    };
    let (inputs, ready) = pending_director_inputs();
    inputs
        .lock()
        .map_err(|_| "AI Director input registry is unavailable.".to_string())?
        .insert(
            request_id.clone(),
            PendingDirectorInput {
                run_id: run_id.to_string(),
                response: None,
            },
        );
    if let Err(error) = app.emit(DIRECTOR_INPUT_EVENT, payload) {
        if let Ok(mut inputs) = inputs.lock() {
            inputs.remove(&request_id);
        }
        return Err(format!("Failed to request AI Director input: {error}"));
    }
    emit_provider_progress(
        app,
        run_id,
        "userInputRequired",
        provider_label,
        "AI Director is waiting for your answer",
        Some("requestUserInput"),
    );

    loop {
        if ai_run_cancelled(run_id) {
            if let Ok(mut inputs) = inputs.lock() {
                inputs.remove(&request_id);
            }
            clear_ai_run_cancelled(run_id);
            return Err(AI_RUN_STOPPED_MESSAGE.into());
        }
        let mut guard = inputs
            .lock()
            .map_err(|_| "AI Director input registry is unavailable.".to_string())?;
        if let Some(response) = guard
            .get(&request_id)
            .and_then(|pending| pending.response.clone())
        {
            guard.remove(&request_id);
            drop(guard);
            if response.cancelled {
                return Err(AI_RUN_STOPPED_MESSAGE.into());
            }
            let answer = response.answer.trim();
            if answer.is_empty() {
                return Err("The AI Director answer was empty.".into());
            }
            return Ok(answer.to_string());
        }
        let _ = ready
            .wait_timeout(guard, POLL_INTERVAL)
            .map_err(|_| "AI Director input registry is unavailable.".to_string())?;
    }
}

/// Commands clear any stale flag when they start so a retry with the same run
/// id is not stopped by the previous attempt's cancellation.
pub(crate) fn clear_ai_run_cancelled(run_id: &str) {
    if let Ok(mut runs) = cancelled_ai_runs().lock() {
        runs.remove(run_id);
    }
}

pub(crate) fn ai_run_cancelled(run_id: &str) -> bool {
    cancelled_ai_runs()
        .lock()
        .map(|runs| runs.contains(run_id))
        .unwrap_or(false)
}

/// Prepare provider bridges for tree-scoped cancellation. Unix starts a new
/// process group. Windows starts a PaintNode wrapper blocked on an
/// authenticated loopback channel. Only after the parent assigns that wrapper
/// to a kill-on-close Job Object does it send the release token. The OS owns
/// the unique endpoint, no handles are inherited, and stdin remains untouched.
/// Windows associates every later descendant with that job by default;
/// breakaway is not enabled.
#[cfg(windows)]
const PROVIDER_WRAPPER_ARG: &str = "--paintnode-ai-provider-wrapper";
#[cfg(any(windows, test))]
const PROVIDER_WRAPPER_RELEASE_TOKEN: &[u8] = b"paintnode-provider-job-assigned-v1";

pub(crate) struct ProviderLaunchGate {
    #[cfg(any(windows, test))]
    listener: TcpListener,
    #[cfg(any(windows, test))]
    secret: [u8; 32],
}

#[cfg(any(windows, test))]
fn encode_provider_gate_secret(secret: &[u8; 32]) -> String {
    secret.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(any(windows, test))]
fn decode_provider_gate_secret(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Provider launch channel secret is invalid.".into());
    }
    let mut secret = [0_u8; 32];
    for (index, byte) in secret.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Provider launch channel secret is invalid.".to_string())?;
    }
    Ok(secret)
}

#[cfg(any(windows, test))]
fn create_provider_launch_gate(secret: [u8; 32]) -> Result<ProviderLaunchGate, String> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Could not reserve the provider launch channel: {error}"))?;
    Ok(ProviderLaunchGate { listener, secret })
}

#[cfg(windows)]
fn create_windows_provider_launch_gate() -> Result<ProviderLaunchGate, String> {
    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret)
        .map_err(|error| format!("Could not secure the provider launch channel: {error}"))?;
    create_provider_launch_gate(secret)
}

#[cfg(any(windows, test))]
fn release_provider_launch_gate(gate: &ProviderLaunchGate) -> Result<(), String> {
    release_provider_launch_gate_with_timeout(gate, Duration::from_secs(10))
}

#[cfg(any(windows, test))]
fn release_provider_launch_gate_with_timeout(
    gate: &ProviderLaunchGate,
    timeout: Duration,
) -> Result<(), String> {
    gate.listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not prepare the provider launch channel: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Provider wrapper did not authenticate before launch timeout.".into());
        }
        match gate.listener.accept() {
            Ok((mut stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                stream
                    .set_nonblocking(false)
                    .map_err(|error| format!("Could not secure provider launch input: {error}"))?;
                stream
                    .set_read_timeout(Some(remaining.min(Duration::from_millis(100))))
                    .map_err(|error| format!("Could not secure provider launch input: {error}"))?;
                let mut received = Vec::new();
                if Read::by_ref(&mut stream)
                    .take(64)
                    .read_to_end(&mut received)
                    .is_err()
                    || received.as_slice() != gate.secret
                {
                    continue;
                }
                stream
                    .write_all(PROVIDER_WRAPPER_RELEASE_TOKEN)
                    .and_then(|_| stream.shutdown(Shutdown::Write))
                    .map_err(|error| format!("Could not release the provider wrapper: {error}"))?;
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(format!("Could not accept the provider wrapper: {error}")),
        }
    }
}

#[cfg(any(windows, test))]
fn connect_provider_launch_gate(address: &str, secret: &[u8; 32]) -> Result<Vec<u8>, String> {
    let address = address
        .parse::<std::net::SocketAddr>()
        .map_err(|_| "Provider launch channel address is invalid.".to_string())?;
    if !address.ip().is_loopback() {
        return Err("Provider launch channel must use loopback.".into());
    }
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(10))
        .map_err(|error| format!("Could not connect to the provider launch channel: {error}"))?;
    authenticate_provider_launch_stream(stream, secret)
}

#[cfg(any(windows, test))]
fn authenticate_provider_launch_stream(
    mut stream: TcpStream,
    secret: &[u8; 32],
) -> Result<Vec<u8>, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("Could not configure the provider launch channel: {error}"))?;
    stream
        .write_all(secret)
        .and_then(|_| stream.shutdown(Shutdown::Write))
        .map_err(|error| format!("Could not authenticate the provider wrapper: {error}"))?;
    let mut response = Vec::new();
    stream
        .take(128)
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not read the provider launch release: {error}"))?;
    Ok(response)
}

#[cfg(any(windows, test))]
fn with_verified_provider_release<T>(
    release: &[u8],
    launch: impl FnOnce() -> T,
) -> Result<T, String> {
    if release != PROVIDER_WRAPPER_RELEASE_TOKEN {
        return Err("Provider launch was not released by its assigned process tree.".into());
    }
    Ok(launch())
}

pub(crate) fn configure_ai_process_group(
    command: &mut Command,
) -> Result<Option<ProviderLaunchGate>, String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        Ok(None)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        let program = command.get_program().to_os_string();
        let args = command
            .get_args()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let environment = command
            .get_envs()
            .map(|(name, value)| (name.to_os_string(), value.map(ToOwned::to_owned)))
            .collect::<Vec<_>>();
        let current_dir = command.get_current_dir().map(Path::to_path_buf);
        let gate = create_windows_provider_launch_gate()?;
        let address = gate
            .listener
            .local_addr()
            .map_err(|error| format!("Could not inspect the provider launch channel: {error}"))?;
        let secret = encode_provider_gate_secret(&gate.secret);
        let mut wrapper =
            Command::new(std::env::current_exe().map_err(|error| {
                format!("Could not locate PaintNode provider wrapper: {error}")
            })?);
        wrapper
            .arg(PROVIDER_WRAPPER_ARG)
            .arg(address.to_string())
            .arg(secret)
            .arg(program)
            .args(args)
            .creation_flags(CREATE_NEW_PROCESS_GROUP);
        if let Some(current_dir) = current_dir {
            wrapper.current_dir(current_dir);
        }
        for (name, value) in environment {
            if let Some(value) = value {
                wrapper.env(name, value);
            } else {
                wrapper.env_remove(name);
            }
        }
        *command = wrapper;
        Ok(Some(gate))
    }
}

#[cfg(windows)]
pub(crate) fn run_provider_process_wrapper_if_requested() -> Option<i32> {
    let mut args = std::env::args_os();
    let _executable = args.next()?;
    if args.next()?.to_str() != Some(PROVIDER_WRAPPER_ARG) {
        return None;
    }
    let address = args.next()?.to_string_lossy().into_owned();
    let secret = match args
        .next()
        .and_then(|value| value.to_str().map(str::to_string))
        .ok_or_else(|| "Provider launch channel secret is missing.".to_string())
        .and_then(|value| decode_provider_gate_secret(&value))
    {
        Ok(secret) => secret,
        Err(error) => {
            eprintln!("{error}");
            return Some(70);
        }
    };
    let program = args.next()?;
    let forwarded = args.collect::<Vec<_>>();
    let release = match connect_provider_launch_gate(&address, &secret) {
        Ok(release) => release,
        Err(error) => {
            eprintln!("{error}");
            return Some(70);
        }
    };
    let status = match with_verified_provider_release(&release, || {
        Command::new(program).args(forwarded).status()
    }) {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            eprintln!("PaintNode provider wrapper could not launch the provider bridge: {error}");
            return Some(71);
        }
        Err(error) => {
            eprintln!("{error}");
            return Some(70);
        }
    };
    Some(status.code().unwrap_or(1))
}

#[cfg(not(windows))]
pub(crate) fn run_provider_process_wrapper_if_requested() -> Option<i32> {
    None
}

#[cfg(any(windows, test))]
fn process_tree_action_result(success: bool, action: &str) -> Result<(), String> {
    if success {
        Ok(())
    } else {
        Err(format!("{action} did not stop the provider process tree."))
    }
}

pub(crate) struct AiProcessTree {
    #[cfg(unix)]
    process_id: u32,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

impl AiProcessTree {
    fn terminate(&mut self) -> Result<(), String> {
        #[cfg(unix)]
        unsafe {
            // configure_ai_process_group makes the direct child the group
            // leader, so this id remains valid after that child exits.
            if libc::kill(-(self.process_id as i32), libc::SIGKILL) == 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(format!(
                "Could not stop provider process group {}: {error}",
                self.process_id
            ));
        }
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::JobObjects::TerminateJobObject;

            if self.job.is_null() {
                return Ok(());
            }
            let terminated = TerminateJobObject(self.job, 1) != 0;
            let terminate_error = (!terminated).then(std::io::Error::last_os_error);
            let closed = CloseHandle(self.job) != 0;
            self.job = std::ptr::null_mut();
            process_tree_action_result(terminated, "Windows Job Object termination").map_err(
                |message| {
                    format!(
                        "{message} {} Kill-on-close fallback {}.",
                        terminate_error
                            .map(|error| error.to_string())
                            .unwrap_or_else(|| "Unknown Windows error.".into()),
                        if closed {
                            "was requested"
                        } else {
                            "also failed"
                        }
                    )
                },
            )?;
            process_tree_action_result(closed, "Windows Job Object close")
        }
    }
}

#[cfg(windows)]
impl Drop for AiProcessTree {
    fn drop(&mut self) {
        if !self.job.is_null() {
            unsafe {
                // KILL_ON_JOB_CLOSE is a final safety net if a caller exits
                // before explicit termination.
                let _ = windows_sys::Win32::Foundation::CloseHandle(self.job);
            }
            self.job = std::ptr::null_mut();
        }
    }
}

#[cfg(windows)]
fn abort_windows_provider_wrapper(
    child: &mut Child,
    launch_gate: &mut Option<ProviderLaunchGate>,
    message: String,
) -> String {
    // Closing the listener first independently makes the blocked wrapper fail
    // closed even if direct process termination fails.
    drop(launch_gate.take());
    let _ = child.kill();
    let deadline = Instant::now() + OUTPUT_READER_JOIN_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return message,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => return format!("{message} Provider wrapper reap timed out."),
            Err(error) => return format!("{message} Could not reap provider wrapper: {error}"),
        }
    }
}

pub(crate) fn track_ai_process_tree(
    child: &mut Child,
    launch_gate: Option<ProviderLaunchGate>,
) -> Result<AiProcessTree, String> {
    #[cfg(unix)]
    {
        let _ = launch_gate;
        Ok(AiProcessTree {
            process_id: child.id(),
        })
    }
    #[cfg(windows)]
    unsafe {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let mut launch_gate = launch_gate;
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            let message = format!(
                "Could not create Windows provider Job Object: {}",
                std::io::Error::last_os_error()
            );
            return Err(abort_windows_provider_wrapper(
                child,
                &mut launch_gate,
                message,
            ));
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of!(limits).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) != 0;
        let assigned =
            configured && AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) != 0;
        if !assigned {
            // This also handles an invalid nested-job environment. Never fall
            // back to an untracked provider process tree.
            let error = std::io::Error::last_os_error();
            let _ = CloseHandle(job);
            return Err(abort_windows_provider_wrapper(
                child,
                &mut launch_gate,
                format!("Could not isolate the Windows provider process tree: {error}"),
            ));
        }
        let gate = match launch_gate.take() {
            Some(gate) => gate,
            None => {
                let _ = TerminateJobObject(job, 1);
                let _ = CloseHandle(job);
                return Err(abort_windows_provider_wrapper(
                    child,
                    &mut launch_gate,
                    "Windows provider wrapper launch gate is missing.".into(),
                ));
            }
        };
        if let Err(error) = release_provider_launch_gate(&gate) {
            drop(gate);
            let _ = TerminateJobObject(job, 1);
            let _ = CloseHandle(job);
            return Err(abort_windows_provider_wrapper(
                child,
                &mut launch_gate,
                format!("Could not release the isolated Windows provider wrapper: {error}"),
            ));
        }
        drop(gate);
        Ok(AiProcessTree { job })
    }
}

pub(crate) fn cleanup_ai_process_tree_after_bridge_exit(
    tree: &mut AiProcessTree,
) -> Result<(), String> {
    tree.terminate()
}

/// Force-stop an isolated provider process tree and reap its direct child.
pub(crate) fn terminate_ai_process_tree(
    tree: &mut AiProcessTree,
    child: &mut Child,
) -> Result<ExitStatus, String> {
    let tree_result = tree.terminate();
    let _ = child.kill();
    let status = child
        .wait()
        .map_err(|error| format!("Could not reap provider bridge: {error}"))?;
    tree_result?;
    Ok(status)
}

/// Reader threads normally finish as soon as the isolated process group is
/// gone. Keep a hard upper bound so an OS-level termination failure or an
/// unexpected inherited pipe cannot hold the caller indefinitely.
pub(crate) fn join_output_readers_bounded(
    readers: Vec<thread::JoinHandle<()>>,
    timeout: Duration,
) -> Result<(), String> {
    if readers.is_empty() {
        return Ok(());
    }
    let count = readers.len();
    let (finished_tx, finished_rx) = mpsc::channel();
    for reader in readers {
        let finished_tx = finished_tx.clone();
        thread::spawn(move || {
            let _ = reader.join();
            let _ = finished_tx.send(());
        });
    }
    drop(finished_tx);
    let deadline = Instant::now() + timeout;
    for _ in 0..count {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || finished_rx.recv_timeout(remaining).is_err() {
            return Err(
                "Provider output reader cleanup timed out after process termination.".into(),
            );
        }
    }
    Ok(())
}

pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(100);
pub(crate) const OUTPUT_READER_JOIN_TIMEOUT: Duration = Duration::from_secs(2);

const CODEX_PROGRESS_EVENT: &str = "codex-generation-progress";

pub(crate) const PAINTNODE_WORK_DIR: &str = "paintnode";
pub(crate) const CODEX_RUNS_DIR: &str = "codex-runs";
pub(crate) const CLAUDE_RUNS_DIR: &str = "claude-runs";
pub(crate) const ANTIGRAVITY_RUNS_DIR: &str = "antigravity-runs";

fn ai_cli_path() -> String {
    let mut entries: Vec<String> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|entry| entry.to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();

    if let Ok(home) = std::env::var("HOME") {
        entries.extend([
            format!("{home}/.local/bin"),
            format!("{home}/.npm-global/bin"),
            format!("{home}/.volta/bin"),
            format!("{home}/.bun/bin"),
            format!("{home}/.antigravity/antigravity/bin"),
        ]);
    }

    entries.extend([
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ]);

    let mut seen = HashSet::new();
    entries.retain(|entry| !entry.is_empty() && seen.insert(entry.clone()));
    std::env::join_paths(entries.iter().map(Path::new))
        .unwrap_or_else(|_| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into())
        .to_string_lossy()
        .to_string()
}

pub(crate) fn apply_ai_cli_environment(command: &mut Command) -> &mut Command {
    command.env("PATH", ai_cli_path())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedImageResult {
    data_url: String,
    asset: Option<ProjectAssetView>,
    assets: Vec<ProjectAssetView>,
    mask_data_url: Option<String>,
    layers: Vec<GeneratedImageLayerResult>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedImageLayerResult {
    name: String,
    data_url: String,
    asset: Option<ProjectAssetView>,
    mask_data_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexDetectionResult {
    found: bool,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReasoningCapability {
    value: String,
    label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiModelCapability {
    id: String,
    label: String,
    description: Option<String>,
    supported_reasoning_efforts: Vec<AiReasoningCapability>,
    default_reasoning_effort: Option<String>,
    is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProviderFeatureCapabilities {
    transport: String,
    session_reuse: bool,
    structured_output: bool,
    app_mediated_user_input: bool,
    autonomous_subagents: bool,
    managed_subagents: bool,
    structured_progress: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProviderCapabilitiesResult {
    models: Vec<AiModelCapability>,
    source: String,
    warning: Option<String>,
    features: AiProviderFeatureCapabilities,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecoupledLayerResult {
    name: String,
    data_url: String,
    alpha_mask_data_url: Option<String>,
    key_color: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
    opacity: Option<f32>,
    visible: Option<bool>,
    asset: Option<ProjectAssetView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecoupleImageResult {
    layers: Vec<DecoupledLayerResult>,
    thread_id: Option<String>,
    notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecoupleManifest {
    #[serde(default, alias = "assets")]
    layers: Vec<DecoupleManifestLayer>,
    notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecoupleManifestLayer {
    name: String,
    file: String,
    alpha_mask: Option<String>,
    key_color: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
    opacity: Option<f32>,
    visible: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowSourceImage {
    name: String,
    bytes: Vec<u8>,
}

fn reference_png_file_name(index: usize, name: &str) -> String {
    let source = Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(name);
    format!("reference-{}-{}.png", index + 1, safe_stem(source))
}

pub(crate) fn validate_reference_pngs(
    references: &[WorkflowSourceImage],
    context: &str,
) -> Result<(), String> {
    for (index, reference) in references.iter().enumerate() {
        if !is_png(&reference.bytes) {
            return Err(format!(
                "{context} reference {} is not a PNG image.",
                index + 1
            ));
        }
        png_dimensions_from_bytes(&reference.bytes).ok_or_else(|| {
            format!(
                "{context} reference {} PNG dimensions are invalid.",
                index + 1
            )
        })?;
    }
    Ok(())
}

pub(crate) fn write_reference_pngs(
    job_path: &Path,
    references: &[WorkflowSourceImage],
    context: &str,
) -> Result<(Vec<PathBuf>, Vec<String>), String> {
    if references.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let reference_dir = job_path.join("references");
    fs::create_dir_all(&reference_dir)
        .map_err(|e| format!("Failed to create {context} references directory: {e}"))?;
    let mut paths = Vec::with_capacity(references.len());
    let mut names = Vec::with_capacity(references.len());
    for (index, reference) in references.iter().enumerate() {
        let name = reference_png_file_name(index, &reference.name);
        let path = reference_dir.join(&name);
        fs::write(&path, &reference.bytes)
            .map_err(|e| format!("Failed to write {context} reference image: {e}"))?;
        paths.push(path);
        names.push(format!("references/{name}"));
    }
    Ok((paths, names))
}

pub(crate) fn reference_prompt_note(reference_names: &[String], prefix: &str) -> String {
    if reference_names.is_empty() {
        return "- No additional user reference images are attached.".into();
    }
    let mut lines = vec!["Additional user reference images:".to_string()];
    for name in reference_names {
        lines.push(format!("- `{prefix}{name}`: user-added visual reference."));
    }
    lines.push("Use these references as visual guidance for style, identity, material, palette, composition, or specific details requested by the prompt. Do not paste them directly unless the user explicitly asks for copied content.".into());
    lines.join("\n")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexProgressPayload {
    run_id: String,
    message: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    /// 1-based position of the placement part this message belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    part_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    part_count: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiAutonomyLevel {
    Low,
    Guided,
    Open,
    Unmanaged,
}

impl AiAutonomyLevel {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Guided => "guided",
            Self::Open => "open",
            Self::Unmanaged => "unmanaged",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiDirectorMode {
    Auto,
    Skip,
    Force,
}

impl AiDirectorMode {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Skip => "skip",
            Self::Force => "force",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiDirectorProvider {
    Codex,
    Antigravity,
    Claude,
}

impl AiDirectorProvider {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Antigravity => "Antigravity",
            Self::Claude => "Claude",
        }
    }
}

pub(crate) fn ai_provider_features(provider: AiDirectorProvider) -> AiProviderFeatureCapabilities {
    match provider {
        AiDirectorProvider::Codex => AiProviderFeatureCapabilities {
            transport: "sdk".into(),
            session_reuse: true,
            structured_output: true,
            app_mediated_user_input: true,
            autonomous_subagents: true,
            managed_subagents: false,
            structured_progress: true,
        },
        AiDirectorProvider::Claude => AiProviderFeatureCapabilities {
            transport: "sdk".into(),
            session_reuse: true,
            structured_output: true,
            app_mediated_user_input: true,
            autonomous_subagents: true,
            managed_subagents: true,
            structured_progress: true,
        },
        AiDirectorProvider::Antigravity => AiProviderFeatureCapabilities {
            transport: "cli".into(),
            session_reuse: true,
            structured_output: false,
            app_mediated_user_input: true,
            autonomous_subagents: true,
            managed_subagents: false,
            structured_progress: false,
        },
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiDirectorInvolvement {
    PlanOnly,
    EnsureCompletion,
    FullReview,
}

impl AiDirectorInvolvement {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::PlanOnly => "planOnly",
            Self::EnsureCompletion => "ensureCompletion",
            Self::FullReview => "fullReview",
        }
    }
}

pub(crate) struct TempJobDir {
    path: PathBuf,
}

impl TempJobDir {
    pub(crate) fn new(prefix: &str) -> Result<Self, String> {
        let base = std::env::temp_dir();
        let pid = std::process::id();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);

        for attempt in 0..100 {
            let path = base.join(format!("{prefix}-{pid}-{ts}-{attempt}"));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("Failed to create temp job directory: {e}")),
            }
        }

        Err("Failed to allocate a unique temp job directory.".into())
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempJobDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub(crate) fn now_id() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

pub(crate) fn ensure_agent_run_dirs(project_path: &Path) -> Result<(), String> {
    fs::create_dir_all(project_path.join(PAINTNODE_WORK_DIR).join(CODEX_RUNS_DIR))
        .map_err(|e| format!("Failed to create Codex runs folder: {e}"))?;
    fs::create_dir_all(project_path.join(PAINTNODE_WORK_DIR).join(CLAUDE_RUNS_DIR))
        .map_err(|e| format!("Failed to create Claude runs folder: {e}"))?;
    fs::create_dir_all(
        project_path
            .join(PAINTNODE_WORK_DIR)
            .join(ANTIGRAVITY_RUNS_DIR),
    )
    .map_err(|e| format!("Failed to create Antigravity runs folder: {e}"))?;
    Ok(())
}

pub(crate) fn project_agent_run_dir(
    project_dir: &Path,
    vendor_dir: &str,
    prefix: &str,
) -> Result<PathBuf, String> {
    ensure_project_dirs(project_dir)?;
    let run_dir = project_dir
        .join(PAINTNODE_WORK_DIR)
        .join(vendor_dir)
        .join(format!("{prefix}-{}", now_id()));
    fs::create_dir_all(&run_dir).map_err(|e| format!("Failed to create AI job folder: {e}"))?;
    Ok(run_dir)
}

/// Deterministic job folder for a run id: a retry of the same task lands in
/// the same folder, so it can resume from the previous attempt's part results.
pub(crate) fn project_agent_run_dir_for_run(
    project_dir: &Path,
    vendor_dir: &str,
    prefix: &str,
    run_id: &str,
) -> Result<PathBuf, String> {
    ensure_project_dirs(project_dir)?;
    let run_dir = project_dir
        .join(PAINTNODE_WORK_DIR)
        .join(vendor_dir)
        .join(format!("{prefix}-{}", safe_stem(run_id)));
    fs::create_dir_all(&run_dir).map_err(|e| format!("Failed to create AI job folder: {e}"))?;
    Ok(run_dir)
}

pub(crate) fn optional_project_dir(project_path: &Option<String>) -> Option<PathBuf> {
    project_path
        .as_ref()
        .map(|p| PathBuf::from(p.trim()))
        .filter(|p| !p.as_os_str().is_empty())
}

pub(crate) fn ai_job_project_dir(
    app: &AppHandle,
    project_dir: &Option<PathBuf>,
    keep_job_dir: bool,
) -> Result<Option<PathBuf>, String> {
    if project_dir.is_some() || !keep_job_dir {
        return Ok(project_dir.clone());
    }
    let default_dir = default_documents_project_dir(app)?;
    ensure_project_dirs(&default_dir)?;
    Ok(Some(default_dir))
}

pub(crate) fn cleanup_project_agent_job(job_path: &Path) {
    let _ = fs::remove_dir_all(job_path);
    if let Some(vendor_dir) = job_path.parent() {
        let is_agent_vendor_dir = vendor_dir
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            == Some(PAINTNODE_WORK_DIR);
        if is_agent_vendor_dir {
            let is_empty = fs::read_dir(vendor_dir)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false);
            if is_empty {
                let _ = fs::remove_dir(vendor_dir);
            }
        }
    }
}

pub(crate) fn should_keep_job_dir(keep_job_dir: Option<bool>) -> bool {
    keep_job_dir.unwrap_or(false)
}

pub(crate) fn cleanup_project_job_enabled(
    project_dir: &Option<PathBuf>,
    keep_job_dir: bool,
) -> bool {
    project_dir.is_some() && !keep_job_dir
}

pub(crate) fn write_ai_job_prompt(
    job_path: &Path,
    prompt: &str,
    label: &str,
) -> Result<(), String> {
    fs::write(job_path.join("prompt.txt"), prompt)
        .map_err(|e| format!("Failed to write {label} prompt file: {e}"))
}

pub(crate) fn write_ai_job_settings(
    job_path: &Path,
    settings: serde_json::Value,
) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(&settings)
        .map_err(|e| format!("Failed to encode AI job settings: {e}"))?;
    fs::write(job_path.join("job-settings.json"), text)
        .map_err(|e| format!("Failed to write AI job settings file: {e}"))
}

pub(crate) fn remove_legacy_generative_fill_agent_inputs(part_path: &Path) {
    let _ = fs::remove_file(part_path.join("edit_target.png"));
    let _ = fs::remove_file(part_path.join("mask.png"));
}

pub(crate) fn emit_kept_job_dir(
    app: &AppHandle,
    run_id: &str,
    job_path: &Path,
    keep_job_dir: bool,
) {
    if keep_job_dir {
        emit_codex_progress(
            app,
            run_id,
            format!("Saved AI run inputs: {}", job_path.display()),
        );
    }
}

pub(crate) fn safe_png_source_file_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| *name != "result.png")
        .filter(|name| safe_file_name(name).is_some())
        .map(str::to_string)
}

pub(crate) fn ai_retouch_asset_name(prompt: &str, source_file_name: Option<&str>) -> String {
    source_file_name.map(str::to_string).unwrap_or_else(|| {
        let prompt = prompt.trim();
        let suffix = if prompt.is_empty() {
            "result".into()
        } else {
            prompt.chars().take(48).collect::<String>()
        };
        format!("AI Retouch: {suffix}")
    })
}

fn required_png_output_state(path: &Path) -> Option<(u64, Option<SystemTime>)> {
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() || metadata.len() < PNG_SIGNATURE.len() as u64 {
        return None;
    }
    if !file_has_png_signature(path) {
        return None;
    }
    Some((metadata.len(), metadata.modified().ok()))
}

pub(crate) fn required_png_output_is_ready(
    job_path: &Path,
    required_output: &str,
    snapshot: &mut Option<(u64, Option<SystemTime>, Instant)>,
) -> bool {
    let Some((len, modified)) = required_png_output_state(&job_path.join(required_output)) else {
        *snapshot = None;
        return false;
    };

    if let Some(modified) = modified {
        if SystemTime::now()
            .duration_since(modified)
            .is_ok_and(|age| age >= Duration::from_millis(1000))
        {
            return true;
        }
    }

    match snapshot {
        Some((last_len, last_modified, since))
            if *last_len == len && *last_modified == modified =>
        {
            since.elapsed() >= Duration::from_millis(1000)
        }
        _ => {
            *snapshot = Some((len, modified, Instant::now()));
            false
        }
    }
}

pub(crate) fn copy_png_candidate(candidate: &Path, result_path: &Path) -> bool {
    if candidate == result_path {
        return true;
    }
    if !file_has_png_signature(candidate) {
        return false;
    }
    if let Some(parent) = result_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::copy(candidate, result_path).is_ok()
}

pub(crate) fn unique_child_path(dir: &Path, file_name: &str) -> PathBuf {
    let safe_name =
        safe_file_name(file_name).unwrap_or_else(|| format!("codex-generated-{}.png", now_id()));
    let first = dir.join(&safe_name);
    if !first.exists() {
        return first;
    }

    let path = Path::new(&safe_name);
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .map(safe_stem)
        .unwrap_or_else(|| "codex-generated".into());
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("png");
    for index in 2..1000 {
        let candidate = dir.join(format!("{stem}-{index}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    dir.join(format!("{stem}-{}.{}", now_id(), ext))
}

pub(crate) fn safe_job_child_path(job_path: &Path, file_name: &str) -> Result<PathBuf, String> {
    let relative = Path::new(file_name.trim());
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err(format!("Manifest layer file path is invalid: {file_name}"));
    }
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(format!("Manifest layer file path is invalid: {file_name}"));
        }
    }
    Ok(job_path.join(relative))
}

pub(crate) fn sanitize_progress_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let single_line = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    let char_count = single_line.chars().count();
    let text = if char_count > 140 {
        format!("{}...", single_line.chars().take(137).collect::<String>())
    } else {
        single_line
    };

    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn normalize_progress_run_dir_references(text: String) -> String {
    [CODEX_RUNS_DIR, CLAUDE_RUNS_DIR, ANTIGRAVITY_RUNS_DIR]
        .into_iter()
        .fold(text, |current, dir| {
            [
                (format!("`{dir}` directory"), "job folder"),
                (format!("`{dir}` folder"), "job folder"),
                (format!("{dir} directory"), "job folder"),
                (format!("{dir} folder"), "job folder"),
                (format!("`{dir}`"), "job folder"),
                (dir.to_string(), "job folder"),
            ]
            .into_iter()
            .fold(current, |next, (needle, replacement)| {
                next.replace(&needle, replacement)
            })
        })
}

pub(crate) fn sanitize_provider_progress_line(line: &str) -> Option<String> {
    sanitize_progress_line(line).map(normalize_progress_run_dir_references)
}

pub(crate) fn json_string_at<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

pub(crate) fn codex_agent_message_text(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let item_type = json_string_at(&value, &["item", "type"]).unwrap_or("");
    if !event_type.contains("item.completed") || !item_type.contains("agent_message") {
        return None;
    }
    let text = json_string_at(&value, &["item", "text"])?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

pub(crate) fn codex_thread_id_from_line(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if !event_type.contains("thread.started") {
        return None;
    }
    let thread_id = json_string_at(&value, &["thread_id"])?.trim();
    if thread_id.is_empty() {
        None
    } else {
        Some(thread_id.to_string())
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ProviderProgressUpdate {
    kind: String,
    message: String,
    detail: Option<String>,
}

fn provider_progress_update(
    line: &str,
    is_stderr: bool,
    provider_label: &str,
) -> Option<ProviderProgressUpdate> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let item_type = json_string_at(&value, &["item", "type"]).unwrap_or("");
        let combined = format!("{event_type} {item_type} {}", value).to_ascii_lowercase();

        if event_type == "provider.progress" {
            let kind = json_string_at(&value, &["kind"])
                .filter(|kind| !kind.trim().is_empty())
                .unwrap_or("agentProgress");
            let message = json_string_at(&value, &["message"])
                .and_then(sanitize_provider_progress_line)
                .unwrap_or_else(|| format!("{provider_label} is working"));
            let detail =
                json_string_at(&value, &["detail"]).and_then(sanitize_provider_progress_line);
            return Some(ProviderProgressUpdate {
                kind: kind.to_string(),
                message,
                detail,
            });
        }

        if event_type.contains("thread.started") {
            return Some(ProviderProgressUpdate {
                kind: "sessionStarted".into(),
                message: format!("{provider_label} session started"),
                detail: None,
            });
        }
        if event_type.contains("turn.started") {
            return Some(ProviderProgressUpdate {
                kind: "turnStarted".into(),
                message: format!("{provider_label} is working on the image"),
                detail: None,
            });
        }
        if event_type.contains("turn.completed") {
            return Some(ProviderProgressUpdate {
                kind: "turnCompleted".into(),
                message: format!("{provider_label} finished; checking generated output"),
                detail: None,
            });
        }
        if event_type.contains("error") {
            let message = json_string_at(&value, &["message"])
                .or_else(|| json_string_at(&value, &["error", "message"]))
                .and_then(sanitize_provider_progress_line)
                .unwrap_or_else(|| format!("{provider_label} reported an error"));
            return Some(ProviderProgressUpdate {
                kind: "error".into(),
                message,
                detail: None,
            });
        }
        if event_type.contains("item.started") {
            if combined.contains("imagegen") || combined.contains("image_generation") {
                return Some(ProviderProgressUpdate {
                    kind: "toolStarted".into(),
                    message: format!("Generating image with {provider_label}"),
                    detail: Some("imageGeneration".into()),
                });
            }
            if combined.contains("tool")
                || combined.contains("function")
                || matches!(
                    item_type,
                    "command_execution" | "file_change" | "mcp_tool_call" | "web_search"
                )
            {
                return Some(ProviderProgressUpdate {
                    kind: "toolStarted".into(),
                    message: format!("{provider_label} is using a local tool"),
                    detail: (!item_type.is_empty()).then(|| item_type.to_string()),
                });
            }
            return Some(ProviderProgressUpdate {
                kind: "agentProgress".into(),
                message: format!("{provider_label} is processing the prompt"),
                detail: (!item_type.is_empty()).then(|| item_type.to_string()),
            });
        }
        if event_type.contains("item.completed") {
            if combined.contains("imagegen") || combined.contains("image_generation") {
                return Some(ProviderProgressUpdate {
                    kind: "toolCompleted".into(),
                    message: format!(
                        "Image generation step completed; waiting for {provider_label}"
                    ),
                    detail: Some("imageGeneration".into()),
                });
            }
            if combined.contains("agent_message") {
                if let Some(message) = codex_agent_message_text(trimmed)
                    .and_then(|text| sanitize_provider_progress_line(&text))
                {
                    let lower = message.to_ascii_lowercase();
                    if lower.contains("using the imagegen skill")
                        || lower.contains("using the `imagegen` skill")
                        || lower.contains("using the image generation skill")
                    {
                        return Some(ProviderProgressUpdate {
                            kind: "agentProgress".into(),
                            message: format!("{provider_label} is preparing image generation"),
                            detail: Some("agentMessage".into()),
                        });
                    }
                    return Some(ProviderProgressUpdate {
                        kind: "agentMessage".into(),
                        message: format!("{provider_label}: {message}"),
                        detail: None,
                    });
                }
                return Some(ProviderProgressUpdate {
                    kind: "agentProgress".into(),
                    message: format!("{provider_label} is continuing image generation"),
                    detail: Some("agentMessage".into()),
                });
            }
            if !item_type.is_empty() {
                return Some(ProviderProgressUpdate {
                    kind: "toolCompleted".into(),
                    message: format!("{provider_label} completed a {item_type} step"),
                    detail: Some(item_type.to_string()),
                });
            }
        }
        return None;
    }

    let text = sanitize_provider_progress_line(trimmed)?;
    let lower = text.to_ascii_lowercase();
    let provider_lower = provider_label.to_ascii_lowercase();
    if is_stderr
        || lower.contains(&provider_lower)
        || lower.contains("codex")
        || lower.contains("antigravity")
        || lower.contains("agy")
        || lower.contains("thinking")
        || lower.contains("processing")
        || lower.contains("waiting")
        || lower.contains("generating")
        || lower.contains("created")
        || lower.contains("saved")
        || lower.contains("image")
        || lower.contains("result.png")
        || lower.contains("timeout")
        || lower.contains("error")
    {
        Some(ProviderProgressUpdate {
            kind: if is_stderr { "diagnostic" } else { "message" }.into(),
            message: text,
            detail: None,
        })
    } else {
        None
    }
}

#[cfg(test)]
fn provider_progress_message(line: &str, is_stderr: bool, provider_label: &str) -> Option<String> {
    provider_progress_update(line, is_stderr, provider_label).map(|update| update.message)
}

pub(crate) fn watched_job_files(job_path: &Path) -> HashMap<String, Option<SystemTime>> {
    let mut files = HashMap::new();
    let Ok(entries) = fs::read_dir(job_path) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let lower = file_name.to_ascii_lowercase();
        if !(lower.ends_with(".png") || lower.ends_with(".json") || lower.ends_with(".txt")) {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok());
        files.insert(file_name.to_string(), modified);
    }
    files
}

fn job_file_progress_message(
    provider_label: &str,
    file_name: &str,
    required_output: Option<&str>,
) -> String {
    if required_output == Some(file_name) {
        return format!("{provider_label} wrote {file_name}; waiting for the CLI to finish");
    }
    if file_name.ends_with(".png") {
        if required_output
            .is_some_and(|required| file_name.starts_with("result") && file_name != required)
        {
            return format!(
                "{provider_label} wrote {file_name}; still waiting for required {required}",
                required = required_output.unwrap()
            );
        }
        return format!("{provider_label} wrote image candidate: {file_name}");
    }
    format!("{provider_label} updated {file_name}")
}

pub(crate) fn emit_job_file_progress(
    app: &AppHandle,
    run_id: &str,
    provider_label: &str,
    job_path: &Path,
    snapshot: &mut HashMap<String, Option<SystemTime>>,
    required_output: Option<&str>,
) {
    let current = watched_job_files(job_path);
    let mut changes = current
        .iter()
        .filter(|(name, modified)| snapshot.get(*name) != Some(*modified))
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    changes.sort();
    for file_name in changes {
        emit_provider_progress(
            app,
            run_id,
            "artifactUpdated",
            provider_label,
            job_file_progress_message(provider_label, &file_name, required_output),
            Some(&file_name),
        );
    }
    *snapshot = current;
}

fn generated_job_outputs(job_path: &Path, required_output: &str) -> Vec<String> {
    let mut outputs = watched_job_files(job_path)
        .into_keys()
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            name != required_output
                && lower.ends_with(".png")
                && !matches!(
                    lower.as_str(),
                    "source.png" | "edit_target.png" | "mask.png" | "part_result.png"
                )
        })
        .collect::<Vec<_>>();
    outputs.sort();
    outputs
}

pub(crate) fn command_failure_with_required_output(
    prefix: &str,
    output: &Output,
    job_path: &Path,
    required_output: &str,
) -> String {
    let mut message = command_failure(prefix, output);
    if !job_path.join(required_output).exists() {
        let outputs = generated_job_outputs(job_path, required_output);
        if !outputs.is_empty() {
            message.push_str(&format!(
                "\n\nAntigravity created {}, but PaintNode still needs `{required_output}`.",
                outputs.join(", ")
            ));
        }
    }
    message
}

fn is_fallback_decouple_asset_png(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    if !lower.ends_with(".png") {
        return false;
    }
    if matches!(
        lower.as_str(),
        "source.png" | "edit_target.png" | "mask.png" | "part_result.png" | "result.png"
    ) {
        return false;
    }
    let stem = lower.strip_suffix(".png").unwrap_or(lower.as_str());
    let debug_tokens = [
        "alpha",
        "annotated",
        "bbox",
        "comparison",
        "coordinate",
        "coordinates",
        "debug",
        "grid",
        "guide",
        "histogram",
        "mask",
        "overlay",
        "preview",
    ];
    !stem
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .any(|token| debug_tokens.contains(&token))
}

fn fallback_decouple_asset_name(file_name: &str, index: usize) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    let mut name = String::new();
    let mut uppercase_next = true;
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() {
            let ch = ch.to_ascii_lowercase();
            name.push(if uppercase_next {
                ch.to_ascii_uppercase()
            } else {
                ch
            });
            uppercase_next = false;
        } else if !name.ends_with(' ') {
            name.push(' ');
            uppercase_next = true;
        }
    }
    let name = name.trim();
    if name.is_empty() {
        format!("Extracted Asset {}", index + 1)
    } else {
        name.chars().take(80).collect()
    }
}

fn fallback_decouple_asset_pngs(job_path: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let entries = fs::read_dir(job_path).map_err(|e| {
        format!(
            "Failed to inspect asset extraction outputs at {}: {e}",
            job_path.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| {
            format!(
                "Failed to inspect asset extraction output at {}: {e}",
                job_path.display()
            )
        })?;
        let file_type = entry.file_type().map_err(|e| {
            format!(
                "Failed to inspect asset extraction output type at {}: {e}",
                entry.path().display()
            )
        })?;
        if !file_type.is_file() {
            continue;
        }
        let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_fallback_decouple_asset_png(&file_name) {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|e| {
            format!(
                "Failed to read asset extraction output at {}: {e}",
                entry.path().display()
            )
        })?;
        if is_png(&bytes) && png_dimensions_from_bytes(&bytes).is_some() {
            files.push(file_name);
        }
    }
    files.sort_by_key(|name| name.to_ascii_lowercase());
    Ok(files)
}

pub(crate) fn synthesize_decouple_asset_manifest(job_path: &Path) -> Result<Option<usize>, String> {
    let files = fallback_decouple_asset_pngs(job_path)?;
    if files.is_empty() {
        return Ok(None);
    }
    let layers = files
        .iter()
        .enumerate()
        .map(|(index, file)| {
            serde_json::json!({
                "name": fallback_decouple_asset_name(file, index),
                "file": file,
                "alphaMask": serde_json::Value::Null,
                "keyColor": serde_json::Value::Null,
                "opacity": 1,
                "visible": true,
            })
        })
        .collect::<Vec<_>>();
    let manifest = serde_json::json!({
        "layers": layers,
        "notes": "PaintNode synthesized this manifest from extracted PNG outputs because manifest.json was missing.",
    });
    let manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize fallback asset manifest: {e}"))?;
    fs::write(job_path.join("manifest.json"), manifest_text)
        .map_err(|e| format!("Failed to write fallback asset manifest: {e}"))?;
    Ok(Some(files.len()))
}

pub(crate) fn emit_codex_progress(app: &AppHandle, run_id: &str, message: impl Into<String>) {
    let _ = app.emit(
        CODEX_PROGRESS_EVENT,
        CodexProgressPayload {
            run_id: run_id.to_string(),
            message: message.into(),
            kind: "message".into(),
            provider: None,
            detail: None,
            part_index: None,
            part_count: None,
        },
    );
}

pub(crate) fn emit_provider_progress(
    app: &AppHandle,
    run_id: &str,
    kind: &str,
    provider_label: &str,
    message: impl Into<String>,
    detail: Option<&str>,
) {
    let _ = app.emit(
        CODEX_PROGRESS_EVENT,
        CodexProgressPayload {
            run_id: run_id.to_string(),
            message: message.into(),
            kind: kind.to_string(),
            provider: Some(provider_label.to_string()),
            detail: detail.map(str::to_string),
            part_index: None,
            part_count: None,
        },
    );
}

/// Progress for one placement part; carries the part position so the task
/// list can render a sub-task progress indicator.
pub(crate) fn emit_codex_part_progress(
    app: &AppHandle,
    run_id: &str,
    part_index: usize,
    part_count: usize,
    message: impl Into<String>,
) {
    let _ = app.emit(
        CODEX_PROGRESS_EVENT,
        CodexProgressPayload {
            run_id: run_id.to_string(),
            message: message.into(),
            kind: "partProgress".into(),
            provider: None,
            detail: None,
            part_index: Some(part_index + 1),
            part_count: Some(part_count),
        },
    );
}

#[derive(Debug)]
pub(crate) struct AgentRunResult {
    pub(crate) output: Output,
    pub(crate) thread_id: Option<String>,
    pub(crate) satisfied_required_output: bool,
}

pub(crate) fn spawn_output_reader<R: Read + Send + 'static>(
    stream: R,
    sink: Arc<Mutex<Vec<u8>>>,
    app: AppHandle,
    run_id: String,
    is_stderr: bool,
    thread_id: Arc<Mutex<Option<String>>>,
    provider_label: String,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(mut output) = sink.lock() {
                        output.extend_from_slice(&line);
                    }
                    let text = String::from_utf8_lossy(&line);
                    if let Some(next_thread_id) = codex_thread_id_from_line(&text) {
                        if let Ok(mut current_thread_id) = thread_id.lock() {
                            *current_thread_id = Some(next_thread_id);
                        }
                    }
                    if let Some(update) =
                        provider_progress_update(&text, is_stderr, &provider_label)
                    {
                        emit_provider_progress(
                            &app,
                            &run_id,
                            &update.kind,
                            &provider_label,
                            update.message,
                            update.detail.as_deref(),
                        );
                    }
                }
                Err(_) => break,
            }
        }
    })
}

pub(crate) fn output_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    let char_count = trimmed.chars().count();
    if char_count <= 2000 {
        trimmed.to_string()
    } else {
        trimmed.chars().skip(char_count - 2000).collect()
    }
}

pub(crate) fn command_failure(prefix: &str, output: &Output) -> String {
    let stderr = output_tail(&output.stderr);
    let stdout = output_tail(&output.stdout);
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "No output was captured.".into()
    };

    let lower = detail.to_ascii_lowercase();
    if lower.contains("not authenticated")
        || lower.contains("not logged in")
        || lower.contains("login")
        || lower.contains("unauthorized")
    {
        return format!("{prefix} failed because Codex is not logged in. Run `codex login` in Terminal and try again.\n\n{detail}");
    }

    format!("{prefix} exited with {}:\n{detail}", output.status)
}

pub(crate) fn clean_option(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(crate) fn ai_autonomy_level(value: Option<String>) -> AiAutonomyLevel {
    match clean_option(value).as_deref() {
        Some("guided") => AiAutonomyLevel::Guided,
        Some("open") => AiAutonomyLevel::Open,
        Some("unmanaged") => AiAutonomyLevel::Unmanaged,
        _ => AiAutonomyLevel::Low,
    }
}

pub(crate) fn ai_director_mode(value: Option<String>) -> AiDirectorMode {
    match clean_option(value).as_deref() {
        Some("skip") => AiDirectorMode::Skip,
        Some("force") => AiDirectorMode::Force,
        _ => AiDirectorMode::Auto,
    }
}

pub(crate) fn ai_director_provider(value: Option<String>) -> AiDirectorProvider {
    match clean_option(value)
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("antigravity") | Some("agy") | Some("gemini") => AiDirectorProvider::Antigravity,
        Some("claude") => AiDirectorProvider::Claude,
        _ => AiDirectorProvider::Codex,
    }
}

pub(crate) fn ai_director_involvement(value: Option<String>) -> AiDirectorInvolvement {
    match clean_option(value).as_deref() {
        Some("planOnly") => AiDirectorInvolvement::PlanOnly,
        Some("ensureCompletion") => AiDirectorInvolvement::EnsureCompletion,
        _ => AiDirectorInvolvement::FullReview,
    }
}

pub(crate) fn ai_director_restore_contract(
    provider: AiDirectorProvider,
    mode: AiDirectorMode,
    involvement: AiDirectorInvolvement,
) -> String {
    ai_director_workflow_contract(provider, mode, involvement, "detail restoration")
}

pub(crate) fn ai_director_workflow_contract(
    provider: AiDirectorProvider,
    mode: AiDirectorMode,
    involvement: AiDirectorInvolvement,
    workflow: &str,
) -> String {
    if mode == AiDirectorMode::Skip {
        return String::new();
    }
    let label = provider.label();
    match involvement {
        AiDirectorInvolvement::PlanOnly => format!(
            "AI Director provider: {label}.\nAI Director participation: Plan only. Treat this prompt as the Director's plan for the {workflow} workflow; do not run a separate blocked-prompt or quality-review loop."
        ),
        AiDirectorInvolvement::EnsureCompletion => format!(
            "AI Director provider: {label}.\nAI Director participation: Ensure completion. If a provider safety or quality issue blocks the exact wording during the {workflow} workflow, make the smallest compliant prompt adjustment while preserving the user's intent, source-image facts, protected areas, and intentional medium character."
        ),
        AiDirectorInvolvement::FullReview => format!(
            "AI Director provider: {label}.\nAI Director participation: Full review. Supervise the {workflow} workflow from planning through completion: preserve the user's intent, recover from blocked wording with the smallest faithful prompt adjustment, and before returning compare the candidate against the source/task requirements. Revise internally until content, framing, grain/texture, exposure character, local detail, and protected areas remain faithful. Return only the final accepted result."
        ),
    }
}

pub(crate) fn image_agent_autonomy_contract(
    level: AiAutonomyLevel,
    _provider: &str,
) -> &'static str {
    match level {
        AiAutonomyLevel::Low => {
            "Autonomy level: Low. Use the image-generation capability for visual synthesis only. Do not write or run Python, shell, OpenCV, Pillow, ORB/homography, alignment, comparison-image, or custom verification tools. Do not search the workspace for helper scripts. PaintNode owns deterministic resizing, masking, protected-pixel restoration, alpha/key processing, validation, and import."
        }
        AiAutonomyLevel::Guided => {
            "Autonomy level: Guided. Prefer image generation only. You may do only simple file moves/copies or manifest/dimension inspection when explicitly needed to satisfy the required output file contract. Do not build image-processing pipelines, alignment tools, OpenCV/Pillow scripts, ORB/homography checks, or comparison-image workflows; PaintNode owns deterministic post-processing."
        }
        AiAutonomyLevel::Open => {
            "Autonomy level: Open. You may use simple local tools when useful, but keep generated image synthesis as the main task and avoid unnecessary tool-building. PaintNode still owns final deterministic import and protected-pixel restoration."
        }
        AiAutonomyLevel::Unmanaged => {
            "Autonomy level: Unmanaged. Use your available image-generation capability or provider tools to produce the requested image. PaintNode does not constrain the intermediate workflow beyond producing the required output."
        }
    }
}

type ProjectJobPath = (
    Option<PathBuf>,
    Option<PathBuf>,
    PathBuf,
    bool,
    Option<TempJobDir>,
);

pub(crate) fn project_or_temp_job_path(
    app: &AppHandle,
    project_path: &Option<String>,
    prefix: &str,
    run_id: &str,
    keep_job_dir: bool,
) -> Result<ProjectJobPath, String> {
    let project_dir = optional_project_dir(project_path);
    let job_project_dir = ai_job_project_dir(app, &project_dir, keep_job_dir)?;
    if let Some(job_project_dir) = &job_project_dir {
        let run_dir =
            project_agent_run_dir_for_run(job_project_dir, ANTIGRAVITY_RUNS_DIR, prefix, run_id)?;
        Ok((
            project_dir,
            Some(job_project_dir.clone()),
            run_dir,
            !keep_job_dir,
            None,
        ))
    } else {
        let temp_job = TempJobDir::new(&format!("paintnode-{prefix}"))?;
        let path = temp_job.path().to_path_buf();
        Ok((None, None, path, false, Some(temp_job)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn process_tree_termination_kills_bridge_and_descendant() {
        let job = TempJobDir::new("paintnode-process-tree-test").expect("temp dir");
        let descendant_path = job.path().join("descendant.pid");
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 30 & echo $! > \"$1\"; wait")
            .arg("paintnode-process-tree-test")
            .arg(&descendant_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let launch_gate = configure_ai_process_group(&mut command).expect("configure process tree");
        let mut child = command.spawn().expect("spawn bridge with descendant");
        let mut process_tree =
            track_ai_process_tree(&mut child, launch_gate).expect("track process tree");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !descendant_path.is_file() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let descendant_id = fs::read_to_string(&descendant_path)
            .expect("descendant pid")
            .trim()
            .parse::<i32>()
            .expect("numeric descendant pid");

        let status = terminate_ai_process_tree(&mut process_tree, &mut child).expect("reap bridge");
        assert!(!status.success());

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let exists = unsafe { libc::kill(descendant_id, 0) } == 0;
            if !exists {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "provider descendant survived process-tree termination"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn bridge_exit_still_kills_descendant_holding_inherited_output_pipe() {
        let job = TempJobDir::new("paintnode-inherited-pipe-test").expect("temp dir");
        let descendant_path = job.path().join("descendant.pid");
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 30 & echo $! > \"$1\"; echo bridge-done")
            .arg("paintnode-inherited-pipe-test")
            .arg(&descendant_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let launch_gate = configure_ai_process_group(&mut command).expect("configure process tree");
        let mut child = command.spawn().expect("spawn short-lived bridge");
        let mut process_tree =
            track_ai_process_tree(&mut child, launch_gate).expect("track process tree");
        let mut stream = child.stdout.take().expect("bridge stdout");
        let reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
        });

        let deadline = Instant::now() + Duration::from_secs(2);
        let status = loop {
            if let Some(status) = child.try_wait().expect("poll bridge") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = terminate_ai_process_tree(&mut process_tree, &mut child);
                panic!("test bridge did not exit before its descendant");
            }
            thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success());
        let descendant_id = fs::read_to_string(&descendant_path)
            .expect("descendant pid")
            .trim()
            .parse::<i32>()
            .expect("numeric descendant pid");

        cleanup_ai_process_tree_after_bridge_exit(&mut process_tree)
            .expect("kill lingering process tree");
        join_output_readers_bounded(vec![reader], Duration::from_secs(1))
            .expect("inherited output pipe closed");
        assert_ne!(unsafe { libc::kill(descendant_id, 0) }, 0);
    }

    #[test]
    fn process_tree_action_failure_is_never_reported_as_success() {
        assert!(process_tree_action_result(true, "Windows Job Object termination").is_ok());
        let error =
            process_tree_action_result(false, "Windows Job Object termination").unwrap_err();
        assert!(error.contains("did not stop the provider process tree"));
    }

    #[test]
    fn output_reader_cleanup_has_a_hard_timeout() {
        let reader = thread::spawn(|| thread::sleep(Duration::from_millis(100)));
        let error = join_output_readers_bounded(vec![reader], Duration::from_millis(5))
            .expect_err("reader cleanup should time out");
        assert!(error.contains("cleanup timed out"));
    }

    #[test]
    fn authenticated_loopback_gate_rejects_spoofing_and_releases_exact_wrapper() {
        let secret = [7_u8; 32];
        assert_eq!(
            decode_provider_gate_secret(&encode_provider_gate_secret(&secret)),
            Ok(secret)
        );
        let gate = create_provider_launch_gate(secret).expect("reserve loopback gate");
        let address = gate.listener.local_addr().expect("gate address");
        let wrong_stream = TcpStream::connect(address).expect("preconnect wrong client");
        let release_gate = thread::spawn(move || release_provider_launch_gate(&gate));
        assert_ne!(
            authenticate_provider_launch_stream(wrong_stream, &[8_u8; 32]).unwrap_or_default(),
            PROVIDER_WRAPPER_RELEASE_TOKEN
        );
        let correct_stream = TcpStream::connect(address).expect("preconnect correct client");
        let release =
            authenticate_provider_launch_stream(correct_stream, &secret).expect("release token");
        release_gate
            .join()
            .expect("release thread")
            .expect("release authenticated wrapper");
        assert_eq!(release, PROVIDER_WRAPPER_RELEASE_TOKEN);
    }

    #[test]
    fn dropped_assignment_gate_fails_closed_without_launch() {
        let secret = [11_u8; 32];
        let gate = create_provider_launch_gate(secret).expect("reserve loopback gate");
        let address = gate
            .listener
            .local_addr()
            .expect("gate address")
            .to_string();
        drop(gate);
        let release = connect_provider_launch_gate(&address, &secret).unwrap_or_default();
        let launched = std::cell::Cell::new(false);
        assert!(with_verified_provider_release(&release, || launched.set(true)).is_err());
        assert!(!launched.get());
    }

    #[test]
    fn sustained_wrong_clients_cannot_extend_release_deadline() {
        let secret = [13_u8; 32];
        let gate = create_provider_launch_gate(secret).expect("reserve loopback gate");
        let address = gate.listener.local_addr().expect("gate address");
        let _slow_clients = (0..4)
            .map(|_| TcpStream::connect(address).expect("preconnect slow wrong client"))
            .collect::<Vec<_>>();
        let started = Instant::now();
        let error = release_provider_launch_gate_with_timeout(&gate, Duration::from_millis(120))
            .expect_err("wrong clients must not authenticate");
        assert!(error.contains("timeout"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn invalid_or_preexisting_release_never_reaches_provider_launch() {
        let launched = std::cell::Cell::new(false);
        for signal in [
            b"".as_slice(),
            b"assigned",
            b"paintnode-provider-job-assigned-v1-extra",
        ] {
            let result = with_verified_provider_release(signal, || launched.set(true));
            assert!(result.is_err());
            assert!(!launched.get());
        }
        with_verified_provider_release(PROVIDER_WRAPPER_RELEASE_TOKEN, || launched.set(true))
            .expect("exact parent signal");
        assert!(launched.get());
    }

    #[cfg(windows)]
    #[test]
    fn windows_provider_bridge_is_gated_before_job_assignment() {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "exit 0"]);
        let _gate = configure_ai_process_group(&mut command)
            .expect("configure wrapper")
            .expect("Windows gate");
        let args = command.get_args().collect::<Vec<_>>();
        assert_eq!(args[0], std::ffi::OsStr::new(PROVIDER_WRAPPER_ARG));
        assert_eq!(args[3], std::ffi::OsStr::new("cmd.exe"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_object_kills_descendant_after_bridge_exit() {
        let secret = [9_u8; 32];
        let gate = create_provider_launch_gate(secret).expect("loopback launch gate");
        let address = gate
            .listener
            .local_addr()
            .expect("gate address")
            .to_string();
        let wrapper = thread::spawn(move || connect_provider_launch_gate(&address, &secret));
        let mut command = Command::new("cmd.exe");
        command
            .args([
                "/D",
                "/S",
                "/C",
                "ping -n 2 127.0.0.1 >nul & start \"\" /B cmd.exe /D /S /C \"ping -n 30 127.0.0.1\"",
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let mut child = command.spawn().expect("spawn delayed bridge");
        let mut tree = track_ai_process_tree(&mut child, Some(gate)).expect("assign job");
        assert_eq!(
            wrapper.join().expect("wrapper").expect("release"),
            PROVIDER_WRAPPER_RELEASE_TOKEN
        );
        let mut stream = child.stdout.take().expect("bridge stdout");
        let reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child.try_wait().expect("poll bridge").is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "Windows bridge did not exit");
            thread::sleep(Duration::from_millis(10));
        }
        cleanup_ai_process_tree_after_bridge_exit(&mut tree).expect("terminate retained job");
        join_output_readers_bounded(vec![reader], Duration::from_secs(2))
            .expect("descendant inherited pipe closed");
    }
    use crate::ai::antigravity::antigravity_generate_prompt;
    use crate::ai::codex::codex_direct_generate_prompt;
    use crate::ai::director::PAINTNODE_DIRECTOR_ACTION_FILE;

    #[test]
    fn temp_job_dir_removes_directory_on_drop() {
        let path = {
            let job = TempJobDir::new("paintnode-test").expect("temp dir");
            let marker = job.path().join("marker.txt");
            fs::write(&marker, b"ok").expect("write marker");
            assert!(marker.exists());
            job.path().to_path_buf()
        };

        assert!(!path.exists());
    }

    #[test]
    fn codex_progress_message_maps_json_events() {
        let message = provider_progress_message(r#"{"type":"turn.started"}"#, false, "Codex")
            .expect("turn event should map to progress");
        assert_eq!(message, "Codex is working on the image");

        let message = provider_progress_message(
            r#"{"type":"item.started","item":{"type":"image_generation_call","name":"imagegen"}}"#,
            false,
            "Codex",
        )
        .expect("image event should map to progress");
        assert_eq!(message, "Generating image with Codex");

        let message = provider_progress_message(
            r#"{"type":"item.completed","item":{"type":"image_generation_call","name":"imagegen"}}"#,
            false,
            "Codex",
        )
        .expect("completed image event should map to progress");
        assert_eq!(
            message,
            "Image generation step completed; waiting for Codex"
        );

        let message = provider_progress_message(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"I’ll keep this as a preview/cache generation only, so I won’t touch the workspace. I’m also phrasing the person as a clearly adult young woman."}}"#,
            false,
            "Codex",
        )
        .expect("agent message should map to progress");
        assert!(message.starts_with("Codex:"));
        assert!(message.contains("preview/cache generation"));
    }

    #[test]
    fn codex_progress_message_sanitizes_plain_text() {
        let message = provider_progress_message("  generating image\n", true, "Codex")
            .expect("stderr line should map to progress");
        assert_eq!(message, "generating image");
    }

    #[test]
    fn provider_progress_message_hides_internal_run_dir_names() {
        let message = provider_progress_message(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"I will list the codex-runs directory to see whether result.png exists."}}"#,
            false,
            "Antigravity",
        )
        .expect("agent message should map to progress");

        assert_eq!(
            message,
            "Antigravity: I will list the job folder to see whether result.png exists."
        );
        assert!(!message.contains("codex-runs"));
    }

    #[test]
    fn generate_image_prompts_do_not_expose_canvas_geometry() {
        let codex = codex_direct_generate_prompt("make an image", &[]);
        assert!(codex.contains("Generate exactly one raster PNG for PaintNode"));
        assert!(codex.contains("User image prompt:\nmake an image"));
        assert!(!codex.contains("$imagegen"));
        assert!(!codex.contains("generated-images cache"));
        assert!(!codex.contains("1280x800"));
        assert!(!codex.contains("1296x864"));
        assert!(!codex.contains("Working PNG"));
        assert!(!codex.contains("Document rectangle"));
        assert!(!codex.contains("chroma"));
        assert!(!codex.contains("#00ff00"));

        let antigravity = antigravity_generate_prompt(
            "make an image",
            "paintnode/antigravity-runs/job-1",
            AiAutonomyLevel::Low,
            &[],
        );
        assert!(antigravity.contains("Generate one raster PNG for PaintNode"));
        assert!(antigravity.contains("User image prompt:\nmake an image"));
        assert!(antigravity.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(antigravity.contains("PaintNode Director tool loop"));
        assert!(!antigravity.contains("Save the final image as"));
        assert!(!antigravity.contains("1280x800"));
        assert!(!antigravity.contains("1296x864"));
        assert!(!antigravity.contains("Working PNG"));
        assert!(!antigravity.contains("Document rectangle"));
        assert!(!antigravity.contains("chroma"));
        assert!(!antigravity.contains("#00ff00"));
    }

    #[test]
    fn codex_thread_id_from_line_extracts_thread_started_event() {
        let thread_id = codex_thread_id_from_line(
            r#"{"type":"thread.started","thread_id":"019ef9e6-cc0a-79b3-9464-c2d16354e957"}"#,
        )
        .expect("thread id");
        assert_eq!(thread_id, "019ef9e6-cc0a-79b3-9464-c2d16354e957");
        assert!(codex_thread_id_from_line(r#"{"type":"turn.started"}"#).is_none());
    }

    #[test]
    fn provider_feature_negotiation_reports_transport_specific_gaps() {
        let codex = ai_provider_features(AiDirectorProvider::Codex);
        let claude = ai_provider_features(AiDirectorProvider::Claude);
        let antigravity = ai_provider_features(AiDirectorProvider::Antigravity);

        assert_eq!(codex.transport, "sdk");
        assert!(codex.structured_output);
        assert!(!codex.managed_subagents);
        assert!(claude.managed_subagents);
        assert!(claude.structured_progress);
        assert_eq!(antigravity.transport, "cli");
        assert!(antigravity.session_reuse);
        assert!(antigravity.app_mediated_user_input);
        assert!(antigravity.autonomous_subagents);
        assert!(!antigravity.structured_output);
        assert!(!antigravity.structured_progress);
    }

    #[test]
    fn provider_progress_update_preserves_structured_subagent_event() {
        let update = provider_progress_update(
            r#"{"type":"provider.progress","kind":"subagentStarted","message":"Reviewing candidate","detail":"image-reviewer"}"#,
            false,
            "Claude",
        )
        .expect("progress update");

        assert_eq!(update.kind, "subagentStarted");
        assert_eq!(update.message, "Reviewing candidate");
        assert_eq!(update.detail.as_deref(), Some("image-reviewer"));
    }

    #[test]
    fn project_agent_job_paths_are_visible_and_vendor_specific() {
        let project = TempJobDir::new("paintnode-visible-agent-job-test").expect("project dir");
        let codex_job = project_agent_run_dir(project.path(), CODEX_RUNS_DIR, "codex-retouch")
            .expect("codex job");
        let antigravity_job =
            project_agent_run_dir(project.path(), ANTIGRAVITY_RUNS_DIR, "antigravity-retouch")
                .expect("antigravity job");

        for (job_path, vendor_dir) in [
            (codex_job.as_path(), CODEX_RUNS_DIR),
            (antigravity_job.as_path(), ANTIGRAVITY_RUNS_DIR),
        ] {
            let relative = job_path
                .strip_prefix(project.path())
                .expect("relative job path");
            let mut components = relative.components();
            let first_component = components.next().expect("work dir component");
            let first_name = first_component.as_os_str().to_string_lossy();
            let second_component = components.next().expect("vendor dir component");
            let second_name = second_component.as_os_str().to_string_lossy();

            assert_eq!(first_name, PAINTNODE_WORK_DIR);
            assert!(!first_name.starts_with('.'));
            assert_eq!(second_name, vendor_dir);
            assert!(!second_name.starts_with('.'));
        }
    }

    #[test]
    fn project_job_helpers_trim_paths_and_respect_keep_flag() {
        let project = Some("  /tmp/PaintNode Project  ".to_string());
        assert_eq!(
            optional_project_dir(&project),
            Some(PathBuf::from("/tmp/PaintNode Project"))
        );
        assert!(optional_project_dir(&Some("   ".to_string())).is_none());
        assert!(optional_project_dir(&None).is_none());

        let project_dir = Some(PathBuf::from("/tmp/PaintNode Project"));
        assert!(cleanup_project_job_enabled(&project_dir, false));
        assert!(!cleanup_project_job_enabled(&project_dir, true));
        assert!(!cleanup_project_job_enabled(&None, false));
    }

    #[test]
    fn ai_cli_path_includes_common_gui_missing_tool_dirs() {
        let path = ai_cli_path();
        let entries: Vec<String> = std::env::split_paths(&path)
            .map(|entry| entry.to_string_lossy().to_string())
            .collect();

        assert!(entries.contains(&"/opt/homebrew/bin".to_string()));
        assert!(entries.contains(&"/usr/local/bin".to_string()));
        assert!(entries.contains(&"/usr/bin".to_string()));
        assert!(entries.contains(&"/bin".to_string()));
    }

    #[test]
    fn decouple_manifest_reads_optional_alpha_mask() {
        let manifest: DecoupleManifest = serde_json::from_str(
            r#"{
              "assets": [
                {
                  "name": "Rope railing",
                  "file": "rope.png",
                  "alphaMask": "rope-mask.png",
                  "keyColor": null,
                  "x": 0,
                  "y": 0,
                  "opacity": 1,
                  "visible": true
                }
              ],
              "notes": "mask used for soft rope edges"
            }"#,
        )
        .expect("manifest should parse");

        assert_eq!(
            manifest.layers[0].alpha_mask.as_deref(),
            Some("rope-mask.png")
        );
    }

    #[test]
    fn decouple_manifest_accepts_legacy_layers_key() {
        let manifest: DecoupleManifest = serde_json::from_str(
            r#"{
              "layers": [
                {
                  "name": "Girl",
                  "file": "girl.png",
                  "alphaMask": null,
                  "keyColor": null,
                  "x": 0,
                  "y": 0,
                  "opacity": 1,
                  "visible": true
                }
              ]
            }"#,
        )
        .expect("legacy manifest should parse");

        assert_eq!(manifest.layers.len(), 1);
        assert_eq!(manifest.layers[0].name, "Girl");
    }

    #[test]
    fn fallback_decouple_manifest_uses_asset_pngs_and_skips_debug_outputs() {
        let job = TempJobDir::new("paintnode-decouple-fallback-test").expect("temp dir");
        let png = crate::test_util::test_rgba_png(1, 1, &[[20, 40, 80, 255]]);
        for name in [
            "source.png",
            "background.png",
            "bag.png",
            "computer.png",
            "girl.png",
            "guide.png",
            "girl-mask.png",
            "lunchbox.png",
        ] {
            fs::write(job.path().join(name), &png).expect("write test png");
        }

        let count = synthesize_decouple_asset_manifest(job.path())
            .expect("synthesize manifest")
            .expect("fallback assets");
        assert_eq!(count, 5);

        let manifest_text =
            fs::read_to_string(job.path().join("manifest.json")).expect("read manifest");
        let manifest: DecoupleManifest =
            serde_json::from_str(&manifest_text).expect("manifest parses");
        let names = manifest
            .layers
            .iter()
            .map(|layer| layer.name.as_str())
            .collect::<Vec<_>>();
        let files = manifest
            .layers
            .iter()
            .map(|layer| layer.file.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec!["Background", "Bag", "Computer", "Girl", "Lunchbox"]
        );
        assert_eq!(
            files,
            vec![
                "background.png",
                "bag.png",
                "computer.png",
                "girl.png",
                "lunchbox.png"
            ]
        );
        assert!(manifest
            .notes
            .as_deref()
            .unwrap_or("")
            .contains("synthesized"));
    }
}
