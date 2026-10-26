import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TEXT_STYLES, byId } from "../../core/catalog.js";
import { clipEnd, clipLength, formatTime, hasMedia, isText, LABELS, mainTrack, mediaById, projectDuration, sourceAt, trackById } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { EMPTY_SELECTION, useEditor } from "../editor.js";
import { shortcutFor } from "../keymaps.js";
import { mediaUrl, playhead, playing, sourceControl, useStore } from "../state.js";
import ContextMenu from "./ContextMenu.jsx";
import Icon from "./icons.jsx";

const HEADER_W = 156;
const ROW_H = { video: 60, audio: 46, text: 30 };
const MAIN_H = 74;
const SIZES = { compact: 0.72, normal: 1, tall: 1.45 };
const SNAP_PX = 8;
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
const KIND_ICON = { video: "film", audio: "music", text: "text" };

const loadSize = () => {
  try {
    return SIZES[localStorage.getItem("cutroom.trackSize")] ? localStorage.getItem("cutroom.trackSize") : "normal";
  } catch {
    return "normal";
  }
};

export default function Timeline() {
  const ed = useEditor();
  const { project, selection, setSelection, apply, waves, strips, range, tool, setTool, magnet, setMagnet, snap, setSnap, actions, undo, redo, canUndo, canRedo, keymap } = ed;
  const scrollRef = useRef(null);
  const innerRef = useRef(null);
  const rowRefs = useRef(new Map());
  const [pps, setPps] = useState(40);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [drag, setDrag] = useState(null);
  const [hover, setHover] = useState(null); // { t, kind: "blade" | "ruler" }
  const [box, setBox] = useState(null); // marquee, in content pixels
  const [menu, setMenu] = useState(null); // { x, y, kind, id, trackId, t }
  const [renaming, setRenaming] = useState(null);
  const [size, setSizeState] = useState(loadSize);
  const zoomAnchor = useRef(null);
  const fitted = useRef(false);
  const duration = projectDuration(project);
  const contentW = Math.max(view.width - HEADER_W, (duration + 20) * pps);
  const main = mainTrack(project);
  const pauses = project.markers.filter((m) => m.end != null);
  const flags = project.markers.filter((m) => m.end == null);
  const k = SIZES[size];
  const rowH = (track) => Math.round((track.id === main.id ? MAIN_H : ROW_H[track.kind]) * (track.kind === "text" ? Math.max(1, k) : k));
  const sc = (id) => shortcutFor(id, keymap);

  const setSize = (s) => {
    setSizeState(s);
    try {
      localStorage.setItem("cutroom.trackSize", s);
    } catch {
      // storage unavailable
    }
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const update = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);

  const fit = () => {
    const w = (scrollRef.current?.clientWidth ?? 1200) - HEADER_W - 40;
    setPps(Math.min(400, Math.max(0.5, w / Math.max(duration, 5))));
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };
  const zoomToSelection = () => {
    const sel = project.clips.filter((c) => selection.clips.includes(c.id));
    if (!sel.length || !scrollRef.current) return fit();
    const a = Math.min(...sel.map((c) => c.start));
    const b = Math.max(...sel.map(clipEnd));
    const w = scrollRef.current.clientWidth - HEADER_W - 80;
    const next = Math.min(800, Math.max(0.5, w / Math.max(b - a, 0.2)));
    zoomAnchor.current = { t: a, offset: 40 };
    setPps(next);
  };
  useEffect(() => {
    if (!fitted.current && duration > 0) {
      fitted.current = true;
      fit();
    }
  }, [duration]);
  useEffect(() => {
    const z = (e) => zoomBy(e.detail);
    const f = () => fit();
    const zs = () => zoomToSelection();
    window.addEventListener("timeline-zoom", z);
    window.addEventListener("timeline-fit", f);
    window.addEventListener("timeline-zoom-selection", zs);
    return () => {
      window.removeEventListener("timeline-zoom", z);
      window.removeEventListener("timeline-fit", f);
      window.removeEventListener("timeline-zoom-selection", zs);
    };
  });
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    if (!a || !scrollRef.current) return;
    scrollRef.current.scrollLeft = Math.max(0, a.t * pps - a.offset);
    zoomAnchor.current = null;
  }, [pps]);

  const timeAt = (clientX) => {
    const r = scrollRef.current.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - HEADER_W + scrollRef.current.scrollLeft) / pps);
  };
  const zoomBy = (factor, clientX) => {
    if (!scrollRef.current) return;
    const r = scrollRef.current.getBoundingClientRect();
    const offset = clientX != null ? clientX - r.left - HEADER_W : (r.width - HEADER_W) / 2;
    zoomAnchor.current = { t: (scrollRef.current.scrollLeft + offset) / pps, offset };
    setPps((v) => Math.min(800, Math.max(0.5, v * factor)));
  };

  const snapPoints = useMemo(() => {
    const pts = [{ t: 0 }];
    for (const c of project.clips) pts.push({ t: c.start, owner: c.id }, { t: clipEnd(c), owner: c.id });
    for (const b of project.bleeps) pts.push({ t: b.start, owner: b.id }, { t: b.end, owner: b.id });
    for (const m of project.markers) pts.push({ t: m.time }, ...(m.end != null ? [{ t: m.end }] : []));
    if (range.in != null) pts.push({ t: range.in });
    if (range.out != null) pts.push({ t: range.out });
    return pts;
  }, [project, range]);
  // Nearest snap point within a few pixels; `owners` are ignored (the clips
  // being dragged).
  const snapT = (t, owners) => {
    if (!snap) return { t, snapped: false };
    const skip = new Set([].concat(owners ?? []));
    let best = t;
    let bd = SNAP_PX / pps;
    for (const p of [...snapPoints, { t: playhead.get() }]) {
      if (p.owner && skip.has(p.owner)) continue;
      const d = Math.abs(p.t - t);
      if (d < bd) {
        bd = d;
        best = p.t;
      }
    }
    return { t: best, snapped: best !== t };
  };
  const rowAt = (clientY, kind) => {
    for (const [id, el] of rowRefs.current) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom && trackById(project, id)?.kind === kind) return id;
    }
    return null;
  };

  const startDrag = (e, { compute, done, click }) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    let ghost = null;
    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      moved = true;
      ghost = compute((ev.clientX - x0) / pps, ev);
      setDrag(ghost);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      setHint(null);
      if (moved && ghost) done(ghost);
      else click?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const selectClip = (e, c) => {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    setSelection((s) => {
      const has = s.clips.includes(c.id);
      return { ...EMPTY_SELECTION, clips: additive ? (has ? s.clips.filter((x) => x !== c.id) : [...s.clips, c.id]) : [c.id] };
    });
  };

  // Floating readout while dragging ("Roll +0.40 s", "Speed 1.5×", "+1.20 s").
  const [hint, setHint] = useState(null);
  const touching = (c, side) =>
    project.clips.find((x) => x.trackId === c.trackId && x.id !== c.id && (side === "prev" ? Math.abs(clipEnd(x) - c.start) < 0.02 : Math.abs(x.start - clipEnd(c)) < 0.02));
  const sign = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)} s`;

  const onClipDown = (e, c, mode) => {
    if (e.button !== 0) return;
    const track = trackById(project, c.trackId);
    if (track.locked) return;
    if (tool === "blade" && mode === "move") {
      e.stopPropagation();
      actions.splitClipAt(c.id, snapT(timeAt(e.clientX), c.id).t);
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!selection.clips.includes(c.id)) selectClip(e, c);
    const media = hasMedia(c) && mediaById(project, c.mediaId);
    const show = (ev, text) => setHint({ x: ev.clientX, y: ev.clientY, text });

    // Roll: drag an edge that touches a neighbour to move the cut between them.
    if (tool === "roll" && mode !== "move") {
      const pair = mode === "trim-l" ? [touching(c, "prev"), c] : [c, touching(c, "next")];
      if (pair[0] && pair[1]) {
        return startDrag(e, {
          compute: (dt, ev) => (show(ev, `Roll ${sign(dt)}`), { type: "roll", dt }),
          done: (g) => apply((p) => ops.rollEdit(p, pair[0].id, pair[1].id, g.dt)),
        });
      }
    }
    // Slip: drag the clip body to show an earlier/later part of its source.
    if (tool === "slip" && mode === "move" && media) {
      return startDrag(e, {
        click: () => selectClip(e, c),
        compute: (dt, ev) => (show(ev, `Slip ${sign(-dt * c.speed)}`), { type: "slip", dt }),
        done: (g) => apply((p) => ops.slipClip(p, c.id, -g.dt * c.speed)),
      });
    }
    // Rate stretch: drag the right edge to change speed instead of trimming.
    if (tool === "rate" && mode === "trim-r" && media && media.kind !== "image") {
      return startDrag(e, {
        compute: (dt, ev) => {
          const len = Math.max(0.1, clipLength(c) + dt);
          const speed = Math.min(10, Math.max(0.1, (c.out - c.in) / len));
          show(ev, `Speed ${speed.toFixed(2)}×`);
          return { type: "clip", id: c.id, speed };
        },
        done: (g) => apply((p) => ops.setClip(p, c.id, { speed: Math.round(g.speed * 100) / 100 })),
      });
    }

    // Dragging one clip of a multi-selection moves the whole selection.
    const group = mode === "move" && selection.clips.includes(c.id) && selection.clips.length > 1 && !additive;
    if (group) {
      const ids = selection.clips.filter((id) => {
        const x = project.clips.find((y) => y.id === id);
        return x && !trackById(project, x.trackId).locked;
      });
      const minStart = Math.min(...ids.map((id) => project.clips.find((y) => y.id === id).start));
      const len = clipLength(c);
      return startDrag(e, {
        click: () => selectClip(e, c),
        compute: (dt, ev) => {
          const a = snapT(c.start + dt, ids);
          const b = snapT(c.start + dt + len, ids);
          let start = c.start + dt;
          let guide = null;
          if (a.snapped && (!b.snapped || Math.abs(a.t - start) <= Math.abs(b.t - len - start))) {
            start = a.t;
            guide = a.t;
          } else if (b.snapped) {
            start = b.t - len;
            guide = b.t;
          }
          const d = Math.max(start - c.start, -minStart);
          show(ev, `${ids.length} clips ${sign(d)}`);
          return { type: "group", ids, dt: d, guide };
        },
        done: (g) => apply((p) => ops.moveClips(p, g.ids, g.dt)),
      });
    }

    startDrag(e, {
      click: () => selectClip(e, c),
      compute: (dt, ev) => {
        if (mode === "move") {
          const len = clipLength(c);
          const a = snapT(c.start + dt, c.id);
          const b = snapT(c.start + dt + len, c.id);
          let start = c.start + dt;
          let guide = null;
          if (a.snapped && (!b.snapped || Math.abs(a.t - start) <= Math.abs(b.t - len - start))) {
            start = a.t;
            guide = a.t;
          } else if (b.snapped) {
            start = b.t - len;
            guide = b.t;
          }
          show(ev, formatTime(Math.max(0, start), project.canvas.fps));
          return { type: "clip", id: c.id, start: Math.max(0, start), trackId: rowAt(ev.clientY, track.kind) ?? c.trackId, pointerT: timeAt(ev.clientX), guide };
        }
        if (mode === "trim-l") {
          const sn = snapT(c.start + dt, c.id);
          const s = sn.t;
          const guide = sn.snapped ? s : null;
          if (!media) {
            const st = Math.min(s, clipEnd(c) - 0.1);
            show(ev, `${(clipEnd(c) - st).toFixed(2)} s`);
            return { type: "clip", id: c.id, start: st, out: c.out - (st - c.start), guide };
          }
          const inn = Math.min(Math.max(0, c.in + (s - c.start) * c.speed), c.out - 0.05);
          show(ev, `${((c.out - inn) / c.speed).toFixed(2)} s`);
          return { type: "clip", id: c.id, in: inn, start: c.start + (inn - c.in) / c.speed, guide };
        }
        const sn = snapT(clipEnd(c) + dt, c.id);
        const e2 = sn.t;
        const guide = sn.snapped ? e2 : null;
        if (!media) {
          show(ev, `${Math.max(0.1, e2 - c.start).toFixed(2)} s`);
          return { type: "clip", id: c.id, out: Math.max(0.1, e2 - c.start), guide };
        }
        const max = media.duration > 0 && media.kind !== "image" ? media.duration : Infinity;
        const out = Math.min(max, Math.max(c.in + 0.05, c.in + (e2 - c.start) * c.speed));
        show(ev, `${((out - c.in) / c.speed).toFixed(2)} s`);
        return { type: "clip", id: c.id, out, guide };
      },
      done: (g) => {
        if (mode === "move") {
          const toMain = g.trackId === main.id && trackById(project, c.trackId).kind === "video";
          if (magnet && toMain) apply((p) => ops.insertOnTrack(p, c.id, g.pointerT, main.id));
          else apply((p) => ops.moveClip(p, c.id, { start: g.start, trackId: g.trackId }));
        } else if (mode === "trim-l") apply((p) => ops.trimClip(p, c.id, !media ? { in: g.start - c.start } : { in: g.in }));
        else apply((p) => ops.trimClip(p, c.id, { out: g.out }));
      },
    });
  };

  // Fade handles on a clip's top corners: drag inward to fade in/out. Video
  // fades the picture and its sound together; audio fades the sound.
  const onFadeDown = (e, c, side) => {
    const track = trackById(project, c.trackId);
    if (track.locked) return;
    const len = clipLength(c);
    const cur = side === "in" ? Math.max(c.fadeIn, c.animIn?.type === "fade" ? c.animIn.duration : 0) : Math.max(c.fadeOut, c.animOut?.type === "fade" ? c.animOut.duration : 0);
    startDrag(e, {
      compute: (dt, ev) => {
        const d = Math.min(len * 0.9, Math.max(0, cur + (side === "in" ? dt : -dt)));
        setHint({ x: ev.clientX, y: ev.clientY, text: `Fade ${side} ${d.toFixed(2)} s` });
        return { type: "fade", id: c.id, d };
      },
      done: (g) => {
        const d = Math.round(g.d * 100) / 100;
        const patch = {};
        if (track.kind !== "audio") patch[side === "in" ? "animIn" : "animOut"] = d > 0.02 ? { type: "fade", duration: d } : null;
        if (track.kind !== "text") patch[side === "in" ? "fadeIn" : "fadeOut"] = d;
        apply((p) => ops.setClip(p, c.id, patch));
      },
    });
  };

  const onBleepDown = (e, b, mode) => {
    setSelection({ ...EMPTY_SELECTION, bleep: b.id });
    startDrag(e, {
      compute: (dt) => {
        if (mode === "move") {
          const s = snapT(b.start + dt, b.id).t;
          return { type: "bleep", id: b.id, start: Math.max(0, s), end: Math.max(0, s) + (b.end - b.start) };
        }
        if (mode === "l") return { type: "bleep", id: b.id, start: Math.min(snapT(b.start + dt, b.id).t, b.end - 0.05), end: b.end };
        return { type: "bleep", id: b.id, start: b.start, end: Math.max(snapT(b.end + dt, b.id).t, b.start + 0.05) };
      },
      done: (g) => apply((p) => ops.setBleep(p, b.id, { start: g.start, end: g.end })),
    });
  };

  const scrub = (e) => {
    if (e.button !== 0) return;
    playing.set(false);
    playhead.set(snapT(timeAt(e.clientX)).t);
    const onMove = (ev) => playhead.set(timeAt(ev.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Box selection: drag on an empty part of the timeline to draw a rectangle;
  // every clip it touches gets selected (Shift/Ctrl adds to the selection).
  // A plain click clears the selection and moves the playhead there.
  const startMarquee = (e) => {
    const inner = innerRef.current;
    const el = scrollRef.current;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? selection.clips : [];
    const toContent = (cx, cy) => {
      const r = inner.getBoundingClientRect();
      return { x: cx - r.left, y: cy - r.top };
    };
    const a = toContent(e.clientX, e.clientY);
    let last = { x: e.clientX, y: e.clientY };
    let moved = false;
    let raf = 0;
    const update = () => {
      const b = toContent(last.x, last.y);
      const minX = el.scrollLeft + HEADER_W;
      const rect = { x0: Math.max(minX, Math.min(a.x, b.x)), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
      setBox(rect);
      const r = inner.getBoundingClientRect();
      const hit = [];
      for (const node of inner.querySelectorAll(".clip[data-id]")) {
        if (node.dataset.locked) continue;
        const cr = node.getBoundingClientRect();
        if (cr.right - r.left > rect.x0 && cr.left - r.left < rect.x1 && cr.bottom - r.top > rect.y0 && cr.top - r.top < rect.y1) hit.push(node.dataset.id);
      }
      setSelection({ ...EMPTY_SELECTION, clips: [...new Set([...base, ...hit])] });
    };
    // Scroll when the pointer nears an edge so long ranges can be boxed.
    const edge = () => {
      const sr = el.getBoundingClientRect();
      const speed = (d) => Math.min(28, Math.ceil(d / 3));
      let dx = 0;
      let dy = 0;
      if (last.x < sr.left + HEADER_W + 24) dx = -speed(sr.left + HEADER_W + 24 - last.x);
      else if (last.x > sr.right - 24) dx = speed(last.x - sr.right + 24);
      if (last.y < sr.top + 36) dy = -speed(sr.top + 36 - last.y);
      else if (last.y > sr.bottom - 16) dy = speed(last.y - sr.bottom + 16);
      if (dx || dy) {
        el.scrollLeft += dx;
        el.scrollTop += dy;
        update();
      }
      raf = requestAnimationFrame(edge);
    };
    const onMove = (ev) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      if (!moved) {
        moved = true;
        raf = requestAnimationFrame(edge);
      }
      update();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      cancelAnimationFrame(raf);
      setBox(null);
      if (moved || additive) return;
      setSelection(EMPTY_SELECTION);
      playing.set(false);
      playhead.set(timeAt(e.clientX));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const onLaneDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (tool === "blade") {
      setSelection(EMPTY_SELECTION);
      return scrub(e);
    }
    startMarquee(e);
  };

  // Drops: media from the library (new clip) or library items onto a clip.
  const onDrop = (e, track, clip) => {
    const mediaId = e.dataTransfer.getData("application/x-cutroom-media");
    const raw = e.dataTransfer.getData("application/x-cutroom-item");
    e.preventDefault();
    e.stopPropagation();
    const at = snapT(timeAt(e.clientX)).t;
    if (mediaId) {
      const m = mediaById(project, mediaId);
      const kind = m?.hasVideo ? "video" : "audio";
      return actions.addMedia(mediaId, { start: at, trackId: track?.kind === kind ? track.id : undefined });
    }
    if (!raw) return;
    const item = JSON.parse(raw);
    if (item.kind === "text") {
      return apply((p) => ops.addText(p, { text: item.id === "arabic" ? "نص" : "Text", style: byId(TEXT_STYLES, item.id)?.style, start: at, duration: 3, trackId: track?.kind === "text" ? track.id : undefined }).project);
    }
    if (!clip || isText(clip)) return;
    if (item.kind === "effect") apply((p) => ops.setClip(p, clip.id, { effects: [...clip.effects.filter((x) => x.id !== item.id), { id: item.id, intensity: 60 }] }));
    if (item.kind === "filter") apply((p) => ops.setClip(p, clip.id, { filter: { id: item.id, intensity: 100 } }));
    if (item.kind === "transition" && apply((p) => ops.setTransition(p, clip.id, { type: item.id, duration: 0.5 }))) setSelection({ ...EMPTY_SELECTION, transition: clip.id });
  };
  const allowDrop = (e) => {
    const types = e.dataTransfer.types;
    if (types.includes("application/x-cutroom-media") || types.includes("application/x-cutroom-item")) e.preventDefault();
  };

  // ---- right-click menus (built at render time so they use fresh actions)
  const openMenu = (e, entry) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, ...entry });
  };
  const onClipMenu = (e, c) => {
    if (!selection.clips.includes(c.id)) setSelection({ ...EMPTY_SELECTION, clips: [c.id] });
    openMenu(e, { kind: "clip", id: c.id });
  };
  const menuItems = () => {
    if (!menu) return [];
    if (menu.kind === "clip") {
      const c = project.clips.find((x) => x.id === menu.id);
      if (!c) return [];
      const media = hasMedia(c) && mediaById(project, c.mediaId);
      const kind = trackById(project, c.trackId)?.kind;
      const count = Math.max(1, selection.clips.length);
      const many = count > 1 ? ` ${count} clips` : "";
      return [
        media && { label: "Open in source monitor", icon: "source", run: () => actions.openSource(c.mediaId) },
        { label: "Split at playhead", icon: "split", shortcut: sc("split"), run: actions.split },
        "-",
        { label: `Copy${many}`, icon: "copy", shortcut: sc("copy"), run: actions.copy },
        { label: "Paste at playhead", icon: "paste", shortcut: sc("paste"), run: actions.paste },
        { label: `Duplicate${many}`, icon: "duplicate", shortcut: sc("duplicate"), run: actions.duplicate },
        "-",
        media &&
          media.kind !== "image" && {
            label: "Speed",
            icon: "speed",
            items: [
              ...[0.5, 1, 1.5, 2, 4].map((s) => ({ label: `${s}×`, checked: Math.abs(c.speed - s) < 1e-3, run: () => actions.setSpeed(s) })),
              "-",
              ...Object.entries(ops.SPEED_RAMPS).map(([id, v]) => ({ label: v.label, icon: "rate", run: () => actions.speedRamp(id) })),
            ],
          },
        media && media.kind !== "image" && { label: "Reverse", icon: "reverse", run: actions.reverse },
        media && kind === "video" && { label: "Freeze frame at playhead", icon: "freeze", run: actions.freeze },
        media && kind === "video" && media.hasAudio && { label: "Extract audio", icon: "music", run: actions.extractAudio },
        media && kind === "video" && media.kind !== "image" && { label: "Split at scene changes", icon: "scenes", run: actions.scenes },
        media && { label: c.muted ? "Unmute clip" : "Mute clip", icon: c.muted ? "volume" : "mute", run: actions.toggleClipMute },
        { swatches: [null, ...LABELS], label: "Label", value: c.label, onPick: (l) => actions.setLabel(l) },
        "-",
        { label: `Delete${many}`, icon: "trash", shortcut: sc("remove"), danger: true, run: () => actions.remove(false) },
        { label: "Ripple delete", icon: "gap", shortcut: sc("rippleRemove"), danger: true, run: actions.rippleRemove },
      ];
    }
    if (menu.kind === "lane") {
      const track = trackById(project, menu.trackId);
      return [
        { label: "Paste here", icon: "paste", disabled: !actions.canPaste(), run: () => actions.paste(menu.t) },
        { label: "Select all on this track", icon: "cursor", disabled: !track, run: () => actions.selectTrack(menu.trackId) },
        { label: "Select everything after this point", icon: "append", run: () => actions.selectForward(menu.t) },
        { label: "Select all", icon: "layers", shortcut: sc("selectAll"), run: actions.selectAll },
        "-",
        { label: "Add marker here", icon: "marker", run: () => apply((p) => ops.addMarker(p, menu.t)) },
        { label: "Move playhead here", icon: "cursor", run: () => playhead.set(menu.t) },
        { label: "Close all gaps", icon: "gap", run: actions.closeGaps },
        "-",
        { label: "Add track", icon: "plus", items: ["video", "audio", "text"].map((kd) => ({ label: `${kd[0].toUpperCase() + kd.slice(1)} track`, icon: KIND_ICON[kd], run: () => actions.addTrack(kd) })) },
      ];
    }
    if (menu.kind === "track") {
      const track = trackById(project, menu.trackId);
      if (!track) return [];
      const isMain = track.id === main.id;
      return [
        { heading: isMain ? "Main track" : track.name },
        !isMain && { label: "Rename", icon: "text", run: () => setRenaming(track.id) },
        { label: "Select all clips on track", icon: "cursor", run: () => actions.selectTrack(track.id) },
        "-",
        track.kind !== "text" && { label: track.muted ? "Unmute track" : "Mute track", icon: track.muted ? "volume" : "mute", run: () => apply((p) => ops.setTrack(p, track.id, { muted: !track.muted })) },
        track.kind !== "audio" && { label: track.hidden ? "Show track" : "Hide track", icon: track.hidden ? "eye" : "eyeOff", run: () => apply((p) => ops.setTrack(p, track.id, { hidden: !track.hidden })) },
        { label: track.locked ? "Unlock track" : "Lock track", icon: track.locked ? "unlock" : "lock", run: () => apply((p) => ops.setTrack(p, track.id, { locked: !track.locked })) },
        "-",
        { label: "Add track", icon: "plus", items: ["video", "audio", "text"].map((kd) => ({ label: `${kd[0].toUpperCase() + kd.slice(1)} track`, icon: KIND_ICON[kd], run: () => actions.addTrack(kd) })) },
        { label: "Delete track", icon: "trash", danger: true, disabled: isMain, run: () => actions.removeTrack(track.id) },
      ];
    }
    return [];
  };

  const ghostOf = (item) => {
    if (!drag) return item;
    if (drag.type === "group") return drag.ids.includes(item.id) ? { ...item, start: item.start + drag.dt } : item;
    return drag.id === item.id ? { ...item, ...drag } : item;
  };
  const t0 = view.left / pps;
  const t1 = (view.left + view.width - HEADER_W) / pps;
  const step = STEPS.find((s) => s * pps >= 90) ?? 3600;
  const minor = step * pps >= 50 ? step / (String(step).startsWith("15") || String(step).startsWith("3") ? 3 : 5) : step;
  const ticks = [];
  for (let t = Math.floor(t0 / step) * step; t <= t1 + step; t += step) ticks.push(t);
  const fmt = (t) => formatTime(t, project.canvas.fps).replace(/:00$/, "");
  const empty = project.clips.length === 0;
  const sizeLabel = { compact: "Compact tracks", normal: "Normal tracks", tall: "Tall tracks" };

  return (
    <section className={`timeline tool-${tool} size-${size}`}>
      <div className="tl-toolbar">
        <div className="tool-group tools">
          <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")} title={`Select (${sc("toolSelect")}): click a clip, or drag on empty space to box-select`}><Icon name="cursor" /></button>
          <button className={tool === "blade" ? "active" : ""} onClick={() => setTool("blade")} title={`Split tool (${sc("toolBlade")}): click a clip to cut it`}><Icon name="blade" /></button>
          <button className={tool === "roll" ? "active" : ""} onClick={() => setTool("roll")} title="Roll: drag a cut to move it (both clips adjust)"><Icon name="roll" /></button>
          <button className={tool === "slip" ? "active" : ""} onClick={() => setTool("slip")} title="Slip: drag a clip to show a different part of it"><Icon name="slip" /></button>
          <button className={tool === "rate" ? "active" : ""} onClick={() => setTool("rate")} title="Rate stretch: drag a clip's end to speed it up or slow it down"><Icon name="rate" /></button>
        </div>
        <div className="tool-group">
          <button onClick={undo} disabled={!canUndo} title={`Undo (${sc("undo")})`}><Icon name="undo" /></button>
          <button onClick={redo} disabled={!canRedo} title={`Redo (${sc("redo")})`}><Icon name="redo" /></button>
        </div>
        <div className="tool-group">
          <button onClick={actions.split} title={`Split (${sc("split")})`}><Icon name="split" /></button>
          <button onClick={() => actions.deleteSide("left")} title={`Delete left of playhead (${sc("deleteLeft")})`}><Icon name="delLeft" /></button>
          <button onClick={() => actions.deleteSide("right")} title={`Delete right of playhead (${sc("deleteRight")})`}><Icon name="delRight" /></button>
          <button onClick={() => actions.remove(false)} title={`Delete (${sc("remove")})`}><Icon name="trash" /></button>
          <button onClick={actions.duplicate} title={`Duplicate (${sc("duplicate")})`}><Icon name="duplicate" /></button>
        </div>
        <div className="tool-group">
          <button onClick={actions.freeze} title="Freeze frame"><Icon name="freeze" /></button>
          <button onClick={actions.reverse} title="Reverse"><Icon name="reverse" /></button>
          <button onClick={actions.mirror} title="Mirror"><Icon name="mirror" /></button>
          <button onClick={actions.rotate} title="Rotate 90°"><Icon name="rotate" /></button>
          <button onClick={actions.scenes} title="Split at scene changes"><Icon name="scenes" /></button>
          <button onClick={actions.closeGaps} title="Close all gaps"><Icon name="gap" /></button>
        </div>
        <div className="tool-group labeled">
          <button onClick={() => actions.punchIn()} title={`Punch-in zoom at playhead (${sc("punchIn")})`}><Icon name="zoom" /> <span>Punch-in</span></button>
          <button onClick={actions.bleep} title={`Bleep at playhead or I–O range (${sc("bleep")})`}><Icon name="bleep" /> <span>Bleep</span></button>
        </div>
        {selection.clips.length > 1 && <span className="sel-count">{selection.clips.length} selected</span>}
        <div className="spacer" />
        <div className="tool-group">
          <button className={magnet ? "active" : ""} onClick={() => setMagnet(!magnet)} title="Main track magnet: no gaps on the main track"><Icon name="magnet" /></button>
          <button className={snap ? "active" : ""} onClick={() => setSnap(!snap)} title={`Auto snapping (${sc("snap")})`}><Icon name="snap" /></button>
          <button onClick={() => setSize(size === "compact" ? "normal" : size === "normal" ? "tall" : "compact")} title={`${sizeLabel[size]} (click to change)`}><Icon name={size === "tall" ? "rowsTall" : size === "compact" ? "rowsCompact" : "rows"} /></button>
        </div>
        <div className="tool-group zoom-group">
          <button onClick={() => zoomBy(1 / 1.5)} title={`Zoom out (${sc("zoomOut")})`}><Icon name="minus" /></button>
          <input className="zoom" type="range" min="0" max="100" value={Math.round((Math.log(pps / 0.5) / Math.log(1600)) * 100)} onChange={(e) => setPps(0.5 * 1600 ** (e.target.value / 100))} title="Zoom (Ctrl + wheel)" />
          <button onClick={() => zoomBy(1.5)} title={`Zoom in (${sc("zoomIn")})`}><Icon name="plus" /></button>
          <button onClick={fit} title={`Fit the whole edit (${sc("fit")})`}><Icon name="fit" /></button>
        </div>
      </div>
      <div
        className="tl-scroll"
        ref={scrollRef}
        onWheel={(e) => {
          if (e.ctrlKey) {
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX);
          } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.currentTarget.scrollHeight <= e.currentTarget.clientHeight) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
        onPointerMove={(e) => tool === "blade" && setHover({ t: timeAt(e.clientX), kind: "blade" })}
        onPointerLeave={() => setHover(null)}
      >
        <div className="tl-inner" ref={innerRef} style={{ width: HEADER_W + contentW }}>
          <div className="tl-row ruler-row">
            <div className="tl-head corner">
              <AddTrackButton onAdd={actions.addTrack} />
              <span className="corner-tc">{formatTime(duration, project.canvas.fps)}</span>
            </div>
            <div
              className="tl-ruler"
              style={{ backgroundSize: `${minor * pps}px 5px` }}
              onPointerDown={scrub}
              onPointerMove={(e) => tool !== "blade" && setHover({ t: timeAt(e.clientX), kind: "ruler" })}
              onPointerLeave={() => setHover(null)}
            >
              {range.in != null && range.out != null && range.out > range.in && <div className="range-band" style={{ left: range.in * pps, width: (range.out - range.in) * pps }} />}
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * pps }}>
                  <span>{fmt(t)}</span>
                </div>
              ))}
              {flags.map((m) => (
                <div
                  key={m.id}
                  className={`flag ${m.color} ${selection.markers.includes(m.id) ? "selected" : ""}`}
                  style={{ left: m.time * pps }}
                  title={`${m.label || "Marker"} (double-click to jump)`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelection({ ...EMPTY_SELECTION, markers: [m.id] });
                  }}
                  onDoubleClick={() => playhead.set(m.time)}
                >
                  {m.label && m.label !== "beat" && pps * 4 > m.label.length * 6 && <span>{m.label}</span>}
                </div>
              ))}
              {hover?.kind === "ruler" && <div className="ruler-hover" style={{ left: hover.t * pps }}><span>{formatTime(hover.t, project.canvas.fps)}</span></div>}
            </div>
          </div>

          {project.bleeps.length > 0 && (
            <div className="tl-row lane-row">
              <div className="tl-head small-head"><Icon name="bleep" size={13} /> Bleeps</div>
              <div className="tl-lane" onPointerDown={onLaneDown}>
                {project.bleeps.map((b0) => {
                  const b = ghostOf(b0);
                  return (
                    <div key={b.id} className={`bleep ${selection.bleep === b.id ? "selected" : ""}`} style={{ left: b.start * pps, width: Math.max(4, (b.end - b.start) * pps) }} onPointerDown={(e) => onBleepDown(e, b0, "move")}>
                      <div className="handle l" onPointerDown={(e) => onBleepDown(e, b0, "l")} />
                      <div className="handle r" onPointerDown={(e) => onBleepDown(e, b0, "r")} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {pauses.length > 0 && (
            <div className="tl-row lane-row">
              <div className="tl-head small-head"><Icon name="pause2" size={13} /> Pauses</div>
              <div className="tl-lane" onPointerDown={onLaneDown}>
                {pauses.map((m) => (
                  <div
                    key={m.id}
                    className={`pause ${selection.markers.includes(m.id) ? "selected" : ""}`}
                    style={{ left: m.time * pps, width: Math.max(3, (m.end - m.time) * pps) }}
                    title={`${(m.end - m.time).toFixed(1)} s pause`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelection((s) => {
                        const has = s.markers.includes(m.id);
                        return { ...EMPTY_SELECTION, markers: e.shiftKey || e.ctrlKey ? (has ? s.markers.filter((x) => x !== m.id) : [...s.markers, m.id]) : [m.id] };
                      });
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {project.tracks.map((track) => {
            const clips = project.clips.map(ghostOf).filter((c) => c.trackId === track.id);
            const isMain = track.id === main.id;
            const h = rowH(track);
            return (
              <div key={track.id} className={`tl-row track-row ${track.kind} ${isMain ? "main" : ""}`} style={{ height: h }} ref={(n) => (n ? rowRefs.current.set(track.id, n) : rowRefs.current.delete(track.id))}>
                <div className={`tl-head kind-${track.kind}`} onContextMenu={(e) => openMenu(e, { kind: "track", trackId: track.id })}>
                  <span className="kind-icon"><Icon name={KIND_ICON[track.kind]} size={13} /></span>
                  {renaming === track.id ? (
                    <input
                      className="track-rename"
                      autoFocus
                      defaultValue={track.name}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        setRenaming(null);
                        if (v && v !== track.name) apply((p) => ops.setTrack(p, track.id, { name: v }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <span className="track-name" onDoubleClick={() => !isMain && setRenaming(track.id)} title={isMain ? "Main track" : `${track.name} (double-click to rename)`}>
                      {isMain ? "Main" : track.name}
                    </span>
                  )}
                  <div className="track-btns">
                    <button className={`tiny ${track.locked ? "off" : ""}`} onClick={() => apply((p) => ops.setTrack(p, track.id, { locked: !track.locked }))} title={track.locked ? "Unlock" : "Lock"}>
                      <Icon name={track.locked ? "lock" : "unlock"} size={13} />
                    </button>
                    {track.kind !== "audio" && (
                      <button className={`tiny ${track.hidden ? "off" : ""}`} onClick={() => apply((p) => ops.setTrack(p, track.id, { hidden: !track.hidden }))} title={track.hidden ? "Show" : "Hide"}>
                        <Icon name={track.hidden ? "eyeOff" : "eye"} size={13} />
                      </button>
                    )}
                    {track.kind !== "text" && (
                      <button className={`tiny ${track.muted ? "off" : ""}`} onClick={() => apply((p) => ops.setTrack(p, track.id, { muted: !track.muted }))} title={track.muted ? "Unmute" : "Mute"}>
                        <Icon name={track.muted ? "mute" : "volume"} size={13} />
                      </button>
                    )}
                  </div>
                </div>
                <div
                  className={`tl-lane ${track.hidden ? "dim" : ""} ${track.locked ? "locked" : ""}`}
                  onPointerDown={onLaneDown}
                  onContextMenu={(e) => openMenu(e, { kind: "lane", trackId: track.id, t: timeAt(e.clientX) })}
                  onDragOver={allowDrop}
                  onDrop={(e) => onDrop(e, track, null)}
                >
                  {clips.map((c) => (
                    <Clip
                      key={c.id}
                      c={c}
                      track={track}
                      isMain={isMain}
                      h={h}
                      pps={pps}
                      selected={selection.clips.includes(c.id)}
                      dragging={drag && (drag.id === c.id || (drag.type === "group" && drag.ids.includes(c.id)))}
                      onDown={onClipDown}
                      onFade={onFadeDown}
                      onMenu={onClipMenu}
                      onOpen={(x) => (actions.openSource(x.mediaId), setTimeout(() => sourceControl.current?.seek(sourceAt(x, Math.min(Math.max(playhead.get(), x.start), clipEnd(x) - 0.01))), 300))}
                      onDrop={onDrop}
                      allowDrop={allowDrop}
                      project={project}
                      waves={waves}
                      strips={strips}
                      original={project.clips.find((x) => x.id === c.id)}
                    />
                  ))}
                  {clips.filter((c) => c.transition).map((c) => (
                    <button
                      key={`tr-${c.id}`}
                      className={`tr-marker ${selection.transition === c.id ? "selected" : ""}`}
                      style={{ left: c.start * pps }}
                      title={`Transition: ${c.transition.type} (${c.transition.duration.toFixed(2)} s)`}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelection({ ...EMPTY_SELECTION, transition: c.id });
                      }}
                    >
                      <Icon name="transition" size={11} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          {empty && (
            <div className="tl-empty" style={{ left: HEADER_W }} onDragOver={allowDrop} onDrop={(e) => onDrop(e, main, null)}>
              <Icon name="film" size={22} />
              <b>Drag media here to start editing</b>
              <span>or press {sc("import") || "Ctrl+I"} to import files</span>
            </div>
          )}

          <div className="overlay-lanes" style={{ left: HEADER_W }}>
            {pauses.map((m) => <div key={m.id} className={`pause-wash ${selection.markers.includes(m.id) ? "selected" : ""}`} style={{ left: m.time * pps, width: (m.end - m.time) * pps }} />)}
            {hover && <div className={`hover-line ${hover.kind}`} style={{ left: hover.t * pps }} />}
            {drag?.guide != null && <div className="snap-guide" style={{ left: drag.guide * pps }} />}
          </div>
          {box && <div className="marquee" style={{ left: box.x0, top: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 }} />}
          <Playhead pps={pps} scrollRef={scrollRef} fps={project.canvas.fps} />
        </div>
      </div>
      {hint && (
        <div className="drag-hint" style={{ left: hint.x + 14, top: hint.y - 30 }}>
          {hint.text}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
    </section>
  );
}

function AddTrackButton({ onAdd }) {
  const [open, setOpen] = useState(null);
  return (
    <>
      <button className="tiny add-track" title="Add a track" onClick={(e) => setOpen({ x: e.clientX, y: e.clientY })}>
        <Icon name="plus" size={13} />
      </button>
      {open && (
        <ContextMenu
          x={open.x}
          y={open.y}
          onClose={() => setOpen(null)}
          items={[{ heading: "Add track" }, ...["video", "audio", "text"].map((kd) => ({ label: `${kd[0].toUpperCase() + kd.slice(1)} track`, icon: KIND_ICON[kd], run: () => onAdd(kd) }))]}
        />
      )}
    </>
  );
}

function Clip({ c, track, isMain, h, pps, selected, dragging, onDown, onFade, onMenu, onOpen, onDrop, allowDrop, project, waves, strips, original }) {
  const text = isText(c);
  const adj = !!c.adjustment;
  const media = hasMedia(c) && mediaById(project, c.mediaId);
  const len = !media ? c.out - c.in : (c.out - c.in) / c.speed;
  const w = Math.max(2, len * pps);
  const wave = media && waves[c.mediaId];
  const strip = media && strips[c.mediaId];
  const badges = [];
  if (!text) {
    if (media && Math.abs(c.speed - 1) > 1e-3) badges.push(`${c.speed.toFixed(2).replace(/\.?0+$/, "")}×`);
    if (media && c.volume !== 1) badges.push(`${Math.round(c.volume * 100)}%`);
    if (c.filter) badges.push("look");
    if (["lift", "gamma", "gain", "offset"].some((x) => c.color[x].x || c.color[x].y || c.color[x].l) || c.color.curve.length > 2) badges.push("grade");
    if (c.effects.length) badges.push(`${c.effects.length} fx`);
    if (c.chroma.enabled) badges.push("key");
    if (media?.derivedFrom) badges.push("rev");
  }
  const fi = Math.max(c.fadeIn, c.animIn?.type === "fade" ? c.animIn.duration : 0);
  const fo = Math.max(c.fadeOut, c.animOut?.type === "fade" ? c.animOut.duration : 0);
  const labelH = isMain ? 20 : 18;
  return (
    <div
      className={`clip ${track.kind} ${adj ? "adjustment" : (media?.kind ?? "text")} ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${c.muted ? "muted" : ""} ${c.label ? `labeled label-${c.label}` : ""} ${w < 40 ? "narrow" : ""}`}
      data-id={c.id}
      data-locked={track.locked ? "1" : undefined}
      style={{ left: c.start * pps, width: w }}
      onPointerDown={(e) => onDown(e, original, "move")}
      onContextMenu={(e) => onMenu(e, original)}
      onDoubleClick={() => media && onOpen(original)}
      onDragOver={allowDrop}
      onDrop={(e) => onDrop(e, track, original)}
      title={text ? c.text : adj ? "Adjustment layer: grades everything below it" : `${media?.name}\n${formatTime(c.start, project.canvas.fps)} → ${formatTime(c.start + len, project.canvas.fps)} (${len.toFixed(2)} s)\nDouble-click: open in source monitor · Right-click: more`}
    >
      {track.kind === "video" && strip && <Filmstrip strip={strip} clip={c} width={w} height={Math.max(8, h - labelH - 2)} pps={pps} />}
      <div className="clip-label">
        {c.muted && <Icon name="mute" size={11} />}
        <span className="clip-name">{text ? c.text : adj ? "Adjustment layer" : media?.name}</span>
        {media && w > 120 && <span className="clip-dur">{formatTime(len, project.canvas.fps)}</span>}
        {w > 160 && badges.map((b) => <span key={b} className="badge">{b}</span>)}
      </div>
      {wave && media?.hasAudio && w > 24 && <Wave wave={wave} from={c.in} to={c.out} width={w} kind={track.kind} height={track.kind === "audio" ? Math.max(12, h - labelH - 4) : Math.max(10, Math.round(h * 0.24))} />}
      {c.keyframes.map((x, i) => <span key={i} className="kf" style={{ left: x.t * pps }} title={`${x.scale.toFixed(2)}×`} />)}
      {(fi > 0 || fo > 0) && (
        <svg className="fades" width={w} height="100%" preserveAspectRatio="none" viewBox={`0 0 ${w} 10`}>
          {fi > 0 && <polygon points={`0,0 ${fi * pps},0 0,10`} />}
          {fo > 0 && <polygon points={`${w},0 ${w - fo * pps},0 ${w},10`} />}
        </svg>
      )}
      {!adj && w > 30 && (
        <>
          <span className="fade-handle l" style={{ left: Math.min(w - 10, fi * pps) }} onPointerDown={(e) => onFade(e, original, "in")} title="Drag to fade in" />
          <span className="fade-handle r" style={{ right: Math.min(w - 10, fo * pps) }} onPointerDown={(e) => onFade(e, original, "out")} title="Drag to fade out" />
        </>
      )}
      <div className="handle l" onPointerDown={(e) => onDown(e, original, "trim-l")} />
      <div className="handle r" onPointerDown={(e) => onDown(e, original, "trim-r")} />
    </div>
  );
}

const images = new Map();
function spriteImage(path) {
  if (!images.has(path)) {
    const img = new Image();
    img.src = mediaUrl(path);
    images.set(path, img);
  }
  return images.get(path);
}

function Filmstrip({ strip, clip, width, height, pps }) {
  const ref = useRef(null);
  const w = Math.min(4096, Math.max(1, Math.round(width)));
  useEffect(() => {
    const img = spriteImage(strip.image);
    const draw = () => {
      const canvas = ref.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, w, height);
      const tw = Math.max(8, (strip.tileW * height) / strip.tileH);
      const scale = w / width; // canvas px per layout px
      for (let x = 0; x < width; x += tw) {
        const t = clip.in + ((x + tw / 2) / pps) * (clip.speed || 1);
        const i = strip.count === 1 ? 0 : Math.min(strip.count - 1, Math.max(0, Math.floor(t / strip.interval)));
        const sx = (i % strip.cols) * strip.tileW;
        const sy = Math.floor(i / strip.cols) * strip.tileH;
        ctx.drawImage(img, sx, sy, strip.tileW, strip.tileH, x * scale, 0, tw * scale, height);
      }
    };
    if (img.complete) draw();
    else img.addEventListener("load", draw, { once: true });
  }, [strip, clip.in, clip.speed, w, width, height, pps]);
  return <canvas ref={ref} className="filmstrip" width={w} height={height} style={{ height }} />;
}

function Playhead({ pps, scrollRef, fps }) {
  const t = useStore(playhead);
  const isPlaying = useStore(playing);
  const x = t * pps;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isPlaying) return;
    const visible = el.clientWidth - HEADER_W;
    if (x < el.scrollLeft || x > el.scrollLeft + visible - 40) el.scrollLeft = Math.max(0, x - 80);
  }, [x, isPlaying, scrollRef]);
  return (
    <div className="playhead" style={{ left: HEADER_W + x }}>
      <span className="playhead-head" title={formatTime(t, fps)} />
    </div>
  );
}

function Wave({ wave, from, to, width, kind, height }) {
  const ref = useRef(null);
  const w = Math.min(4096, Math.max(1, Math.round(width)));
  const h = Math.max(4, Math.round(height));
  useEffect(() => {
    const c = ref.current;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = kind === "audio" ? "rgba(178,255,222,0.85)" : "rgba(214,240,255,0.62)";
    const { peaks, perSecond } = wave;
    const a = from * perSecond;
    const span = (to - from) * perSecond;
    // Audio rows draw a mirrored waveform; video rows a bottom-aligned one.
    const mirrored = kind === "audio";
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(a + (x / w) * span);
      const i1 = Math.max(i0 + 1, Math.floor(a + ((x + 1) / w) * span));
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      const bar = Math.max(1, (m / 255) * h);
      if (mirrored) ctx.fillRect(x, (h - bar) / 2, 1, bar);
      else ctx.fillRect(x, h - bar, 1, bar);
    }
  }, [wave, from, to, w, h, kind]);
  return <canvas ref={ref} className="wave" width={w} height={h} style={{ height: h }} />;
}
