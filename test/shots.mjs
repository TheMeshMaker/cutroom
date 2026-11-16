// Screenshot checks of the native app (replaces the old browser smoke tests):
// opens a copy of the smoke project off-screen, drives it with --do steps and
// saves one PNG per scenario to test/out/shots, and fails on any error the app logs.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./fixtures.js";

const target = join(OUT, "..", "..", "native", "target");
const exe = [join(target, "release", "cutroom.exe"), join(target, "debug", "cutroom.exe")].find(existsSync);
if (!exe) throw new Error("Build the app first: npm run dist (or cargo build in native/)");
const dir = join(OUT, "shots");
mkdirSync(dir, { recursive: true });
const project = join(dir, "check.cutroom.json");
copyFileSync(join(OUT, "smoke-copy.cutroom.json"), project);
const scenarios = {
  "text-video": "a-text,select,video",
  "filters-color": "a-filters,select,color",
  "transitions-anim": "a-transitions,select,anim",
  "captions-audio": "a-captions,select,audio",
  "speed": "a-effects,select,speed",
  "stickers": "a-stickers,select,color",
  "project": "a-adjust",
  "editing": "select,split|undo|redo|select,dup|undo|select,copy,paste|del|undo|select,ripple|undo|play|select,dup|undo|a-stickers,sticker|a-text,add-text|undo,undo",
};
for (const [name, steps] of Object.entries(scenarios)) {
  for (const lang of ["en", "ar"]) {
    copyFileSync(join(OUT, "smoke-copy.cutroom.json"), project);
    const wait = 4000 + 1500 * steps.split("|").length + 4000;
    const r = spawnSync(exe, [`--project=${project}`, `--lang=${lang}`, `--do=${steps}`, `--shot-after=${wait}`, "--shot-size=1600x2400", `--shot=${join(dir, `${name}-${lang}.png`)}`], { env: { ...process.env, CUTROOM_SILENT: "1" }, timeout: wait + 60000 });
    const errors = String(r.stderr ?? "").split(/\r?\n/).filter((l) => /error|panicked|unknown --do/i.test(l));
    console.log(name, lang, r.status === 0 && !errors.length ? "ok" : `FAILED ${r.status ?? r.error} ${errors.join(" | ")}`);
    if (r.status !== 0 || errors.length) process.exitCode = 1;
  }
}
