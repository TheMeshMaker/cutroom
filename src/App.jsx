import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TEXT_STYLES, TITLE_TEMPLATES, byId } from "../core/catalog.js";
import { captionLines } from "../core/captions.js";
import { clipById, clipEnd, clipsAt, hasMedia, isText, mainTrack, mediaById, projectDuration, sourceAt, trackById, videoLayers } from "../core/model.js";
import * as ops from "../core/ops.js";
import { isFiller, wordRanges, wordsFromSegments } from "../core/transcript.js";
import { autoColor, matchColor } from "./colorTools.js";
import AudioPage from "./components/AudioPage.jsx";
import BackupsDialog from "./components/BackupsDialog.jsx";
import ColorPage from "./components/ColorPage.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import DeliverPage from "./components/DeliverPage.jsx";
import ExportDialog from "./components/ExportDialog.jsx";
import Library from "./components/Library.jsx";
import Player from "./components/Player.jsx";
import ProjectsHome from "./components/ProjectsHome.jsx";
import Properties from "./components/Properties.jsx";
import Splitter from "./components/Splitter.jsx";
import Timeline from "./components/Timeline.jsx";
import TopBar from "./components/TopBar.jsx";
import { EditorContext, EMPTY_SELECTION } from "./editor.js";
import { actionFor, KEYMAPS, shortcutFor } from "./keymaps.js";
import { PUNCH_DEFAULTS } from "./presets.js";
import { api, gradeBypass, playhead, playing, sourceControl } from "./state.js";

const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable; settings just won't persist
  }
};

export default function App() {
  const [doc, setDoc] = useState(null); // { path, project }
  const [home, setHome] = useState(false);
  const [booted, setBooted] = useState(false);
  const docRef = useRef(null);
  const history = useRef({ past: [], future: [], coalesce: null });
  const [, bumpHistory] = useState(0);
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const [range, setRange] = useState({ in: null, out: null });
  const [proxies, setProxies] = useState({});
  const [waves, setWaves] = useState({});
  const [strips, setStrips] = useState({});
  const [jobsState, setJobs] = useState({});
  const [toast, setToast] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [saveState, setSaveState] = useState("saved");
  const [tool, setTool] = useState("select");
  const [snap, setSnap] = useState(true);
  const [libraryTab, setLibraryTab] = useState("media");
  const [page, setPage] = useState("edit");
  const [source, setSource] = useState(null); // source monitor: { mediaId, in, out, t }
  const [viewer, setViewer] = useState("timeline");
  const [backupsOpen, setBackupsOpen] = useState(false);
  const gradeClipboard = useRef(null);
  const [keymap, setKeymapState] = useState(() => load("cutroom.keymap", "capcut"));
  const [layout, setLayoutState] = useState(() => ({ lib: 380, props: 330, timeline: 0.42, ...load("cutroom.layout", {}) }));
  const clipboard = useRef(null);
  const dirty = useRef(false);
  const magnet = doc?.project.settings.magnet ?? true;
  const magnetRef = useRef(magnet);
  magnetRef.current = magnet;

  const setKeymap = (k) => {
    setKeymapState(k);
    save("cutroom.keymap", k);
  };
  const setLayout = (patch) =>
    setLayoutState((l) => {
      const next = { ...l, ...patch };
      save("cutroom.layout", next);
      return next;
    });

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

  // Apply an edit. `coalesce` merges rapid edits of one control into one undo
  // step. ops.settle keeps the main track gapless when the magnet is on.
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
      setHome(false);
      setPage("edit");
      if (opened.warnings?.length) notify(`Imported with ${opened.warnings.length} note(s): ${opened.warnings[0]}`);
    },
    [commit, notify],
  );

  useEffect(() => {
    api
      .initial()
      .then((opened) => {
        if (opened) openDoc(opened);
        else setHome(true);
      })
      .catch((e) => {
        notify(e.message, "error");
        setHome(true);
      })
      .finally(() => setBooted(true));
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
  const endJob = (key) =>
    setJobs((j) => {
      const { [key]: _, ...rest } = j;
      return rest;
    });

  const project = doc?.project;

  // What "current" actions target: the selection, else the top visible clip
  // under the playhead.
  const targetClips = useCallback(
    (kinds = ["video"]) => {
      const p = docRef.current.project;
      const sel = selection.clips.map((id) => clipById(p, id)).filter(Boolean);
      if (sel.length) return sel;
      const order = videoLayers(p).map((x) => x.id).reverse();
      return clipsAt(p, playhead.get())
        .filter((c) => kinds.includes(trackById(p, c.trackId).kind) && !c.adjustment)
        .sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId))
        .slice(0, 1);
    },
    [selection],
  );

  const actions = useMemo(() => {
    const t = () => playhead.get();
    const p = () => docRef.current.project;
    const withClip = (fn, kinds) => {
      const [c] = targetClips(kinds);
      if (!c) return notify("Select a clip first (or put the playhead over one)", "error");
      return fn(c);
    };
    const seek = (time) => playhead.set(Math.min(Math.max(0, time), projectDuration(p())));
    const inSource = () => viewer === "source" && source && sourceControl.current;
    const a = {
      play: () => {
        if (inSource()) return sourceControl.current.toggle();
        if (!playing.get() && playhead.get() >= projectDuration(p()) - 0.01) playhead.set(0);
        playing.set(!playing.get());
      },
      openSource: (mediaId) => {
        const m = mediaById(p(), mediaId);
        if (!m) return;
        playing.set(false);
        setSource((s) => (s?.mediaId === mediaId ? s : { mediaId, in: null, out: null, t: 0 }));
        setViewer("source");
      },
      sourcePlace: (mode) => {
        if (!source) return notify("Open a clip in the source monitor first (double-click it in Media)", "error");
        const m = mediaById(p(), source.mediaId);
        const dur = m.kind === "image" ? 5 : m.duration;
        const inn = source.in ?? 0;
        const out = source.out ?? dur;
        const at = t();
        let added = null;
        if (
          apply((x) => {
            const r = ops.placeSource(x, { mediaId: m.id, in: inn, out, at, mode });
            added = r.clip;
            return r.project;
          })
        ) {
          if (added && mode !== "append") playhead.set(added.start + (added.out - added.in));
          notify({ insert: "Inserted", overwrite: "Overwrote", append: "Appended", top: "Placed on top" }[mode]);
        }
      },
      sourceInsert: () => a.sourcePlace("insert"),
      sourceOverwrite: () => a.sourcePlace("overwrite"),
      copyGrade: () =>
        withClip((c) => {
          gradeClipboard.current = { color: structuredClone(c.color), adjust: { ...c.adjust }, filter: c.filter, lut: c.lut, videoDenoise: c.videoDenoise };
          notify("Grade copied. Select clips and paste it.");
        }),
      pasteGrade: () => {
        const g = gradeClipboard.current;
        if (!g) return notify("Copy a grade first", "error");
        const ids = targetClips(["video"]).map((c) => c.id);
        if (!ids.length) return notify("Select clips to paste the grade on", "error");
        apply((x) => ids.reduce((acc, id) => ops.setClip(acc, id, structuredClone(g)), x));
        notify(`Pasted grade on ${ids.length} clip${ids.length === 1 ? "" : "s"}`);
      },
      toggleBypass: () =>
        withClip((c) => {
          gradeBypass.set(gradeBypass.get() === c.id ? null : c.id);
        }),
      closeGaps: () => {
        if (apply((x) => ops.closeGaps(x))) notify("Closed all gaps");
        else notify("No gaps to close");
      },
      speedRamp: (preset) => withClip((c) => apply((x) => ops.speedRamp(x, c.id, preset)), ["video", "audio"]),
      addTitle: (templateId) =>
        apply((x) => {
          const r = ops.addTitle(x, templateId, { start: t() });
          setSelection({ ...EMPTY_SELECTION, clips: [r.clip.id] });
          return r.project;
        }),
      nextMarker: () => {
        const m = p().markers.find((k) => k.time > t() + 0.01);
        if (m) seek(m.time);
      },
      prevMarker: () => {
        const m = [...p().markers].reverse().find((k) => k.time < t() - 0.01);
        if (m) seek(m.time);
      },
      restoreBackups: () => setBackupsOpen(true),
      pause: () => playing.set(false),
      back5: () => seek(t() - 5),
      undo,
      redo,
      import: async () => {
        try {
          const infos = await api.importMedia();
          if (!infos.length) return;
          apply((x) => {
            let next = x;
            const wasEmpty = x.clips.length === 0;
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
      export: () => setExportOpen(true),
      palette: () => setPaletteOpen(true),
      addMedia: (mediaId, at = {}) =>
        apply((x) => {
          const m = mediaById(x, mediaId);
          const onMain = m.hasVideo && (!at.trackId || at.trackId === mainTrack(x).id);
          if (onMain && magnetRef.current && at.start != null) {
            const added = ops.addClip(x, { mediaId, trackId: mainTrack(x).id, start: projectDuration(x) + 100 }).project;
            const clip = added.clips.find((c) => !x.clips.some((k) => k.id === c.id));
            return ops.insertOnTrack(added, clip.id, at.start, mainTrack(added).id);
          }
          return ops.addClip(x, { mediaId, ...at }).project;
        }),
      split: () =>
        apply((x) => {
          if (!selection.clips.length) return ops.splitAt(x, t());
          let next = x;
          for (const id of selection.clips) next = ops.splitClip(next, id, t()).project;
          return next;
        }),
      splitAll: () => apply((x) => ops.splitAt(x, t())),
      splitClipAt: (id, time) => apply((x) => ops.splitClip(x, id, time).project),
      remove: (ripple = false) => {
        if (selection.transition) apply((x) => ops.setTransition(x, selection.transition, null));
        else if (selection.clips.length) apply((x) => ops.deleteClips(x, selection.clips, { ripple }));
        else if (selection.bleep) apply((x) => ops.removeBleep(x, selection.bleep));
        else if (selection.markers.length) apply((x) => ops.removeMarkers(x, selection.markers));
        setSelection(EMPTY_SELECTION);
      },
      rippleRemove: () => a.remove(true),
      deleteSide: (side) => {
        const ids = targetClips(["video", "audio", "text"]).map((c) => c.id);
        if (ids.length) apply((x) => ops.trimToTime(x, ids, t(), side, { ripple: magnetRef.current }));
      },
      deleteLeft: () => a.deleteSide("left"),
      deleteRight: () => a.deleteSide("right"),
      toolSelect: () => setTool("select"),
      toolBlade: () => setTool("blade"),
      toolRoll: () => setTool("roll"),
      toolSlip: () => setTool("slip"),
      snap: () => setSnap((s) => !s),
      marker: () => apply((x) => ops.addMarker(x, t())),
      markIn: () => (inSource() ? setSource((s) => ({ ...s, in: sourceControl.current.time() })) : setRange((r) => ({ ...r, in: t() }))),
      markOut: () => (inSource() ? setSource((s) => ({ ...s, out: sourceControl.current.time() })) : setRange((r) => ({ ...r, out: t() }))),
      clearRange: () => setRange({ in: null, out: null }),
      zoomIn: () => window.dispatchEvent(new CustomEvent("timeline-zoom", { detail: 1.4 })),
      zoomOut: () => window.dispatchEvent(new CustomEvent("timeline-zoom", { detail: 1 / 1.4 })),
      fit: () => window.dispatchEvent(new CustomEvent("timeline-fit")),
      prevFrame: () => seek(t() - 1 / p().canvas.fps),
      nextFrame: () => seek(t() + 1 / p().canvas.fps),
      prevSecond: () => seek(t() - 1),
      nextSecond: () => seek(t() + 1),
      start: () => seek(0),
      end: () => seek(projectDuration(p())),
      escape: () => {
        setSelection(EMPTY_SELECTION);
        setTool("select");
        setPaletteOpen(false);
      },
      selectAtPlayhead: () => {
        const [c] = targetClips(["video", "audio", "text"]);
        if (c) setSelection({ ...EMPTY_SELECTION, clips: [c.id] });
      },
      bleep: () => {
        const [s, e] = range.in != null && range.out != null && range.out > range.in ? [range.in, range.out] : [t() - 0.2, t() + 0.2];
        apply((x) => ops.addBleep(x, Math.max(0, s), e));
      },
      punchIn: (opts = PUNCH_DEFAULTS) =>
        withClip((c) =>
          apply((x) => {
            const time = t();
            if (time < c.start || time >= clipEnd(c)) throw new Error("Move the playhead over the clip to punch in");
            const room = clipEnd(c) - time;
            const hold = opts.hold != null ? Math.min(opts.hold, Math.max(0, room - opts.ramp - (opts.release ?? opts.ramp))) : null;
            return ops.punchIn(x, c.id, time, { ...opts, hold });
          }),
        ),
      mirror: () => withClip((c) => apply((x) => ops.setClip(x, c.id, { flipH: !c.flipH }))),
      rotate: () => withClip((c) => apply((x) => ops.setClip(x, c.id, { transform: { rotation: ((c.transform.rotation + 90 + 180) % 360) - 180 } }))),
      freeze: () =>
        withClip(async (c) => {
          if (!hasMedia(c)) return;
          const m = mediaById(p(), c.mediaId);
          const time = t();
          if (time <= c.start || time >= clipEnd(c)) return notify("Move the playhead inside the clip to freeze a frame", "error");
          try {
            const still = await api.freezeFrame(m, sourceAt(c, time));
            apply((x) => {
              const r = ops.addMedia(x, still);
              return ops.insertFreeze(r.project, c.id, time, r.media.id, 3);
            });
          } catch (e) {
            notify(e.message, "error");
          }
        }),
      reverse: () =>
        withClip(async (c) => {
          if (!hasMedia(c)) return;
          const m = mediaById(p(), c.mediaId);
          if (m.kind === "image") return;
          notify("Reversing… (rendered once, then cached)");
          try {
            const info = await api.reverse(m, c.in, c.out, c.id);
            apply((x) => {
              const r = ops.addMedia(x, info);
              return ops.replaceClipMedia(r.project, c.id, r.media.id, { in: 0, out: info.duration, reverseKeyframes: true });
            });
            notify("Reversed");
          } catch (e) {
            notify(e.message, "error");
          }
        }),
      scenes: () =>
        withClip(async (c) => {
          if (!hasMedia(c)) return;
          const m = mediaById(p(), c.mediaId);
          const key = `scenes:${c.id}`;
          setJobs((j) => ({ ...j, [key]: 0 }));
          notify("Looking for scene changes…");
          try {
            const source = typeof proxies[m.id] === "string" ? proxies[m.id] : undefined;
            const times = (await api.scenes(m, { source })).filter((s) => s > c.in + 0.2 && s < c.out - 0.2);
            if (!times.length) return notify("No scene changes found in this clip");
            apply((x) => ops.splitAtSourceTimes(x, m.id, times));
            notify(`Split at ${times.length} scene change${times.length === 1 ? "" : "s"}`);
          } catch (e) {
            notify(e.message, "error");
          } finally {
            endJob(key);
          }
        }),
      extractAudio: () => withClip((c) => apply((x) => ops.extractAudio(x, c.id))),
      addAdjustment: () =>
        apply((x) => {
          const r = ops.addAdjustment(x, { start: t(), duration: 5 });
          setSelection({ ...EMPTY_SELECTION, clips: [r.clip.id] });
          return r.project;
        }),
      addText: (styleId = "classic", text = "Text") => {
        const style = byId(TEXT_STYLES, styleId)?.style ?? {};
        const [sel] = selection.clips.map((id) => clipById(p(), id)).filter((c) => c && isText(c));
        if (sel) return apply((x) => ops.setClip(x, sel.id, { style }));
        apply((x) => {
          const r = ops.addText(x, { text, style, start: t(), duration: 3 });
          setSelection({ ...EMPTY_SELECTION, clips: [r.clip.id] });
          return r.project;
        });
      },
      applyEffect: (id) => withClip((c) => apply((x) => ops.setClip(x, c.id, { effects: [...c.effects.filter((e) => e.id !== id), { id, intensity: 60 }] }))),
      applyFilter: (id) => withClip((c) => apply((x) => ops.setClip(x, c.id, { filter: id ? { id, intensity: 100 } : null }))),
      applyTransition: (type) => {
        const x = p();
        let target = selection.clips.length ? clipById(x, selection.clips[0]) : null;
        if (!target || !ops.previousTouching(x, target)) {
          const main = x.clips.filter((c) => c.trackId === mainTrack(x).id && ops.previousTouching(x, c));
          target = main.sort((m1, m2) => Math.abs(m1.start - t()) - Math.abs(m2.start - t()))[0];
        }
        if (!target) return notify("Transitions go between two touching clips on a track", "error");
        if (apply((y) => ops.setTransition(y, target.id, { type, duration: target.transition?.duration ?? 0.5 }))) setSelection({ ...EMPTY_SELECTION, transition: target.id });
      },
      copy: () => {
        const [c] = targetClips(["video", "audio", "text"]);
        if (c) clipboard.current = c.id;
      },
      paste: () => {
        if (clipboard.current) apply((x) => (clipById(x, clipboard.current) ? ops.duplicateClip(x, clipboard.current, t()).project : x));
      },
      transcribe: async ({ mediaId, language }) => {
        const m = mediaById(p(), mediaId);
        if (!m) return notify("Pick an audio source", "error");
        const key = `transcribe:${mediaId}`;
        setJobs((j) => ({ ...j, [key]: 0 }));
        try {
          const result = await api.transcribe(m, { language, fillers: true }, mediaId);
          apply((x) => ops.setTranscript(x, mediaId, { language: result.language, words: wordsFromSegments(result.segments) }));
          notify(`Transcribed (${result.language})`);
        } catch (e) {
          notify(e.message, "error");
        } finally {
          endJob(key);
          endJob(`captions:${mediaId}`);
        }
      },
      removeWords: (words) => {
        if (!words.length) return;
        apply((x) => ops.removeRanges(x, wordRanges(words)));
        notify(`Cut ${words.length} word${words.length === 1 ? "" : "s"}`);
      },
      autoCaptions: async ({ mediaId, language, styleId }) => {
        const m = mediaById(p(), mediaId);
        if (!m) return notify("Pick an audio source", "error");
        const id = `cap_${Date.now()}`;
        try {
          const stored = p().transcripts[mediaId];
          const segments = stored ? [{ words: stored.words.filter((w) => !isFiller(w.w)).map((w) => ({ start: w.s, end: w.e, word: w.w })) }] : (await api.transcribe(m, { language }, id)).segments;
          const lines = captionLines(p(), mediaId, segments);
          if (!lines.length) return notify("No speech found in that audio", "error");
          apply((x) => ops.addTextTrack(x, lines, { name: "Captions", style: byId(TEXT_STYLES, styleId)?.style ?? byId(TEXT_STYLES, "subtitle").style }).project);
          notify(`Added ${lines.length} captions`);
        } catch (e) {
          notify(e.message, "error");
        } finally {
          endJob(`captions:${id}`);
        }
      },
      autoColor: () =>
        withClip(async (c) => {
          try {
            const adjust = await autoColor(p(), c);
            apply((x) => ops.setClip(x, c.id, { adjust }));
            notify("Auto color applied");
          } catch (e) {
            notify(e.message, "error");
          }
        }),
      matchColor: (refId) =>
        withClip(async (c) => {
          try {
            const adjust = await matchColor(p(), c, clipById(p(), refId));
            apply((x) => ops.setClip(x, c.id, { adjust }));
            notify("Matched color to the reference clip");
          } catch (e) {
            notify(e.message, "error");
          }
        }),
      goHome: async () => {
        playing.set(false);
        setHome(true);
      },
      setPage,
    };
    return a;
  }, [apply, notify, range, selection, targetClips, undo, redo, proxies, source, viewer]);

  // Palette entries: every user-facing action with its shortcut.
  const commands = useMemo(
    () =>
      [
        ["play", "Play / pause"], ["split", "Split at playhead"], ["splitAll", "Split all tracks at playhead"], ["deleteLeft", "Delete left of playhead"], ["deleteRight", "Delete right of playhead"],
        ["remove", "Delete selection"], ["rippleRemove", "Ripple delete selection"], ["toolSelect", "Selection tool"], ["toolBlade", "Blade (split) tool"], ["toolRoll", "Roll trim tool"], ["toolSlip", "Slip tool"],
        ["punchIn", "Punch-in zoom at playhead"], ["bleep", "Bleep at playhead / range"], ["marker", "Add marker"], ["freeze", "Freeze frame"], ["reverse", "Reverse clip"], ["mirror", "Mirror clip"], ["rotate", "Rotate clip 90°"],
        ["scenes", "Split clip at scene changes"], ["extractAudio", "Extract audio to its own track"], ["addAdjustment", "Add adjustment layer"], ["autoColor", "Auto color the clip"], ["addText", "Add text"],
        ["copyGrade", "Copy grade"], ["pasteGrade", "Paste grade on selected clips"], ["toggleBypass", "Before / after (bypass grade)"], ["closeGaps", "Close all gaps"],
        ["sourceInsert", "Source monitor: insert at playhead"], ["sourceOverwrite", "Source monitor: overwrite at playhead"], ["nextMarker", "Go to next marker"], ["prevMarker", "Go to previous marker"],
        ["restoreBackups", "Restore an earlier version…"],
        ["import", "Import media"], ["export", "Export…"], ["undo", "Undo"], ["redo", "Redo"], ["snap", "Toggle snapping"], ["fit", "Fit timeline"], ["zoomIn", "Zoom timeline in"], ["zoomOut", "Zoom timeline out"],
        ["goHome", "Go to Projects"],
      ].map(([id, label]) => ({ id, label, shortcut: shortcutFor(id, keymap), run: () => actions[id]?.() })).concat(
        Object.entries(ops.SPEED_RAMPS).map(([k, v]) => ({ id: `ramp-${k}`, label: `Speed ramp: ${v.label}`, shortcut: "", run: () => actions.speedRamp(k) })),
        TITLE_TEMPLATES.map((tpl) => ({ id: `title-${tpl.id}`, label: `Add title: ${tpl.name}`, shortcut: "", run: () => actions.addTitle(tpl.id) })),
        ["edit", "color", "audio", "deliver"].map((pg) => ({ id: `page-${pg}`, label: `Open ${pg[0].toUpperCase() + pg.slice(1)} page`, shortcut: "", run: () => setPage(pg) })),
        Object.entries(KEYMAPS).map(([k, v]) => ({ id: `keymap-${k}`, label: `Keyboard shortcuts: ${v.label}`, shortcut: k === keymap ? "current" : "", run: () => setKeymap(k) })),
      ),
    [actions, keymap],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (!docRef.current || home) return;
      if (e.target.closest?.("input, select, textarea, [contenteditable], [data-keys='own']")) return;
      const id = actionFor(e, keymap);
      if (!id || !actions[id]) return;
      e.preventDefault();
      actions[id]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, keymap, home]);

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
        setMagnet: (on) => apply((x) => ops.setSettings(x, { magnet: on })),
        snap,
        setSnap,
        libraryTab,
        setLibraryTab,
        saveState,
        actions,
        page,
        setPage,
        keymap,
        setKeymap,
        openExport: () => setExportOpen(true),
        openPalette: () => setPaletteOpen(true),
        openDoc,
        targetClips,
        source,
        setSource,
        viewer,
        setViewer,
      },
    [project, doc, apply, undo, redo, selection, range, proxies, waves, strips, jobsState, notify, tool, magnet, snap, libraryTab, saveState, actions, page, keymap, openDoc, targetClips, source, viewer],
  );

  if (!booted) return <div className="boot" />;
  if (home || !doc) {
    return (
      <>
        <ProjectsHome current={doc?.path} onOpen={openDoc} onBack={doc ? () => setHome(false) : null} notify={notify} />
        {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      </>
    );
  }

  const style = { "--lib-w": `${layout.lib}px`, "--props-w": `${layout.props}px`, gridTemplateRows: `44px minmax(260px, ${1 - layout.timeline}fr) 6px minmax(180px, ${layout.timeline}fr)` };

  return (
    <EditorContext.Provider value={editor}>
      <div className={`app page-${page}`} style={page === "edit" ? style : undefined}>
        <TopBar />
        {page === "edit" && (
          <>
            <div className="workspace">
              <Library />
              <Splitter axis="x" onDrag={(dx) => setLayout({ lib: Math.min(640, Math.max(280, layout.lib + dx)) })} />
              <Player />
              <Splitter axis="x" onDrag={(dx) => setLayout({ props: Math.min(560, Math.max(260, layout.props - dx)) })} />
              <Properties />
            </div>
            <Splitter axis="y" onDrag={(dy) => setLayout({ timeline: Math.min(0.75, Math.max(0.2, layout.timeline - dy / window.innerHeight)) })} />
            <Timeline />
          </>
        )}
        {page === "color" && <ColorPage />}
        {page === "audio" && <AudioPage />}
        {page === "deliver" && <DeliverPage />}
        {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
        {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
        {backupsOpen && <BackupsDialog path={doc.path} onClose={() => setBackupsOpen(false)} onRestored={(opened) => (setBackupsOpen(false), openDoc(opened), notify("Restored the earlier version (the current one was backed up first)"))} notify={notify} />}
        {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      </div>
    </EditorContext.Provider>
  );
}
