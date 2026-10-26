import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TEXT_STYLES, byId } from "../../core/catalog.js";
import { clipEnd, clipLength, formatTime, isText, mainTrack, mediaById, projectDuration, trackById } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { EMPTY_SELECTION, useEditor } from "../editor.js";
import { mediaUrl, playhead, playing, useStore } from "../state.js";
import Icon from "./icons.jsx";

const HEADER_W = 132;
const ROW_H = { video: 64, audio: 48, text: 30 };
const MAIN_H = 76;
const SNAP_PX = 8;
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

export default function Timeline() {
  const ed = useEditor();
  const { project, selection, setSelection, apply, waves, strips, range, tool, setTool, magnet, setMagnet, snap, setSnap, actions, undo, redo, canUndo, canRedo } = ed;
  const scrollRef = useRef(null);
  const rowRefs = useRef(new Map());
  const [pps, setPps] = useState(40);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [drag, setDrag] = useState(null);
  const [hoverX, setHoverX] = useState(null);
  const zoomAnchor = useRef(null);
  const fitted = useRef(false);
  const duration = projectDuration(project);
  const contentW = Math.max(view.width - HEADER_W, (duration + 20) * pps);
  const main = mainTrack(project);
  const pauses = project.markers.filter((m) => m.end != null);
  const flags = project.markers.filter((m) => m.end == null);

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
  useEffect(() => {
    if (!fitted.current && duration > 0) {
      fitted.current = true;
      fit();
    }
  }, [duration]);
  useEffect(() => {
    const z = (e) => zoomBy(e.detail);
    const f = () => fit();
    window.addEventListener("timeline-zoom", z);
    window.addEventListener("timeline-fit", f);
    return () => {
      window.removeEventListener("timeline-zoom", z);
      window.removeEventListener("timeline-fit", f);
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
  const snapT = (t, owner) => {
    if (!snap) return { t, snapped: false };
    let best = t;
    let bd = SNAP_PX / pps;
    for (const p of [...snapPoints, { t: playhead.get() }]) {
      if (owner && p.owner === owner) continue;
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

  const onClipDown = (e, c, mode) => {
    const track = trackById(project, c.trackId);
    if (track.locked) return;
    if (tool === "blade" && mode === "move") {
      e.stopPropagation();
      actions.splitClipAt(c.id, snapT(timeAt(e.clientX), c.id).t);
      return;
    }
    if (!selection.clips.includes(c.id)) selectClip(e, c);
    const media = !isText(c) && mediaById(project, c.mediaId);
    startDrag(e, {
      click: () => selectClip(e, c),
      compute: (dt, ev) => {
        if (mode === "move") {
          const len = clipLength(c);
          const a = snapT(c.start + dt, c.id);
          const b = snapT(c.start + dt + len, c.id);
          let start = c.start + dt;
          if (a.snapped && (!b.snapped || Math.abs(a.t - start) <= Math.abs(b.t - len - start))) start = a.t;
          else if (b.snapped) start = b.t - len;
          return { type: "clip", id: c.id, start: Math.max(0, start), trackId: rowAt(ev.clientY, track.kind) ?? c.trackId, pointerT: timeAt(ev.clientX) };
        }
        if (mode === "trim-l") {
          const s = snapT(c.start + dt, c.id).t;
          if (isText(c)) return { type: "clip", id: c.id, start: Math.min(s, clipEnd(c) - 0.1), out: c.out - (Math.min(s, clipEnd(c) - 0.1) - c.start) };
          const inn = Math.min(Math.max(0, c.in + (s - c.start) * c.speed), c.out - 0.05);
          return { type: "clip", id: c.id, in: inn, start: c.start + (inn - c.in) / c.speed };
        }
        const e2 = snapT(clipEnd(c) + dt, c.id).t;
        if (isText(c)) return { type: "clip", id: c.id, out: Math.max(0.1, e2 - c.start) };
        const max = media.duration > 0 && media.kind !== "image" ? media.duration : Infinity;
        return { type: "clip", id: c.id, out: Math.min(max, Math.max(c.in + 0.05, c.in + (e2 - c.start) * c.speed)) };
      },
      done: (g) => {
        if (mode === "move") {
          const toMain = g.trackId === main.id && trackById(project, c.trackId).kind === "video";
          if (magnet && toMain) apply((p) => ops.insertOnTrack(p, c.id, g.pointerT, main.id));
          else apply((p) => ops.moveClip(p, c.id, { start: g.start, trackId: g.trackId }));
        } else if (mode === "trim-l") apply((p) => ops.trimClip(p, c.id, isText(c) ? { in: g.start - c.start } : { in: g.in }));
        else apply((p) => ops.trimClip(p, c.id, { out: g.out }));
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
    playhead.set(timeAt(e.clientX));
    const onMove = (ev) => playhead.set(timeAt(ev.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const onLaneDown = (e) => {
    if (e.button !== 0) return;
    setSelection(EMPTY_SELECTION);
    scrub(e);
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
      return actions.addMedia(mediaId, { start: at, trackId: track.kind === kind ? track.id : undefined });
    }
    if (!raw) return;
    const item = JSON.parse(raw);
    if (item.kind === "text") {
      return apply((p) => ops.addText(p, { text: item.id === "arabic" ? "نص" : "Text", style: byId(TEXT_STYLES, item.id)?.style, start: at, duration: 3, trackId: track.kind === "text" ? track.id : undefined }).project);
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

  const ghostOf = (item) => (drag && drag.id === item.id ? { ...item, ...drag } : item);
  const t0 = view.left / pps;
  const t1 = (view.left + view.width - HEADER_W) / pps;
  const step = STEPS.find((s) => s * pps >= 80) ?? 3600;
  const ticks = [];
  for (let t = Math.floor(t0 / step) * step; t <= t1 + step; t += step) ticks.push(t);
  const fmt = (t) => formatTime(t, project.canvas.fps).replace(/:00$/, "");

  return (
    <section className={`timeline tool-${tool}`}>
      <div className="tl-toolbar">
        <div className="seg tools">
          <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")} title="Select (A)"><Icon name="cursor" /></button>
          <button className={tool === "blade" ? "active" : ""} onClick={() => setTool("blade")} title="Split tool (B): click a clip to cut it"><Icon name="blade" /></button>
        </div>
        <span className="divider" />
        <button className="ghost icon-only" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)"><Icon name="undo" /></button>
        <button className="ghost icon-only" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"><Icon name="redo" /></button>
        <span className="divider" />
        <button className="ghost icon-only" onClick={actions.split} title="Split (Ctrl+B)"><Icon name="split" /></button>
        <button className="ghost icon-only" onClick={() => actions.deleteSide("left")} title="Delete left (Q)"><Icon name="delLeft" /></button>
        <button className="ghost icon-only" onClick={() => actions.deleteSide("right")} title="Delete right (W)"><Icon name="delRight" /></button>
        <button className="ghost icon-only" onClick={() => actions.remove(false)} title="Delete (Del)"><Icon name="trash" /></button>
        <span className="divider" />
        <button className="ghost icon-only" onClick={actions.freeze} title="Freeze frame"><Icon name="freeze" /></button>
        <button className="ghost icon-only" onClick={actions.reverse} title="Reverse"><Icon name="reverse" /></button>
        <button className="ghost icon-only" onClick={actions.mirror} title="Mirror"><Icon name="mirror" /></button>
        <button className="ghost icon-only" onClick={actions.rotate} title="Rotate 90°"><Icon name="rotate" /></button>
        <span className="divider" />
        <button className="ghost small" onClick={() => actions.punchIn()} title="Punch-in zoom at playhead (P)"><Icon name="zoom" /> Punch-in</button>
        <button className="ghost small" onClick={actions.bleep} title="Bleep at playhead or I–O range (Shift+B)"><Icon name="bleep" /> Bleep</button>
        <div className="spacer" />
        <button className={`ghost icon-only ${magnet ? "active" : ""}`} onClick={() => setMagnet(!magnet)} title="Main track magnet: no gaps on the main track"><Icon name="magnet" /></button>
        <button className={`ghost icon-only ${snap ? "active" : ""}`} onClick={() => setSnap(!snap)} title="Auto snapping (N)"><Icon name="snap" /></button>
        <span className="divider" />
        <button className="ghost icon-only" onClick={() => zoomBy(1 / 1.5)} title="Zoom out (Ctrl -)">−</button>
        <input className="zoom" type="range" min="0" max="100" value={Math.round((Math.log(pps / 0.5) / Math.log(1600)) * 100)} onChange={(e) => setPps(0.5 * 1600 ** (e.target.value / 100))} title="Zoom (Ctrl+wheel)" />
        <button className="ghost icon-only" onClick={() => zoomBy(1.5)} title="Zoom in (Ctrl +)">+</button>
        <button className="ghost icon-only" onClick={fit} title="Fit (Shift+Z)"><Icon name="fit" /></button>
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
        onPointerMove={(e) => tool === "blade" && setHoverX(timeAt(e.clientX))}
        onPointerLeave={() => setHoverX(null)}
      >
        <div className="tl-inner" style={{ width: HEADER_W + contentW }}>
          <div className="tl-row ruler-row">
            <div className="tl-head corner" />
            <div className="tl-ruler" onPointerDown={scrub}>
              {range.in != null && range.out != null && range.out > range.in && <div className="range-band" style={{ left: range.in * pps, width: (range.out - range.in) * pps }} />}
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * pps }}>
                  <span>{fmt(t)}</span>
                </div>
              ))}
              {flags.map((m) => <div key={m.id} className={`flag ${m.color}`} style={{ left: m.time * pps }} title={m.label || "Marker"} />)}
            </div>
          </div>

          {project.bleeps.length > 0 && (
            <div className="tl-row lane-row">
              <div className="tl-head small-head">Bleeps</div>
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
              <div className="tl-head small-head">Pauses</div>
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
            const h = isMain ? MAIN_H : ROW_H[track.kind];
            return (
              <div key={track.id} className={`tl-row track-row ${track.kind} ${isMain ? "main" : ""}`} style={{ height: h }} ref={(n) => (n ? rowRefs.current.set(track.id, n) : rowRefs.current.delete(track.id))}>
                <div className="tl-head">
                  <span className="track-name">{isMain ? "Main" : track.name}</span>
                  <button className={`ghost icon-only tiny ${track.locked ? "off" : ""}`} onClick={() => apply((p) => ops.setTrack(p, track.id, { locked: !track.locked }))} title={track.locked ? "Unlock" : "Lock"}>
                    <Icon name={track.locked ? "lock" : "unlock"} size={13} />
                  </button>
                  {track.kind !== "audio" && (
                    <button className={`ghost icon-only tiny ${track.hidden ? "off" : ""}`} onClick={() => apply((p) => ops.setTrack(p, track.id, { hidden: !track.hidden }))} title={track.hidden ? "Show" : "Hide"}>
                      <Icon name={track.hidden ? "eyeOff" : "eye"} size={13} />
                    </button>
                  )}
                  {track.kind !== "text" && (
                    <button className={`ghost icon-only tiny ${track.muted ? "off" : ""}`} onClick={() => apply((p) => ops.setTrack(p, track.id, { muted: !track.muted }))} title={track.muted ? "Unmute" : "Mute"}>
                      <Icon name={track.muted ? "mute" : "volume"} size={13} />
                    </button>
                  )}
                </div>
                <div className={`tl-lane ${track.hidden ? "dim" : ""} ${track.locked ? "locked" : ""}`} onPointerDown={onLaneDown} onDragOver={allowDrop} onDrop={(e) => onDrop(e, track, null)}>
                  {clips.map((c) => (
                    <Clip key={c.id} c={c} track={track} isMain={isMain} h={h} pps={pps} selected={selection.clips.includes(c.id)} onDown={onClipDown} onDrop={onDrop} allowDrop={allowDrop} project={project} waves={waves} strips={strips} original={project.clips.find((x) => x.id === c.id)} />
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

          <div className="overlay-lanes" style={{ left: HEADER_W }}>
            {pauses.map((m) => <div key={m.id} className={`pause-wash ${selection.markers.includes(m.id) ? "selected" : ""}`} style={{ left: m.time * pps, width: (m.end - m.time) * pps }} />)}
            {tool === "blade" && hoverX != null && <div className="blade-line" style={{ left: hoverX * pps }} />}
          </div>
          <Playhead pps={pps} scrollRef={scrollRef} />
        </div>
      </div>
    </section>
  );
}

function Clip({ c, track, isMain, h, pps, selected, onDown, onDrop, allowDrop, project, waves, strips, original }) {
  const text = isText(c);
  const media = !text && mediaById(project, c.mediaId);
  const len = text ? c.out - c.in : (c.out - c.in) / c.speed;
  const w = Math.max(2, len * pps);
  const wave = media && waves[c.mediaId];
  const strip = media && strips[c.mediaId];
  const badges = [];
  if (!text) {
    if (Math.abs(c.speed - 1) > 1e-3) badges.push(`${c.speed.toFixed(2).replace(/\.?0+$/, "")}×`);
    if (c.volume !== 1) badges.push(`${Math.round(c.volume * 100)}%`);
    if (c.filter) badges.push("filter");
    if (c.effects.length) badges.push(`${c.effects.length} fx`);
    if (c.animIn || c.animOut) badges.push("anim");
    if (c.chroma.enabled) badges.push("key");
    if (media?.derivedFrom) badges.push("rev");
  }
  return (
    <div
      className={`clip ${track.kind} ${media?.kind ?? "text"} ${selected ? "selected" : ""} ${c.muted ? "muted" : ""}`}
      style={{ left: c.start * pps, width: w }}
      onPointerDown={(e) => onDown(e, original, "move")}
      onDragOver={allowDrop}
      onDrop={(e) => onDrop(e, track, original)}
      title={text ? c.text : `${media?.name}\n${formatTime(c.start, project.canvas.fps)} → ${formatTime(c.start + len, project.canvas.fps)} (${len.toFixed(2)} s)`}
    >
      {track.kind === "video" && strip && <Filmstrip strip={strip} clip={c} width={w} height={isMain ? h - 26 : h - 22} pps={pps} />}
      <div className="clip-label">
        <span className="clip-name">{text ? c.text : media?.name}</span>
        {!text && <span className="clip-dur">{formatTime(len, project.canvas.fps)}</span>}
        {badges.map((b) => <span key={b} className="badge">{b}</span>)}
      </div>
      {wave && media?.hasAudio && w > 24 && <Wave wave={wave} from={c.in} to={c.out} width={w} kind={track.kind} />}
      {c.keyframes.map((k, i) => <span key={i} className="kf" style={{ left: k.t * pps }} title={`${k.scale.toFixed(2)}×`} />)}
      {(c.fadeIn > 0 || c.fadeOut > 0) && (
        <svg className="fades" width={w} height="100%" preserveAspectRatio="none" viewBox={`0 0 ${w} 10`}>
          {c.fadeIn > 0 && <polygon points={`0,0 ${c.fadeIn * pps},0 0,10`} />}
          {c.fadeOut > 0 && <polygon points={`${w},0 ${w - c.fadeOut * pps},0 ${w},10`} />}
        </svg>
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
  return <canvas ref={ref} className="filmstrip" width={w} height={height} />;
}

function Playhead({ pps, scrollRef }) {
  const t = useStore(playhead);
  const isPlaying = useStore(playing);
  const x = t * pps;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isPlaying) return;
    const visible = el.clientWidth - HEADER_W;
    if (x < el.scrollLeft || x > el.scrollLeft + visible - 40) el.scrollLeft = Math.max(0, x - 80);
  }, [x, isPlaying, scrollRef]);
  return <div className="playhead" style={{ left: HEADER_W + x }} />;
}

function Wave({ wave, from, to, width, kind }) {
  const ref = useRef(null);
  const w = Math.min(4096, Math.max(1, Math.round(width)));
  useEffect(() => {
    const c = ref.current;
    const ctx = c.getContext("2d");
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = kind === "audio" ? "rgba(170,255,214,0.8)" : "rgba(210,240,255,0.6)";
    const { peaks, perSecond } = wave;
    const a = from * perSecond;
    const span = (to - from) * perSecond;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(a + (x / w) * span);
      const i1 = Math.max(i0 + 1, Math.floor(a + ((x + 1) / w) * span));
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      const bar = Math.max(1, (m / 255) * h);
      ctx.fillRect(x, h - bar, 1, bar);
    }
  }, [wave, from, to, w, kind]);
  return <canvas ref={ref} className="wave" width={w} height={kind === "audio" ? 28 : 16} />;
}
