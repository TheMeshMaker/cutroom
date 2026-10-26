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
  importCapcut: () => call("capcut:import"),
  importMedia: () => call("media:import"),
  probe: (path) => call("media:probe", path),
  proxy: (media) => call("media:proxy", media),
  waveform: (media) => call("media:waveform", media),
  silence: (media, opts) => call("media:silence", media, opts),
  encoders: () => call("encoders:list"),
  exportStart: (project, opts) => call("export:start", project, opts),
  exportCancel: () => call("export:cancel"),
  reveal: (path) => call("shell:reveal", path),
  on: (channel, fn) => {
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
