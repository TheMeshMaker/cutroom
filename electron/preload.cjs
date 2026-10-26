const { contextBridge, ipcRenderer } = require("electron");

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld("cutroom", {
  initial: () => call("app:initial"),
  newProject: (opts) => call("project:new", opts),
  openProject: (path) => call("project:open", path),
  saveProject: (path, project) => call("project:save", path, project),
  closeProject: () => call("project:close"),
  listBackups: (path) => call("backups:list", path),
  restoreBackup: (path, file) => call("backups:restore", path, file),
  listProjects: () => call("projects:list"),
  projectThumb: (path) => call("projects:thumb", path),
  forgetProject: (path) => call("projects:forget", path),
  scenes: (media, opts) => call("media:scenes", media, opts),
  chooseFolder: (title) => call("dialog:folder", title),
  saveFrame: (project, time) => call("frame:save", project, time),
  importCapcut: () => call("capcut:import"),
  importMedia: () => call("media:import"),
  chooseLut: () => call("lut:choose"),
  probe: (path) => call("media:probe", path),
  proxy: (media) => call("media:proxy", media),
  waveform: (media) => call("media:waveform", media),
  filmstrip: (media, source) => call("media:filmstrip", media, source),
  silence: (media, opts) => call("media:silence", media, opts),
  reverse: (media, inn, out, id) => call("media:reverse", media, inn, out, id),
  freezeFrame: (media, time) => call("media:freeze", media, time),
  transcribe: (media, opts, id) => call("captions:transcribe", media, opts, id),
  saveCaptions: (project, path) => call("captions:save", project, path),
  openSubtitles: () => call("captions:open"),
  encoders: () => call("encoders:list"),
  previewFrame: (project, time, width) => call("frame:preview", project, time, width),
  audioSnippet: (project, range) => call("audio:snippet", project, range),
  exportStart: (project, opts) => call("export:start", project, opts),
  exportCancel: () => call("export:cancel"),
  reveal: (path) => call("shell:reveal", path),
  on: (channel, fn) => {
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
