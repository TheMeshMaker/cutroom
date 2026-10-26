import { useCallback, useEffect, useRef, useState } from "react";
import { clipById, clipEnd, clipsAt, mediaById, projectDuration, trackById, videoLayers } from "../core/model.js";
import * as ops from "../core/ops.js";
import ExportDialog from "./components/ExportDialog.jsx";
import Inspector from "./components/Inspector.jsx";
import MediaBin from "./components/MediaBin.jsx";
import Player from "./components/Player.jsx";
import Timeline from "./components/Timeline.jsx";
import TopBar from "./components/TopBar.jsx";
import Welcome from "./components/Welcome.jsx";
import { PUNCH_DEFAULTS } from "./presets.js";
import { api, playhead, playing } from "./state.js";

const EMPTY_SELECTION = { clips: [], bleep: null, markers: [] };

export default function App() {
  const [doc, setDoc] = useState(null); // { path, project }
  const docRef = useRef(null);
  const history = useRef({ past: [], future: [], coalesce: null });
  const [, bumpHistory] = useState(0);
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const [range, setRange] = useState({ in: null, out: null });
  const [proxies, setProxies] = useState({}); // mediaId -> path | { progress }
  const [waves, setWaves] = useState({}); // mediaId -> { perSecond, peaks }
  const [toast, setToast] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [saveState, setSaveState] = useState("saved");
  const dirty = useRef(false);

  const notify = useCallback((text, kind = "info") => {
    setToast({ text, kind, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "error" ? 5000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const commit = useCallback((next, { markDirty = true } = {}) => {
    docRef.current = next;
    if (markDirty) dirty.current = true;
    setDoc(next);
  }, []);

  // Apply an edit. `coalesce` merges rapid edits of one control (slider
  // drags) into a single undo step.
  const apply = useCallback(
    (fn, { coalesce } = {}) => {
      const d = docRef.current;
      if (!d) return false;
      let next;
      try {
        next = fn(d.project);
      } catch (err) {
        notify(err.message, "error");
        return false;
      }
      if (!next || next === d.project) return false;
      const h = history.current;
      const now = Date.now();
      const merge = coalesce && h.coalesce?.key === coalesce && now - h.coalesce.time < 1500;
      if (!merge) h.past = [...h.past.slice(-199), d.project];
      h.future = [];
      h.coalesce = coalesce ? { key: coalesce, time: now } : null;
      commit({ ...d, project: next });
      bumpHistory((v) => v + 1);
      return true;
    },
    [commit, notify],
  );

  const undo = useCallback(() => {
    const d = docRef.current;
    const h = history.current;
    if (!d || !h.past.length) return;
    h.future = [d.project, ...h.future];
    commit({ ...d, project: h.past[h.past.length - 1] });
    h.past = h.past.slice(0, -1);
    h.coalesce = null;
    bumpHistory((v) => v + 1);
  }, [commit]);

  const redo = useCallback(() => {
    const d = docRef.current;
    const h = history.current;
    if (!d || !h.future.length) return;
    h.past = [...h.past, d.project];
    commit({ ...d, project: h.future[0] });
    h.future = h.future.slice(1);
    h.coalesce = null;
    bumpHistory((v) => v + 1);
  }, [commit]);

  const openDoc = useCallback(
    (opened) => {
      if (!opened) return;
      history.current = { past: [], future: [], coalesce: null };
      setSelection(EMPTY_SELECTION);
      setRange({ in: null, out: null });
      playing.set(false);
      playhead.set(0);
      commit({ path: opened.path, project: opened.project }, { markDirty: false });
      if (opened.warnings?.length) notify(`Imported with ${opened.warnings.length} note(s): ${opened.warnings[0]}`, "info");
    },
    [commit, notify],
  );

  useEffect(() => {
    api.initial().then(openDoc).catch((e) => notify(e.message, "error"));
  }, [openDoc, notify]);

  // Autosave shortly after each edit.
  useEffect(() => {
    if (!doc || !dirty.current) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try {
        await api.saveProject(doc.path, doc.project);
        dirty.current = false;
        setSaveState("saved");
      } catch (e) {
        setSaveState("error");
        notify(`Save failed: ${e.message}`, "error");
      }
    }, 500);
    return () => clearTimeout(t);
  }, [doc, notify]);

  // An agent (or anything else) changed the project file on disk.
  useEffect(
    () =>
      api.on("project:external", (project) => {
        const d = docRef.current;
        if (!d) return;
        history.current.past = [...history.current.past, d.project];
        history.current.future = [];
        commit({ ...d, project }, { markDirty: false });
        bumpHistory((v) => v + 1);
        notify("Project updated from outside (agent edit)");
      }),
    [commit, notify],
  );

  // Preview proxies and waveforms, one media item at a time.
  const queue = useRef(new Set());
  useEffect(() => {
    if (!doc) return;
    for (const m of doc.project.media) {
      if (queue.current.has(m.id)) continue;
      queue.current.add(m.id);
      (async () => {
        try {
          setProxies((p) => ({ ...p, [m.id]: { progress: 0 } }));
          const path = await api.proxy(m);
          setProxies((p) => ({ ...p, [m.id]: path }));
          if (m.hasAudio) {
            const w = await api.waveform(m);
            setWaves((x) => ({ ...x, [m.id]: w }));
          }
        } catch (e) {
          setProxies((p) => ({ ...p, [m.id]: { error: e.message } }));
          notify(`${m.name}: ${e.message}`, "error");
        }
      })();
    }
  }, [doc, notify]);
  useEffect(
    () =>
      api.on("proxy:progress", ({ mediaId, p }) =>
        setProxies((x) => (typeof x[mediaId] === "string" ? x : { ...x, [mediaId]: { progress: p } })),
      ),
    [],
  );

  // ---- actions
  const project = doc?.project;

  const importMedia = useCallback(async () => {
    try {
      const infos = await api.importMedia();
      if (!infos.length) return;
      let added = 0;
      apply((p) => {
        let next = p;
        const wasEmpty = p.clips.length === 0;
        for (const info of infos) {
          const r = ops.addMedia(next, info);
          next = r.project;
          if (wasEmpty) next = ops.addClip(next, { mediaId: r.media.id }).project;
          added++;
        }
        return next;
      });
      notify(`Imported ${added} file${added === 1 ? "" : "s"}`);
    } catch (e) {
      notify(e.message, "error");
    }
  }, [apply, notify]);

  const splitAtPlayhead = useCallback(() => {
    const t = playhead.get();
    apply((p) => {
      const targets = selection.clips.length ? selection.clips : null;
      if (!targets) return ops.splitAt(p, t);
      let next = p;
      for (const id of targets) next = ops.splitClip(next, id, t).project;
      return next;
    });
  }, [apply, selection]);

  const deleteSelection = useCallback(
    (ripple) => {
      if (selection.clips.length) apply((p) => ops.deleteClips(p, selection.clips, { ripple }));
      else if (selection.bleep) apply((p) => ops.removeBleep(p, selection.bleep));
      else if (selection.markers.length) apply((p) => ops.removeMarkers(p, selection.markers));
      setSelection(EMPTY_SELECTION);
    },
    [apply, selection],
  );

  const addBleep = useCallback(() => {
    const t = playhead.get();
    const [a, b] = range.in != null && range.out != null && range.out > range.in ? [range.in, range.out] : [t - 0.2, t + 0.2];
    apply((p) => ops.addBleep(p, Math.max(0, a), b));
  }, [apply, range]);

  const punchClipAt = useCallback(
    (p, t) => {
      const under = clipsAt(p, t).filter((c) => trackById(p, c.trackId).kind === "video");
      const chosen = under.find((c) => selection.clips.includes(c.id));
      if (chosen) return chosen;
      const order = videoLayers(p).map((x) => x.id).reverse(); // top layer first
      return under.sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId))[0];
    },
    [selection],
  );

  const punchIn = useCallback(
    (opts = PUNCH_DEFAULTS) => {
      const t = playhead.get();
      apply((p) => {
        const c = punchClipAt(p, t);
        if (!c) throw new Error("No video clip under the playhead");
        const room = clipEnd(c) - t;
        const hold = opts.hold != null ? Math.min(opts.hold, Math.max(0, room - opts.ramp - (opts.release ?? opts.ramp))) : null;
        return ops.punchIn(p, c.id, t, { ...opts, hold });
      });
    },
    [apply, punchClipAt],
  );

  const addClipFromMedia = useCallback(
    (mediaId, at) => apply((p) => ops.addClip(p, { mediaId, ...at }).project),
    [apply],
  );

  // ---- keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (!docRef.current) return;
      if (e.target.closest("input, select, textarea")) return;
      const p = docRef.current.project;
      const fps = p.canvas.fps;
      const dur = projectDuration(p);
      const key = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const seek = (t) => playhead.set(Math.min(Math.max(0, t), dur));
      if (key === " ") {
        e.preventDefault();
        if (!playing.get() && playhead.get() >= dur - 0.01) playhead.set(0);
        playing.set(!playing.get());
      } else if (ctrl && key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (ctrl && key === "e") {
        e.preventDefault();
        setExportOpen(true);
      } else if (ctrl && key === "i") {
        e.preventDefault();
        importMedia();
      } else if (key === "s" && !ctrl) splitAtPlayhead();
      else if (key === "delete" || key === "backspace") deleteSelection(e.shiftKey);
      else if (key === "b") addBleep();
      else if (key === "p") punchIn();
      else if (key === "i") setRange((r) => ({ ...r, in: playhead.get() }));
      else if (key === "o") setRange((r) => ({ ...r, out: playhead.get() }));
      else if (key === "x") setRange({ in: null, out: null });
      else if (key === "m") apply((x) => ops.addMarker(x, playhead.get()));
      else if (key === "arrowleft") seek(playhead.get() - (e.shiftKey ? 1 : 1 / fps));
      else if (key === "arrowright") seek(playhead.get() + (e.shiftKey ? 1 : 1 / fps));
      else if (key === "home") seek(0);
      else if (key === "end") seek(dur);
      else if (key === "escape") setSelection(EMPTY_SELECTION);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, splitAtPlayhead, deleteSelection, addBleep, punchIn, importMedia, apply]);

  if (!doc) {
    return (
      <>
        <Welcome
          onNew={async (opts) => openDoc(await api.newProject(opts).catch((e) => notify(e.message, "error")))}
          onOpen={async () => openDoc(await api.openProject().catch((e) => notify(e.message, "error")))}
          onImportCapcut={async () => openDoc(await api.importCapcut().catch((e) => notify(e.message, "error")))}
        />
        {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      </>
    );
  }

  const selectedClip = selection.clips.length === 1 ? clipById(project, selection.clips[0]) : null;

  return (
    <div className="app">
      <TopBar
        project={project}
        path={doc.path}
        saveState={saveState}
        canUndo={history.current.past.length > 0}
        canRedo={history.current.future.length > 0}
        onUndo={undo}
        onRedo={redo}
        onNew={async () => openDoc(await api.newProject({}).catch((e) => notify(e.message, "error")))}
        onOpen={async () => openDoc(await api.openProject().catch((e) => notify(e.message, "error")))}
        onImportCapcut={async () => openDoc(await api.importCapcut().catch((e) => notify(e.message, "error")))}
        onExport={() => setExportOpen(true)}
      />
      <div className="workspace">
        <MediaBin project={project} proxies={proxies} onImport={importMedia} onAdd={(id) => addClipFromMedia(id, {})} />
        <Player project={project} proxies={proxies} range={range} />
        <Inspector
          project={project}
          clip={selectedClip}
          bleep={selection.bleep ? project.bleeps.find((b) => b.id === selection.bleep) : null}
          selection={selection}
          setSelection={setSelection}
          apply={apply}
          notify={notify}
          onPunchIn={punchIn}
          mediaOf={(id) => mediaById(project, id)}
        />
      </div>
      <Timeline
        project={project}
        selection={selection}
        setSelection={setSelection}
        apply={apply}
        waves={waves}
        range={range}
        onSplit={splitAtPlayhead}
        onDelete={deleteSelection}
        onBleep={addBleep}
        onPunchIn={() => punchIn()}
        onDropMedia={addClipFromMedia}
      />
      {exportOpen && <ExportDialog project={project} range={range} onClose={() => setExportOpen(false)} notify={notify} />}
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
