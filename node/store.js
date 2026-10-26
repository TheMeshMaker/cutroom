// Project files on disk. Writes are atomic (temp file + rename) so the app's
// file watcher and an agent editing the same project never see half a file.

import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return text;
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
