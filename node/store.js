// Project files on disk. Writes are atomic (temp file + rename) so the app's
// file watcher and an agent editing the same project never see half a file.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { normalizeProject } from "../core/model.js";

export const STATE_FILE = join(homedir(), ".cutroom", "state.json");
export const PROJECT_EXT = ".cutroom.json";

export function loadProject(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return normalizeProject(raw);
}

export function saveProject(path, project) {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(project, null, 2)}\n`;
  backupBeforeSave(path, text);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return text;
}

// ---- backups: earlier versions of a project, kept automatically.

export const BACKUP_ROOT = join(homedir(), ".cutroom", "backups");
const BACKUP_EVERY_MS = 5 * 60 * 1000;
const BACKUPS_KEPT = 30;

const backupDir = (path) => join(BACKUP_ROOT, createHash("sha1").update(resolve(path).toLowerCase()).digest("hex").slice(0, 16));

// Keep the version about to be overwritten if the newest backup is old enough.
function backupBeforeSave(path, nextText) {
  try {
    if (!existsSync(path)) return;
    const prev = readFileSync(path, "utf8");
    if (prev === nextText) return;
    const dir = backupDir(path);
    mkdirSync(dir, { recursive: true });
    const files = readdirSync(dir).filter((f) => f.endsWith(PROJECT_EXT)).sort();
    const newest = files[files.length - 1];
    if (newest && Date.now() - statSync(join(dir, newest)).mtimeMs < BACKUP_EVERY_MS) return;
    writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}${PROJECT_EXT}`), prev);
    writeFileSync(join(dir, "source.txt"), resolve(path));
    for (const old of files.slice(0, Math.max(0, files.length + 1 - BACKUPS_KEPT))) rmSync(join(dir, old), { force: true });
  } catch {
    // A failed backup must never block saving the project itself.
  }
}

export function listBackups(path) {
  const dir = backupDir(path);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(PROJECT_EXT))
    .sort()
    .reverse()
    .map((f) => {
      const file = join(dir, f);
      let summary = {};
      try {
        const p = normalizeProject(JSON.parse(readFileSync(file, "utf8")));
        summary = { name: p.name, clips: p.clips.length, duration: p.clips.reduce((e, c) => Math.max(e, c.start + (c.out - c.in) / (c.speed || 1)), 0) };
      } catch {
        // unreadable backups are still listed
      }
      return { file, time: statSync(file).mtimeMs, ...summary };
    });
}

// Replace the project with a backup (the current version is backed up first).
export function restoreBackup(path, file) {
  if (!file.startsWith(backupDir(path))) throw new Error("That backup belongs to a different project");
  const project = normalizeProject(JSON.parse(readFileSync(file, "utf8")));
  const dir = backupDir(path);
  if (existsSync(path)) writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-before-restore${PROJECT_EXT}`), readFileSync(path, "utf8"));
  const text = `${JSON.stringify(project, null, 2)}\n`;
  writeFileSync(path, text);
  return project;
}

// Call `onChange(project)` when the file changes on disk with content that
// differs from `lastText()` (our own writes are ignored that way).
export function watchProject(path, onChange, lastText) {
  let timer = null;
  const name = basename(path);
  const watcher = watch(dirname(path), (event, file) => {
    if (file !== name) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        if (!existsSync(path)) return;
        const text = readFileSync(path, "utf8");
        if (text === lastText()) return;
        onChange(normalizeProject(JSON.parse(text)), text);
      } catch {
        // Mid-write or invalid JSON; the next change event will retry.
      }
    }, 120);
  });
  return () => watcher.close();
}

export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeState(patch) {
  const next = { ...readState(), ...patch };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}
