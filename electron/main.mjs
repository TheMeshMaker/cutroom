import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { importCapcutDraft } from "../core/capcut-import.js";
import { createProject } from "../core/model.js";
import { transcribe } from "../node/captions.js";
import { availableEncoders, renderAudio, renderFrame, renderProject } from "../node/exporter.js";
import { detectSilence, ensureProxy, extractFrame, filmstrip, makeReversed, probe, waveform } from "../node/media.js";
import { loadProject, PROJECT_EXT, readState, saveProject, watchProject, writeState } from "../node/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const SMOKE = argv.includes("--smoke");
const CAPCUT_DRAFTS = join(process.env.LOCALAPPDATA ?? homedir(), "CapCut", "User Data", "Projects", "com.lveditor.draft");
const PREVIEW_DIR = join(tmpdir(), "cutroom", "preview");

protocol.registerSchemesAsPrivileged([
  { scheme: "cutroom-media", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win = null;
let current = { path: null, lastText: "", unwatch: null };
const jobs = new Map();

const MIME = { ".mp4": "video/mp4", ".m4a": "audio/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".webm": "video/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

// Serve local files to the preview with HTTP Range support (needed for seeking).
function serveMedia(request) {
  const path = decodeURIComponent(new URL(request.url).pathname.slice(1));
  if (!existsSync(path)) return new Response("Not found", { status: 404 });
  const size = statSync(path).size;
  const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") ?? "");
  if (!range) {
    return new Response(Readable.toWeb(createReadStream(path)), { status: 200, headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" } });
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  return new Response(Readable.toWeb(createReadStream(path, { start, end })), {
    status: 206,
    headers: { "Content-Type": type, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes" },
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function openProjectFile(path) {
  current.unwatch?.();
  const project = loadProject(path);
  current = { path, lastText: readFileSync(path, "utf8"), unwatch: null };
  current.unwatch = watchProject(
    path,
    (next, text) => {
      current.lastText = text;
      send("project:external", next);
    },
    () => current.lastText,
  );
  writeState({ lastProject: path });
  win?.setTitle(`${project.name} - Cutroom`);
  return { path, project };
}

function saveTo(path, project) {
  current.lastText = saveProject(path, project);
  return true;
}

async function askSavePath(title, defaultName) {
  const r = await dialog.showSaveDialog(win, {
    title,
    defaultPath: join(app.getPath("videos"), defaultName),
    filters: [{ name: "Cutroom project", extensions: ["cutroom.json"] }],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath.endsWith(PROJECT_EXT) ? r.filePath : r.filePath.replace(/(\.json)?$/, PROJECT_EXT);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

// Long tasks report progress on "job:progress" with their kind and id.
function job(kind, id, fn) {
  return fn((p) => send("job:progress", { kind, id, p }));
}

handle("app:initial", () => {
  const explicit = flag("project");
  const last = readState().lastProject;
  const path = explicit ?? (last && existsSync(last) ? last : null);
  return path ? openProjectFile(path) : null;
});

handle("project:new", async ({ name = "Untitled", canvas = "1080p" } = {}) => {
  const path = await askSavePath("New project", `${name}${PROJECT_EXT}`);
  if (!path) return null;
  saveTo(path, createProject({ name, canvas }));
  return openProjectFile(path);
});

handle("project:open", async (path) => {
  let target = path;
  if (!target) {
    const r = await dialog.showOpenDialog(win, { title: "Open project", filters: [{ name: "Cutroom project", extensions: ["json"] }], properties: ["openFile"] });
    if (r.canceled) return null;
    target = r.filePaths[0];
  }
  return openProjectFile(target);
});

handle("project:save", (path, project) => saveTo(path, project));

handle("capcut:import", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose a CapCut draft_content.json",
    defaultPath: existsSync(CAPCUT_DRAFTS) ? CAPCUT_DRAFTS : undefined,
    filters: [{ name: "CapCut draft", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (r.canceled) return null;
  const { project, warnings } = importCapcutDraft(JSON.parse(readFileSync(r.filePaths[0], "utf8")));
  const path = await askSavePath("Save imported project", `${project.name}${PROJECT_EXT}`);
  if (!path) return null;
  saveTo(path, project);
  return { ...openProjectFile(path), warnings };
});

handle("media:import", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Import media",
    filters: [{ name: "Media", extensions: ["mp4", "mkv", "mov", "webm", "avi", "m4v", "wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "png", "jpg", "jpeg", "webp"] }],
    properties: ["openFile", "multiSelections"],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map((p) => probe(p)));
});

handle("lut:choose", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Import LUT", filters: [{ name: "3D LUT", extensions: ["cube", "3dl", "dat"] }], properties: ["openFile"] });
  return r.canceled ? null : r.filePaths[0];
});

handle("media:probe", (path) => probe(path));
handle("media:proxy", (media) => ensureProxy(media, { onProgress: (p) => send("proxy:progress", { mediaId: media.id, p }) }));
handle("media:waveform", (media) => waveform(media));
handle("media:filmstrip", (media, source) => filmstrip(media, { source }));
handle("media:silence", (media, opts) => detectSilence(media, opts));
handle("media:reverse", (media, inn, out, id) => job("reverse", id, (onProgress) => makeReversed(media, inn, out, { onProgress })));
handle("media:freeze", (media, time) => extractFrame(media, time));
handle("captions:transcribe", (media, opts, id) => job("captions", id, (onProgress) => transcribe(media, { ...opts, onProgress })));
handle("encoders:list", () => availableEncoders());

let previewSeq = 0;
handle("frame:preview", async (project, time, width) => {
  mkdirSync(PREVIEW_DIR, { recursive: true });
  const out = join(PREVIEW_DIR, `f${previewSeq++ % 8}.jpg`);
  await renderFrame(project, time, out, { previewWidth: width });
  return out;
});

handle("audio:snippet", async (project, range) => {
  mkdirSync(PREVIEW_DIR, { recursive: true });
  return renderAudio(project, range, join(PREVIEW_DIR, `a${previewSeq++ % 4}.m4a`));
});

handle("export:start", async (project, opts = {}) => {
  let outPath = opts.outPath;
  if (!outPath) {
    const ext = opts.codec === "prores" ? "mov" : "mp4";
    const r = await dialog.showSaveDialog(win, {
      title: "Export video",
      defaultPath: join(current.path ? dirname(current.path) : app.getPath("videos"), `${opts.name || project.name}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return null;
    outPath = r.filePath;
  }
  const id = `job_${Date.now()}`;
  const controller = new AbortController();
  jobs.set(id, controller);
  send("export:started", { id, outPath });
  try {
    return await renderProject(project, { ...opts, outPath, signal: controller.signal, onProgress: (p) => send("export:progress", { id, p }) });
  } finally {
    jobs.delete(id);
  }
});

handle("export:cancel", () => {
  for (const c of jobs.values()) c.abort();
  return true;
});

handle("shell:reveal", (path) => shell.showItemInFolder(path));

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: "#0e0e10",
    title: "Cutroom",
    show: !SMOKE,
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  const devUrl = process.env.CUTROOM_DEV_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(here, "..", "dist", "index.html"));
  if (SMOKE) {
    // Headless self-check: render the UI, optionally drive it, save a screenshot.
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const script = flag("smoke-js");
        if (script) {
          try {
            await win.webContents.executeJavaScript(readFileSync(script, "utf8"));
          } catch (err) {
            console.log(`SMOKE_JS_ERROR ${err.message}`);
          }
          await new Promise((r) => setTimeout(r, Number(flag("settle") ?? 1500)));
        }
        const image = await win.webContents.capturePage();
        const out = flag("screenshot") ?? join(app.getPath("temp"), "cutroom-smoke.png");
        writeFileSync(out, image.toPNG());
        console.log(`SMOKE_OK ${out}`);
        app.quit();
      }, Number(flag("delay") ?? 2500));
    });
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") console.log(`RENDERER_ERROR ${event.message}`);
    });
  }
}

app.whenReady().then(() => {
  protocol.handle("cutroom-media", serveMedia);
  createWindow();
});

app.on("window-all-closed", () => {
  current.unwatch?.();
  app.quit();
});
