//! Project files, automatic backups and recent projects, in the same layout as
//! the MCP server's node/store.js (~/.cutroom/state.json, ~/.cutroom/backups).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::host::{data_dir, mtime_ms, sha1_hex};

pub const PROJECT_EXT: &str = ".cutroom.json";
const BACKUP_EVERY: Duration = Duration::from_secs(5 * 60);
const BACKUPS_KEPT: usize = 30;

pub fn absolute(path: &str) -> String {
    std::path::absolute(path).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.to_string())
}

fn backups_dir(project: &str) -> PathBuf {
    data_dir().join("backups").join(&sha1_hex(&absolute(project).to_lowercase())[..16])
}

/// "2026-10-26T07-34-15-134Z", like the Node side's toISOString().
pub fn stamp() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (now.as_secs() as i64, now.subsec_millis());
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}-{ms:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn backup_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|it| it.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.to_string_lossy().ends_with(PROJECT_EXT)).collect())
        .unwrap_or_default();
    files.sort();
    files
}

// Keep the version about to be overwritten if the newest backup is old
// enough. A failed backup never blocks the save itself.
fn backup_before_save(path: &str, next: &str) {
    let Ok(prev) = std::fs::read_to_string(path) else { return };
    if prev == next {
        return;
    }
    let dir = backups_dir(path);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let files = backup_files(&dir);
    if let Some(newest) = files.last() {
        let age = std::fs::metadata(newest).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
        if age.is_some_and(|a| a < BACKUP_EVERY) {
            return;
        }
    }
    let _ = std::fs::write(dir.join(format!("{}{PROJECT_EXT}", stamp())), &prev);
    let _ = std::fs::write(dir.join("source.txt"), absolute(path));
    for old in files.iter().take((files.len() + 1).saturating_sub(BACKUPS_KEPT)) {
        let _ = std::fs::remove_file(old);
    }
}

/// Save atomically (temp file + rename), so an agent editing the same project
/// never reads half a file. Returns the text written.
pub fn save(path: &str, project: &Value) -> Result<String, String> {
    let text = format!("{}\n", serde_json::to_string_pretty(project).map_err(|e| e.to_string())?);
    if let Some(dir) = Path::new(path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    backup_before_save(path, &text);
    let tmp = format!("{path}.{}.tmp", std::process::id());
    std::fs::write(&tmp, &text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(text)
}

pub struct Backup {
    pub file: String,
    pub time_ms: f64,
    pub clips: usize,
}

pub fn backups(path: &str) -> Vec<Backup> {
    backup_files(&backups_dir(path))
        .into_iter()
        .rev()
        .map(|file| {
            let time_ms = std::fs::metadata(&file).map(|m| mtime_ms(&m)).unwrap_or(0.0);
            let clips = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|p| p["clips"].as_array().map(Vec::len)).unwrap_or(0);
            Backup { file: file.to_string_lossy().into_owned(), time_ms, clips }
        })
        .collect()
}

/// Replace a project with one of its backups; the current version is backed
/// up first.
pub fn restore(path: &str, file: &str) -> Result<(), String> {
    let dir = backups_dir(path);
    if !Path::new(file).starts_with(&dir) {
        return Err("That backup belongs to a different project".into());
    }
    let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    if let Ok(current) = std::fs::read_to_string(path) {
        std::fs::write(dir.join(format!("{}-before-restore{PROJECT_EXT}", stamp())), current).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, text).map_err(|e| e.to_string())
}

pub fn read_state() -> Value {
    std::fs::read_to_string(data_dir().join("state.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

pub fn write_state(patch: Value) {
    let mut state = read_state();
    if let (Some(s), Some(p)) = (state.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            s.insert(k.clone(), v.clone());
        }
    }
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(data_dir().join("state.json"), serde_json::to_string_pretty(&state).unwrap_or_default());
}

// One recent-projects entry per file, however its path was written.
fn key(p: &str) -> String {
    absolute(p).replace('/', "\\").to_lowercase()
}

pub fn recent() -> Vec<String> {
    let state = read_state();
    let mut seen = std::collections::HashSet::new();
    state["recentProjects"].as_array().into_iter().flatten().chain(state["lastProject"].as_str().map(|_| &state["lastProject"])).filter_map(Value::as_str).filter(|p| seen.insert(key(p))).map(String::from).collect()
}

pub fn remember(path: &str) {
    let full = absolute(path);
    let mut list: Vec<String> = recent().into_iter().filter(|p| key(p) != key(&full)).collect();
    list.insert(0, full.clone());
    list.truncate(40);
    write_state(json!({ "lastProject": full, "recentProjects": list }));
}

pub fn forget(path: &str) {
    let list: Vec<String> = recent().into_iter().filter(|p| key(p) != key(path)).collect();
    let mut patch = json!({ "recentProjects": list });
    if read_state()["lastProject"].as_str().is_some_and(|l| key(l) == key(path)) {
        patch["lastProject"] = Value::Null;
    }
    write_state(patch);
}
