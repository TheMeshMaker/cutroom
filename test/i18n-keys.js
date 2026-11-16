// Every English string the app can show: interface text, catalog names,
// default track/media names and the engine's own messages and errors.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(fileURLToPath(import.meta.url), "..", "..");
export const read = (p) => readFileSync(join(root, p), "utf8");
const files = (dir, ext) => readdirSync(join(root, dir), { recursive: true }).filter((f) => f.endsWith(ext)).map((f) => join(dir, f));

export function englishStrings() {
  // Test code (after #[cfg(test)]) holds sample strings, not interface text.
  const rust = files("native/src", ".rs").map((f) => read(f).split("#[cfg(test)]")[0]).join("\n");
  const keys = new Set();
  const add = (re, src) => { for (const m of src.matchAll(re)) keys.add(m[1]); };
  add(/\bt\(\s*(?:lang|ed\.lang|self\.lang|app\.lang|l)\s*,\s*"([^"]+)"/g, rust);
  add(/\(\s*"[^"]*"\s*,\s*"([A-Z][^"]*)"\s*\)/g, rust); // ("value", "Label") chips
  add(/\(\s*[A-Za-z:]+\s*,\s*"([A-Z][^"]*)"\s*\)/g, rust); // (Panel::X, "Label")
  add(/\(\s*Some\("[^"]*"\)\s*,\s*"([A-Z][^"]*)"\s*\)/g, rust);
  add(/Message::Flow\([^;]*?"([A-Z][^"]*…)"\)/g, rust);
  add(/plural\(\s*lang\s*,[^,]+,\s*"([^"]+)"/g, rust);
  add(/plural\(\s*lang\s*,[^,]+,\s*"[^"]+"\s*,\s*"([^"]+)"/g, rust);
  add(/\(\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"([A-Z][^"]*)"\s*,\s*"[^"]*"\s*\)/g, rust); // sticker shapes
  // The engine's messages, with ${…} values as {0}, {1}…
  for (const f of [...files("core", ".js"), ...files("engine", ".js")]) {
    const src = read(f);
    for (const m of src.matchAll(/(?:throw new Error\(|note: )(?:"([^"]*)"|`([^`]*)`)/g)) {
      let i = 0;
      keys.add((m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, () => `{${i++}}`));
    }
  }
  const catalog = read("core/catalog.js");
  for (const m of catalog.matchAll(/name: "([^"]+)"/g)) if (!/[؀-ۿ]/.test(m[1])) keys.add(m[1]);
  for (const m of read("core/ops.js").matchAll(/label: "([^"]+)"/g)) keys.add(m[1]);
  // Default names the engine gives tracks and media.
  for (const k of ["Audio {0}", "Video {0}", "Text {0}", "Captions", "Stickers", "Adjustment", "Sticker {0}", "Voice: {0}", "Voice ({0})", "Game & effects ({0})", "Music ({0})"]) keys.add(k);
  // Codec names are the same everywhere.
  for (const k of ["H.264 (MP4)", "HEVC (MP4)", "AV1 (MP4)", "ProRes (MOV)", "LUT: {0}"]) keys.delete(k);
  return [...keys].sort();
}

