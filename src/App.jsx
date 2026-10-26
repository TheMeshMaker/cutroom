import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TEXT_STYLES, byId } from "../core/catalog.js";
import { captionLines } from "../core/captions.js";
import { clipById, clipEnd, clipsAt, isText, mainTrack, mediaById, projectDuration, sourceAt, trackById, videoLayers } from "../core/model.js";
import * as ops from "../core/ops.js";
import ExportDialog from "./components/ExportDialog.jsx";
import Library from "./components/Library.jsx";
import Player from "./components/Player.jsx";
import Properties from "./components/Properties.jsx";
import Timeline from "./components/Timeline.jsx";
import TopBar from "./components/TopBar.jsx";
import Welcome from "./components/Welcome.jsx";
import { EditorContext, EMPTY_SELECTION } from "./editor.js";
import { PUNCH_DEFAULTS } from "./presets.js";
import { api, playhead, playing } from "./state.js";

export default function App() {
  const [doc, setDoc] = useState(null); // { path, project }
  const docRef = useRef(null);
  const history = useRef({ past: [], future: [], coalesce: null });
  const [, bumpHistory] = useState(0);
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const [range, setRange] = useState({ in: null, out: null });
  const [proxies, setProxies] = useState({}); // mediaId -> path | { progress }
  const [waves, setWaves] = useState({});
  const [strips, setStrips] = useState({});
  const [jobsState, setJobs] = useState({}); // "kind:id" -> progress
  const [toast, setToast] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [saveState, setSaveState] = useState("saved");
  const [tool, setTool] = useState("select");
  const [snap, setSnap] = useState(true);
  const [libraryTab, setLibraryTab] = useState("media");
  const clipboard = useRef(null);
  const dirty = useRef(false);
  const magnet = doc?.project.settings.magnet ?? true;
  const magnetRef = useRef(magnet);
  magnetRef.current = magnet;

  const notify = useCallback((text, kind = "info") => setToast({ text, kind, id: Date.now() }), []);
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

  // Apply an edit. `coalesce` merges rapid edits of one control (slider drags)
  // into one undo step. With the main-track magnet on, the main track never
  // has gaps (CapCut behavior).
  const apply = useCallback(
    (fn, { coalesce } = {}) => {
      const d = docRef.current;
      if (!d) return false;
      let next;
      try {
        next = fn(d.project);
        if (next) next = ops.settle(next);
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
      if (opened.warnings?.length) notify(`Imported with ${opened.warnings.length} note(s): ${opened.warnings[0]}`);
    },
    [commit, notify],
  );

  useEffect(() => {
    api.initial().then(openDoc).catch((e) => notify(e.message, "error"));
  }, [openDoc, notify]);

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

  // Preview proxies, then waveforms and filmstrips, one media item at a time.
  const queued = useRef(new Set());
  const chain = useRef(Promise.resolve());
  useEffect(() => {
    if (!doc) return;
    for (const m of doc.project.media) {
      if (queued.current.has(m.id)) continue;
      queued.current.add(m.id);
      setProxies((p) => ({ ...p, [m.id]: { progress: 0 } }));
      chain.current = chain.current.then(async () => {
        try {
          const path = await api.proxy(m);
          setProxies((p) => ({ ...p, [m.id]: path }));
          if (m.hasAudio) api.waveform(m).then((w) => setWaves((x) => ({ ...x, [m.id]: w }))).catch(() => {});
          if (m.hasVideo) {
            const strip = await api.filmstrip(m, path !== m.path ? path : undefined).catch(() => null);
            if (strip) setStrips((x) => ({ ...x, [m.id]: strip }));
          }
        } catch (e) {
          setProxies((p) => ({ ...p, [m.id]: { error: e.message } }));
          notify(`${m.name}: ${e.message}`, "error");
        }
      });
    }
  }, [doc, notify]);
  useEffect(() => api.on("proxy:progress", ({ mediaId, p }) => setProxies((x) => (typeof x[mediaId] === "string" ? x : { ...x, [mediaId]: { progress: p } }))), []);
  useEffect(() => api.on("job:progress", ({ kind, id, p }) => setJobs((j) => ({ ...j, [`${kind}:${id}`]: p }))), []);

  const project = doc?.project;

  // Clips the "current" actions target: the selection, else what's under the
  // playhead on the top-most visible video layer.
  const targetClips = useCallback(
    (kinds = ["video"]) => {
      const p = docRef.current.project;
      const sel = selection.clips.map((id) => clipById(p, id)).filter(Boolean);
      if (sel.length) return sel;
      const t = playhead.get();
      const order = videoLayers(p).map((x) => x.id).reverse();
      return clipsAt(p, t)
        .filter((c) => kinds.includes(trackById(p, c.trackId).kind))
        .sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId))
        .slice(0, 1);
    },
    [selection],
  );

  const actions = useMemo(() => {
    const t = () => playhead.get();
    const withClip = (fn, kinds) => {
      const [c] = targetClips(kinds);
      if (!c) return notify("Select a clip first (or put the playhead over one)", "error");
      return fn(c);
    };
    return {
      importMedia: async () => {
        try {
          const infos = await api.importMedia();
          if (!infos.length) return;
          apply((p) => {
            let next = p;
            const wasEmpty = p.clips.length === 0;
            for (const info of infos) {
              const r = ops.addMedia(next, info);
              next = r.project;
              if (wasEmpty) next = ops.addClip(next, { mediaId: r.media.id }).project;
            }
            return next;
          });
          notify(`Imported ${infos.length} file${infos.length === 1 ? "" : "s"}`);
        } catch (e) {
          notify(e.message, "error");
        }
      },
      addMedia: (mediaId, at = {}) =>
        apply((p) => {
          const m = mediaById(p, mediaId);
          const onMain = m.hasVideo && (!at.trackId || at.trackId === mainTrack(p).id);
          if (onMain && magnetRef.current && at.start != null) {
            const added = ops.addClip(p, { mediaId, trackId: mainTrack(p).id, start: projectDuration(p) + 100 }).project;
            const clip = added.clips.find((c) => !p.clips.some((x) => x.id === c.id));
            return ops.insertOnTrack(added, clip.id, at.start, mainTrack(added).id);
          }
          return ops.addClip(p, { mediaId, ...at }).project;
        }),
      split: () =>
        apply((p) => {
          const time = t();
          if (selection.clips.length) {
            let next = p;
            for (const id of selection.clips) next = ops.splitClip(next, id, time).project;
            return next;
          }
          return ops.splitAt(p, time);
        }),
      splitClipAt: (id, time) => apply((p) => ops.splitClip(p, id, time).project),
      remove: (ripple) => {
        if (selection.transition) apply((p) => ops.setTransition(p, selection.transition, null));
        else if (selection.clips.length) apply((p) => ops.deleteClips(p, selection.clips, { ripple }));
        else if (selection.bleep) apply((p) => ops.removeBleep(p, selection.bleep));
        else if (selection.markers.length) apply((p) => ops.removeMarkers(p, selection.markers));
        setSelection(EMPTY_SELECTION);
      },
      deleteSide: (side) => {
        const ids = targetClips(["video", "audio", "text"]).map((c) => c.id);
        if (!ids.length) return;
        apply((p) => ops.trimToTime(p, ids, t(), side, { ripple: magnetRef.current }));
      },
      bleep: () => {
        const [a, b] = range.in != null && range.out != null && range.out > range.in ? [range.in, range.out] : [t() - 0.2, t() + 0.2];
        apply((p) => ops.addBleep(p, Math.max(0, a), b));
      },
      punchIn: (opts = PUNCH_DEFAULTS) =>
        withClip((c) =>
          apply((p) => {
            const time = t();
            if (time < c.start || time >= clipEnd(c)) throw new Error("Move the playhead over the clip to punch in");
            const room = clipEnd(c) - time;
            const hold = opts.hold != null ? Math.min(opts.hold, Math.max(0, room - opts.ramp - (opts.release ?? opts.ramp))) : null;
            return ops.punchIn(p, c.id, time, { ...opts, hold });
          }),
        ),
      mirror: () => withClip((c) => apply((p) => ops.setClip(p, c.id, { flipH: !c.flipH }))),
      rotate: () => withClip((c) => apply((p) => ops.setClip(p, c.id, { transform: { rotation: ((c.transform.rotation + 90 + 180) % 360) - 180 } }))),
      freeze: () =>
        withClip(async (c) => {
          const m = mediaById(docRef.current.project, c.mediaId);
          const time = t();
          if (time <= c.start || time >= clipEnd(c)) return notify("Move the playhead inside the clip to freeze a frame", "error");
          try {
            const still = await api.freezeFrame(m, sourceAt(c, time));
            apply((p) => {
              const r = ops.addMedia(p, still);
              return ops.insertFreeze(r.project, c.id, time, r.media.id, 3);
            });
          } catch (e) {
            notify(e.message, "error");
          }
        }),
      reverse: () =>
        withClip(async (c) => {
          const m = mediaById(docRef.current.project, c.mediaId);
          if (m.kind === "image") return;
          const id = c.id;
          notify("Reversing… (rendered once, then cached)");
          try {
            const info = await api.reverse(m, c.in, c.out, id);
            apply((p) => {
              const r = ops.addMedia(p, info);
              return ops.replaceClipMedia(r.project, id, r.media.id, { in: 0, out: info.duration, reverseKeyframes: true });
            });
            notify("Reversed");
          } catch (e) {
            notify(e.message, "error");
          }
        }),
      extractAudio: () => withClip((c) => apply((p) => ops.extractAudio(p, c.id))),
      addText: (styleId = "classic", text = "Text") => {
        const style = byId(TEXT_STYLES, styleId)?.style ?? {};
        const [sel] = selection.clips.map((id) => clipById(docRef.current.project, id)).filter((c) => c && isText(c));
        if (sel) return apply((p) => ops.setClip(p, sel.id, { style }));
        apply((p) => {
          const r = ops.addText(p, { text, style, start: t(), duration: 3 });
          setSelection({ ...EMPTY_SELECTION, clips: [r.clip.id] });
          return r.project;
        });
      },
      applyEffect: (id) => withClip((c) => apply((p) => ops.setClip(p, c.id, { effects: [...c.effects.filter((e) => e.id !== id), { id, intensity: 60 }] }))),
      applyFilter: (id) => withClip((c) => apply((p) => ops.setClip(p, c.id, { filter: id ? { id, intensity: 100 } : null }))),
      applyAnimation: (slot, type) => withClip((c) => apply((p) => ops.setClip(p, c.id, { [slot]: type ? { type, duration: c[slot]?.duration ?? 0.5 } : null })), ["video", "text"]),
      applyTransition: (type) => {
        const p = docRef.current.project;
        // The cut nearest the playhead on the main track (or the selected clip's start).
        let target = selection.clips.length ? clipById(p, selection.clips[0]) : null;
        if (!target || !ops.previousTouching(p, target)) {
          const main = p.clips.filter((c) => c.trackId === mainTrack(p).id && ops.previousTouching(p, c));
          target = main.sort((a, b) => Math.abs(a.start - t()) - Math.abs(b.start - t()))[0];
        }
        if (!target) return notify("Transitions go between two touching clips on a track", "error");
        if (apply((x) => ops.setTransition(x, target.id, { type, duration: target.transition?.duration ?? 0.5 }))) setSelection({ ...EMPTY_SELECTION, transition: target.id });
      },
      copy: () => {
        const [c] = targetClips(["video", "audio", "text"]);
        if (c) clipboard.current = c.id;
      },
      paste: () => {
        if (!clipboard.current) return;
        apply((p) => (clipById(p, clipboard.current) ? ops.duplicateClip(p, clipboard.current, t()).project : p));
      },
      autoCaptions: async ({ mediaId, language, styleId }) => {
        const p = docRef.current.project;
        const m = mediaById(p, mediaId);
        if (!m) return notify("Pick an audio source", "error");
        const id = `cap_${Date.now()}`;
        try {
          const result = await api.transcribe(m, { language }, id);
          const lines = captionLines(docRef.current.project, mediaId, result.segments);
          if (!lines.length) return notify("No speech found in that audio", "error");
          apply((x) => ops.addTextTrack(x, lines, { name: "Captions", style: byId(TEXT_STYLES, styleId)?.style ?? byId(TEXT_STYLES, "subtitle").style }).project);
          notify(`Added ${lines.length} captions (${result.language})`);
        } catch (e) {
          notify(e.message, "error");
        } finally {
          setJobs((j) => {
            const { [`captions:${id}`]: _, ...rest } = j;
            return rest;
          });
        }
      },
    };
  }, [apply, notify, range, selection, targetClips]);

  // ---- keyboard (CapCut-compatible where CapCut has a shortcut)
  useEffect(() => {
    const onKey = (e) => {
      if (!docRef.current) return;
      if (e.target.closest("input, select, textarea, [contenteditable]")) return;
      const p = docRef.current.project;
      const fps = p.canvas.fps;
      const dur = projectDuration(p);
      const key = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const seek = (time) => playhead.set(Math.min(Math.max(0, time), dur));
      if (key === " ") {
        if (!playing.get() && playhead.get() >= dur - 0.01) playhead.set(0);
        playing.set(!playing.get());
      } else if (ctrl && key === "z" && !e.shiftKey) undo();
      else if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) redo();
      else if (ctrl && key === "b") actions.split();
      else if (ctrl && key === "e") setExportOpen(true);
      else if (ctrl && key === "i") actions.importMedia();
      else if (ctrl && key === "c") actions.copy();
      else if (ctrl && key === "v") actions.paste();
      else if (ctrl && (key === "=" || key === "+")) window.dispatchEvent(new CustomEvent("timeline-zoom", { detail: 1.4 }));
      else if (ctrl && key === "-") window.dispatchEvent(new CustomEvent("timeline-zoom", { detail: 1 / 1.4 }));
      else if (ctrl) return;
      else if (key === "q") actions.deleteSide("left");
      else if (key === "w") actions.deleteSide("right");
      else if (key === "a") setTool("select");
      else if (key === "b" && e.shiftKey) actions.bleep();
      else if (key === "b") setTool("blade");
      else if (key === "z" && e.shiftKey) window.dispatchEvent(new CustomEvent("timeline-fit"));
      else if (key === "n") setSnap((s) => !s);
      else if (key === "p") actions.punchIn();
      else if (key === "delete" || key === "backspace") actions.remove(e.shiftKey);
      else if (key === "i") setRange((r) => ({ ...r, in: playhead.get() }));
      else if (key === "o") setRange((r) => ({ ...r, out: playhead.get() }));
      else if (key === "x") setRange({ in: null, out: null });
      else if (key === "m") apply((x) => ops.addMarker(x, playhead.get()));
      else if (key === "arrowleft") seek(playhead.get() - (e.shiftKey ? 1 : 1 / fps));
      else if (key === "arrowright") seek(playhead.get() + (e.shiftKey ? 1 : 1 / fps));
      else if (key === "home") seek(0);
      else if (key === "end") seek(dur);
      else if (key === "escape") {
        setSelection(EMPTY_SELECTION);
        setTool("select");
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, actions, apply]);

  const editor = useMemo(
    () =>
      project && {
        project,
        path: doc.path,
        apply,
        undo,
        redo,
        canUndo: history.current.past.length > 0,
        canRedo: history.current.future.length > 0,
        selection,
        setSelection,
        range,
        setRange,
        proxies,
        waves,
        strips,
        jobs: jobsState,
        notify,
        tool,
        setTool,
        magnet,
        setMagnet: (on) => apply((p) => ops.setSettings(p, { magnet: on })),
        snap,
        setSnap,
        libraryTab,
        setLibraryTab,
        saveState,
        actions,
        openExport: () => setExportOpen(true),
        openDoc,
      },
    [project, doc, apply, undo, redo, selection, range, proxies, waves, strips, jobsState, notify, tool, magnet, snap, libraryTab, saveState, actions, openDoc],
  );

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

  return (
    <EditorContext.Provider value={editor}>
      <div className="app">
        <TopBar />
        <div className="workspace">
          <Library />
          <Player />
          <Properties />
        </div>
        <Timeline />
        {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
        {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      </div>
    </EditorContext.Provider>
  );
}
