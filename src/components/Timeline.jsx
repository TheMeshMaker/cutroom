import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clipEnd, clipLength, formatTime, mediaById, projectDuration, trackById } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { playhead, playing, useStore } from "../state.js";
import Icon from "./icons.jsx";

const HEADER_W = 150;
const ROW_H = { video: 68, audio: 54 };
const SNAP_PX = 8;
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

export default function Timeline({ project, selection, setSelection, apply, waves, range, onSplit, onDelete, onBleep, onPunchIn, onDropMedia }) {
  const scrollRef = useRef(null);
  const rowRefs = useRef(new Map());
  const [pps, setPps] = useState(40);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [snap, setSnap] = useState(true);
  const [drag, setDrag] = useState(null);
  const zoomAnchor = useRef(null);
  const fitted = useRef(false);
  const duration = projectDuration(project);
  const contentW = Math.max(view.width - HEADER_W, (duration + 20) * pps);
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
    setPps(Math.min(400, Math.max(1, w / Math.max(duration, 5))));
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };
  useEffect(() => {
    if (!fitted.current && duration > 0) {
      fitted.current = true;
      fit();
    }
  }, [duration]);

  // Keep the time under the cursor fixed while zooming.
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

  // Generic pointer drag: `compute(dtSeconds, event)` returns a ghost; `done`
  // commits it. A press without movement counts as a click.
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
      const clips = additive ? (has ? s.clips.filter((x) => x !== c.id) : [...s.clips, c.id]) : [c.id];
      return { clips, bleep: null, markers: [] };
    });
  };

  const onClipDown = (e, c, mode) => {
    const media = mediaById(project, c.mediaId);
    const kind = trackById(project, c.trackId).kind;
    if (!selection.clips.includes(c.id)) selectClip(e, c);
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
          return { type: "clip", id: c.id, start: Math.max(0, start), trackId: rowAt(ev.clientY, kind) ?? c.trackId };
        }
        if (mode === "trim-l") {
          const s = snapT(c.start + dt, c.id).t;
          const inn = Math.min(Math.max(0, c.in + (s - c.start)), c.out - 0.05);
          return { type: "clip", id: c.id, in: inn, start: c.start + (inn - c.in), mode };
        }
        const e2 = snapT(clipEnd(c) + dt, c.id).t;
        const max = media.duration > 0 && media.kind !== "image" ? media.duration : Infinity;
        return { type: "clip", id: c.id, out: Math.min(max, Math.max(c.in + 0.05, c.in + (e2 - c.start))), mode };
      },
      done: (g) => {
        if (mode === "move") apply((p) => ops.moveClip(p, c.id, { start: g.start, trackId: g.trackId }));
        else if (mode === "trim-l") apply((p) => ops.trimClip(p, c.id, { in: g.in }));
        else apply((p) => ops.trimClip(p, c.id, { out: g.out }));
      },
    });
  };

  const onBleepDown = (e, b, mode) => {
    setSelection({ clips: [], bleep: b.id, markers: [] });
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
    setSelection({ clips: [], bleep: null, markers: [] });
    scrub(e);
  };

  const onDrop = (e, track) => {
    const id = e.dataTransfer.getData("application/x-cutroom-media");
    if (!id) return;
    e.preventDefault();
    const media = mediaById(project, id);
    const kind = media?.hasVideo ? "video" : "audio";
    onDropMedia(id, { start: snapT(timeAt(e.clientX)).t, trackId: track.kind === kind ? track.id : undefined });
  };

  const ghostOf = (item) => (drag && drag.id === item.id ? { ...item, ...drag } : item);
  const t0 = view.left / pps;
  const t1 = (view.left + view.width - HEADER_W) / pps;
  const step = STEPS.find((s) => s * pps >= 70) ?? 3600;
  const ticks = [];
  for (let t = Math.floor(t0 / step) * step; t <= t1 + step; t += step) ticks.push(t);

  return (
    <section className="timeline">
      <div className="tl-toolbar">
        <button className="ghost" onClick={onSplit} title="Split at playhead (S)">
          <Icon name="scissors" /> Split
        </button>
        <button className="ghost" onClick={() => onDelete(false)} title="Delete (Del) · Ripple delete (Shift+Del)">
          <Icon name="trash" /> Delete
        </button>
        <button className="ghost" onClick={onBleep} title="Bleep at playhead or I/O range (B)">
          <Icon name="bleep" /> Bleep
        </button>
        <button className="ghost" onClick={onPunchIn} title="Punch-in zoom at playhead (P)">
          <Icon name="zoom" /> Punch-in
        </button>
        <span className="divider" />
        <button className="ghost small" onClick={() => apply((p) => ops.addTrack(p, "video").project)} title="Add video track">
          <Icon name="plus" /> Video track
        </button>
        <button className="ghost small" onClick={() => apply((p) => ops.addTrack(p, "audio").project)} title="Add audio track">
          <Icon name="plus" /> Audio track
        </button>
        <div className="spacer" />
        <button className={`ghost icon-only ${snap ? "active" : ""}`} onClick={() => setSnap(!snap)} title="Snapping">
          <Icon name="magnet" />
        </button>
        <button className="ghost icon-only" onClick={() => zoomBy(1 / 1.5)} title="Zoom out">
          −
        </button>
        <input className="zoom" type="range" min="0" max="100" value={Math.round((Math.log(pps / 0.5) / Math.log(1600)) * 100)} onChange={(e) => setPps(0.5 * 1600 ** (e.target.value / 100))} title="Zoom (Ctrl+wheel)" />
        <button className="ghost icon-only" onClick={() => zoomBy(1.5)} title="Zoom in">
          +
        </button>
        <button className="ghost icon-only" onClick={fit} title="Fit timeline">
          <Icon name="fit" />
        </button>
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
      >
        <div className="tl-inner" style={{ width: HEADER_W + contentW }}>
          <div className="tl-row ruler-row">
            <div className="tl-head corner">{formatTime(duration, project.canvas.fps).replace(/\.\d+$/, "")}</div>
            <div className="tl-ruler" onPointerDown={scrub}>
              {range.in != null && range.out != null && range.out > range.in && (
                <div className="range-band" style={{ left: range.in * pps, width: (range.out - range.in) * pps }} />
              )}
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * pps }}>
                  <span>{formatTime(t, project.canvas.fps).replace(/\.00$/, "")}</span>
                </div>
              ))}
              {flags.map((m) => (
                <div key={m.id} className="flag" style={{ left: m.time * pps }} title={m.label || "Marker"} />
              ))}
            </div>
          </div>

          <div className="tl-row lane-row bleep-row">
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

          {pauses.length > 0 && (
            <div className="tl-row lane-row pause-row">
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
                        return { clips: [], bleep: null, markers: e.shiftKey || e.ctrlKey ? (has ? s.markers.filter((x) => x !== m.id) : [...s.markers, m.id]) : [m.id] };
                      });
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {project.tracks.map((track) => {
            const clips = project.clips.map(ghostOf).filter((c) => c.trackId === track.id);
            return (
              <div key={track.id} className={`tl-row track-row ${track.kind}`} style={{ height: ROW_H[track.kind] }} ref={(n) => (n ? rowRefs.current.set(track.id, n) : rowRefs.current.delete(track.id))}>
                <div className="tl-head">
                  <Icon name={track.kind === "video" ? "film" : "music"} />
                  <span className="track-name">{track.name}</span>
                  {track.kind === "video" && (
                    <button className={`ghost icon-only tiny ${track.hidden ? "off" : ""}`} onClick={() => apply((p) => ops.setTrack(p, track.id, { hidden: !track.hidden }))} title={track.hidden ? "Show track" : "Hide track"}>
                      <Icon name={track.hidden ? "eyeOff" : "eye"} size={14} />
                    </button>
                  )}
                  <button className={`ghost icon-only tiny ${track.muted ? "off" : ""}`} onClick={() => apply((p) => ops.setTrack(p, track.id, { muted: !track.muted }))} title={track.muted ? "Unmute track" : "Mute track"}>
                    <Icon name={track.muted ? "mute" : "volume"} size={14} />
                  </button>
                </div>
                <div
                  className={`tl-lane ${track.hidden ? "dim" : ""}`}
                  onPointerDown={onLaneDown}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes("application/x-cutroom-media")) e.preventDefault();
                  }}
                  onDrop={(e) => onDrop(e, track)}
                >
                  {clips.map((c) => {
                    const media = mediaById(project, c.mediaId);
                    const len = c.out - c.in;
                    const w = Math.max(2, len * pps);
                    const wave = waves[c.mediaId];
                    return (
                      <div
                        key={c.id}
                        className={`clip ${track.kind} ${media?.kind} ${selection.clips.includes(c.id) ? "selected" : ""} ${c.muted ? "muted" : ""}`}
                        style={{ left: c.start * pps, width: w }}
                        onPointerDown={(e) => onClipDown(e, project.clips.find((x) => x.id === c.id), "move")}
                        title={`${media?.name}\n${formatTime(c.start, project.canvas.fps)} → ${formatTime(c.start + len, project.canvas.fps)} (${len.toFixed(2)} s)`}
                      >
                        <div className="clip-label">
                          {media?.name}
                          {c.volume !== 1 && <span className="badge">{Math.round(c.volume * 100)}%</span>}
                        </div>
                        {wave && media?.hasAudio && w > 24 && <Wave wave={wave} from={c.in} to={c.out} width={w} kind={track.kind} />}
                        {c.keyframes.map((k, i) => (
                          <span key={i} className="kf" style={{ left: k.t * pps }} title={`${k.scale.toFixed(2)}×`} />
                        ))}
                        {(c.fadeIn > 0 || c.fadeOut > 0) && (
                          <svg className="fades" width={w} height="100%" preserveAspectRatio="none" viewBox={`0 0 ${w} 10`}>
                            {c.fadeIn > 0 && <polygon points={`0,0 ${c.fadeIn * pps},0 0,10`} />}
                            {c.fadeOut > 0 && <polygon points={`${w},0 ${w - c.fadeOut * pps},0 ${w},10`} />}
                          </svg>
                        )}
                        <div className="handle l" onPointerDown={(e) => onClipDown(e, project.clips.find((x) => x.id === c.id), "trim-l")} />
                        <div className="handle r" onPointerDown={(e) => onClipDown(e, project.clips.find((x) => x.id === c.id), "trim-r")} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div className="overlay-lanes" style={{ left: HEADER_W }}>
            {pauses.map((m) => (
              <div key={m.id} className={`pause-wash ${selection.markers.includes(m.id) ? "selected" : ""}`} style={{ left: m.time * pps, width: (m.end - m.time) * pps }} />
            ))}
          </div>
          <Playhead pps={pps} scrollRef={scrollRef} />
        </div>
      </div>
    </section>
  );
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
    ctx.fillStyle = kind === "audio" ? "rgba(190,255,220,0.75)" : "rgba(200,225,255,0.55)";
    const { peaks, perSecond } = wave;
    const a = from * perSecond;
    const span = (to - from) * perSecond;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(a + (x / w) * span);
      const i1 = Math.max(i0 + 1, Math.floor(a + ((x + 1) / w) * span));
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      const bar = Math.max(1, (m / 255) * h);
      ctx.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [wave, from, to, w, kind]);
  return <canvas ref={ref} className="wave" width={w} height={kind === "audio" ? 34 : 22} />;
}
