//! What the engine needs from the computer: tool locations, running FFmpeg and
//! Python with live output, waveform peaks, and files. Everything blocks; the
//! app calls the engine from worker threads.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha1::{Digest, Sha1};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub python: String,
    pub stem_python: String,
    pub stem_models: Option<String>,
    pub whisper_model: Option<String>,
    pub scripts_dir: String,
    pub cache_dir: String,
    pub tmp_dir: String,
}

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

/// ~/.cutroom: state, backups and caches, shared with the MCP server.
pub fn data_dir() -> PathBuf {
    home().join(".cutroom")
}

fn s(p: impl AsRef<Path>) -> String {
    p.as_ref().to_string_lossy().into_owned()
}

impl Tools {
    /// Bundled copies next to the exe win over PATH; env vars win over both.
    /// From a dev build the repo's vendor/ and scripts/ are used.
    pub fn locate() -> Tools {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let find = |rel: &str| [exe_dir.join(rel), repo.join("vendor").join(rel)].into_iter().find(|p| p.exists()).map(s);
        let python = env("CUTROOM_PYTHON").unwrap_or_else(|| "python".into());
        let edit_venv = home().join(".cache").join("edit-venv").join("Scripts").join("python.exe");
        Tools {
            ffmpeg: env("CUTROOM_FFMPEG").or_else(|| find("ffmpeg/ffmpeg.exe")).unwrap_or_else(|| "ffmpeg".into()),
            ffprobe: env("CUTROOM_FFPROBE").or_else(|| find("ffmpeg/ffprobe.exe")).unwrap_or_else(|| "ffprobe".into()),
            stem_python: env("CUTROOM_STEM_PYTHON").or_else(|| edit_venv.exists().then(|| s(&edit_venv))).unwrap_or_else(|| python.clone()),
            python,
            stem_models: env("CUTROOM_STEM_MODELS"),
            whisper_model: env("CUTROOM_WHISPER_MODEL"),
            scripts_dir: [exe_dir.join("scripts"), repo.join("scripts")].into_iter().find(|p| p.exists()).map(s).unwrap_or_default(),
            cache_dir: env("CUTROOM_CACHE").unwrap_or_else(|| s(data_dir().join("cache"))),
            tmp_dir: s(std::env::temp_dir().join("cutroom")),
        }
    }
}

pub fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes
    }
    cmd
}

pub fn spawn_error(program: &str, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("{program} was not found. Install it, or set CUTROOM_FFMPEG / CUTROOM_PYTHON.")
    } else {
        e.to_string()
    }
}

#[derive(Serialize)]
pub struct RunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run a program to completion, handing stdout to `on_stdout` as it arrives.
/// Setting `cancel` kills it at the next output (FFmpeg -progress and the
/// Python scripts report often).
pub fn run(program: &str, args: &[String], env: &[(String, String)], mut on_stdout: impl FnMut(&str), cancel: &AtomicBool) -> Result<RunResult, String> {
    let mut child = command(program).args(args).envs(env.iter().map(|(k, v)| (k, v))).spawn().map_err(|e| spawn_error(program, e))?;
    let mut out = child.stdout.take().expect("piped stdout");
    let mut errs = child.stderr.take().expect("piped stderr");
    let err_thread = std::thread::spawn(move || {
        let (mut all, mut buf) = (Vec::new(), vec![0u8; 64 * 1024]);
        while let Ok(n @ 1..) = errs.read(&mut buf) {
            all.extend_from_slice(&buf[..n]);
            if all.len() > 2 << 20 {
                all.drain(..all.len() - (1 << 20)); // keep the tail, where errors are
            }
        }
        all
    });
    let (mut stdout, mut buf) = (Vec::new(), vec![0u8; 64 * 1024]);
    while let Ok(n @ 1..) = out.read(&mut buf) {
        on_stdout(&String::from_utf8_lossy(&buf[..n]));
        if stdout.len() < 64 << 20 {
            stdout.extend_from_slice(&buf[..n]);
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            break;
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = err_thread.join().unwrap_or_default();
    Ok(RunResult { code: status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&stdout).into_owned(), stderr: String::from_utf8_lossy(&stderr).into_owned() })
}

/// Waveform envelope of one audio stream: the loudest sample in each
/// 1/`per_second` s as 0-255, from an 8 kHz mono decode.
pub fn peaks(ffmpeg: &str, path: &str, per_second: u32, stream: u32) -> Result<Vec<u8>, String> {
    let map = format!("0:a:{stream}");
    let mut child = command(ffmpeg)
        .args(["-hide_banner", "-nostats", "-loglevel", "error", "-i", path, "-map", &map, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"])
        .spawn()
        .map_err(|e| spawn_error(ffmpeg, e))?;
    let mut errs = child.stderr.take().expect("piped stderr");
    let err_thread = std::thread::spawn(move || {
        let mut all = String::new();
        let _ = errs.read_to_string(&mut all);
        all
    });
    let mut out = child.stdout.take().expect("piped stdout");
    let bucket = (8000 / per_second.max(1)).max(1) as usize;
    let (mut result, mut pending, mut buf) = (Vec::new(), Vec::new(), vec![0u8; 64 * 1024]);
    let (mut max, mut count) = (0u32, 0usize);
    while let Ok(n @ 1..) = out.read(&mut buf) {
        pending.extend_from_slice(&buf[..n]);
        let usable = pending.len() & !1;
        for pair in pending[..usable].chunks_exact(2) {
            max = max.max(i16::from_le_bytes([pair[0], pair[1]]).unsigned_abs() as u32);
            count += 1;
            if count == bucket {
                result.push(((max * 255 + 16384) / 32768).min(255) as u8);
                (max, count) = (0, 0);
            }
        }
        pending.drain(..usable);
    }
    if !child.wait().map_err(|e| e.to_string())?.success() {
        return Err(format!("Waveform failed: {}", err_thread.join().unwrap_or_default().trim()));
    }
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub size: u64,
    pub mtime_ms: f64,
}

/// Same formula as Node's mtimeMs, so cache keys match the MCP server's.
pub fn mtime_ms(m: &std::fs::Metadata) -> f64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6).unwrap_or(0.0)
}

pub fn stat(path: &str) -> Option<Stat> {
    std::fs::metadata(path).ok().map(|m| Stat { size: m.len(), mtime_ms: mtime_ms(&m) })
}

pub fn remove(path: &str) -> std::io::Result<()> {
    let p = Path::new(path);
    if p.is_dir() {
        std::fs::remove_dir_all(p)
    } else if p.exists() {
        std::fs::remove_file(p)
    } else {
        Ok(())
    }
}

/// A new empty folder named `prefix` + a unique suffix (like mkdtemp).
pub fn mkdtemp(prefix: &str) -> std::io::Result<String> {
    let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    for i in 0..1000u32 {
        let dir = format!("{prefix}{nanos:x}{i}");
        if std::fs::create_dir(&dir).is_ok() {
            return Ok(dir);
        }
    }
    Err(std::io::Error::other(format!("could not create a temp folder at {prefix}")))
}

pub fn sha1_hex(text: &str) -> String {
    format!("{:x}", Sha1::digest(text.as_bytes()))
}
