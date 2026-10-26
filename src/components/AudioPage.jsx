import { useEffect, useRef } from "react";
import { VOICE_EFFECTS } from "../../core/catalog.js";
import { hasMedia, mediaById, trackById } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { useEditor } from "../editor.js";
import { meters, useStore } from "../state.js";
import Icon from "./icons.jsx";
import Player from "./Player.jsx";

const ROLE_INFO = {
  dialogue: { label: "Dialogue", icon: "mic", hint: "Voice: cleaned up, enhanced and level-matched." },
  music: { label: "Music", icon: "music", hint: "Ducks automatically while someone talks." },
  sfx: { label: "SFX", icon: "sparkles", hint: "Sound effects and game audio." },
  ambience: { label: "Ambience", icon: "headphones", hint: "Background room tone, kept low." },
};
const LOUDNESS = [
  [null, "Off"],
  [-14, "-14 LUFS · YouTube / Spotify"],
  [-16, "-16 LUFS · Podcasts / Apple"],
  [-23, "-23 LUFS · Broadcast (EBU R128)"],
];

const db = (v) => (v <= 0.0001 ? "-∞" : `${(20 * Math.log10(v)).toFixed(1)}`);

export default function AudioPage() {
  const ed = useEditor();
  const { project, apply } = ed;
  const audible = project.tracks.filter((t) => t.kind !== "text" && project.clips.some((c) => c.trackId === t.id && hasMedia(c) && mediaById(project, c.mediaId)?.hasAudio));
  const [target] = ed.targetClips(["video", "audio"]);
  const clip = target && hasMedia(target) && mediaById(project, target.mediaId)?.hasAudio ? target : null;
  const track = clip && trackById(project, clip.trackId);

  const setRole = (role) => {
    if (!clip) return;
    apply((p) => {
      let next = ops.setTrack(p, track.id, { role });
      if (role === "dialogue") next = ops.setClip(next, clip.id, { audio: { enhance: true, denoise: Math.max(clip.audio.denoise, 30), normalize: true } });
      if (role === "music") next = ops.setTrack(next, track.id, { duck: { enabled: true, amount: track.duck.amount }, volume: Math.min(track.volume, 0.75) });
      if (role === "ambience") next = ops.setTrack(next, track.id, { volume: Math.min(track.volume, 0.5) });
      return next;
    });
  };

  return (
    <div className="audio-page">
      <div className="audio-top">
        <Player />
        <section className="panel sound-panel">
          <div className="panel-head">
            <span>Essential Sound</span>
          </div>
          <div className="panel-body">
            {!clip ? (
              <p className="muted">Select a clip with sound (or put the playhead over one) to tag what it is. Cutroom then applies the right cleanup and mix.</p>
            ) : (
              <>
                <div className="muted small">
                  {mediaById(project, clip.mediaId).name} · track “{track.name}”
                </div>
                <div className="role-grid">
                  {Object.entries(ROLE_INFO).map(([k, r]) => (
                    <button key={k} className={`role ${track.role === k ? "active" : ""}`} onClick={() => setRole(k)}>
                      <Icon name={r.icon} size={18} />
                      {r.label}
                    </button>
                  ))}
                </div>
                {track.role && <p className="muted small">{ROLE_INFO[track.role].hint}</p>}
                {track.role === "dialogue" && (
                  <>
                    <Range label="Reduce noise" value={clip.audio.denoise} onChange={(v) => apply((p) => ops.setClip(p, clip.id, { audio: { denoise: v } }), { coalesce: "dn" })} />
                    <Check label="Enhance speech" value={clip.audio.enhance} onChange={(v) => apply((p) => ops.setClip(p, clip.id, { audio: { enhance: v } }))} />
                    <Check label="Even out loudness" value={clip.audio.normalize} onChange={(v) => apply((p) => ops.setClip(p, clip.id, { audio: { normalize: v } }))} />
                    <label className="field">
                      <span className="field-label">Voice changer</span>
                      <select value={clip.audio.voice ?? ""} onChange={(e) => apply((p) => ops.setClip(p, clip.id, { audio: { voice: e.target.value || null } }))}>
                        <option value="">None</option>
                        {VOICE_EFFECTS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                    </label>
                  </>
                )}
                {track.role === "music" && (
                  <>
                    <Check label="Duck under dialogue" value={track.duck.enabled} onChange={(v) => apply((p) => ops.setTrack(p, track.id, { duck: { ...track.duck, enabled: v } }))} />
                    <Range label="Duck amount" value={track.duck.amount} onChange={(v) => apply((p) => ops.setTrack(p, track.id, { duck: { ...track.duck, amount: v } }), { coalesce: "duck" })} />
                    {!project.tracks.some((t) => t.role === "dialogue") && <p className="warn small">Tag the voice track as Dialogue so the music knows when to duck.</p>}
                  </>
                )}
                <Range label="Clip volume" value={Math.round(clip.volume * 100)} max={400} onChange={(v) => apply((p) => ops.setClip(p, clip.id, { volume: v / 100 }), { coalesce: "cv" })} unit="%" />
              </>
            )}
          </div>
        </section>
      </div>
      <section className="panel mixer">
        <div className="panel-head">
          <span>Mixer</span>
          <span className="head-meta">Faders, pan, mute/solo per track · live meters while playing</span>
        </div>
        <div className="strips">
          {audible.map((t) => (
            <Strip key={t.id} track={t} apply={apply} soloing={project.tracks.some((x) => x.solo)} />
          ))}
          <div className="strip master">
            <div className="strip-name">Master</div>
            <Meter id="master" />
            <label className="field">
              <span className="field-label">Loudness on export</span>
              <select value={project.settings.loudness ?? ""} onChange={(e) => apply((p) => ops.setSettings(p, { loudness: e.target.value === "" ? null : Number(e.target.value) }))}>
                {LOUDNESS.map(([v, l]) => <option key={l} value={v ?? ""}>{l}</option>)}
              </select>
            </label>
          </div>
        </div>
      </section>
    </div>
  );
}

function Strip({ track, apply, soloing }) {
  const set = (patch, key) => apply((p) => ops.setTrack(p, track.id, patch), key ? { coalesce: `${key}-${track.id}` } : undefined);
  const dim = track.muted || (soloing && !track.solo);
  return (
    <div className={`strip ${dim ? "dim" : ""}`}>
      <div className="strip-name" title={track.name}>
        {track.name}
      </div>
      <select className="strip-role" value={track.role ?? ""} onChange={(e) => set({ role: e.target.value || null })}>
        <option value="">No role</option>
        {Object.entries(ROLE_INFO).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}
      </select>
      <div className="strip-body">
        <Meter id={track.id} />
        <div className="fader-wrap" title="Fader (double-click: 0 dB)">
          <span className="fader-unity" />
          <input className="fader" type="range" min="0" max="200" value={Math.round(track.volume * 100)} onChange={(e) => set({ volume: Number(e.target.value) / 100 }, "vol")} onDoubleClick={() => set({ volume: 1 })} />
        </div>
      </div>
      <div className="strip-db">{db(track.volume)} dB</div>
      <input className="pan" type="range" min="-100" max="100" value={Math.round(track.pan * 100)} onChange={(e) => set({ pan: Number(e.target.value) / 100 }, "pan")} onDoubleClick={() => set({ pan: 0 })} title="Pan (double-click: center)" />
      <div className="strip-btns">
        <button className={`small ${track.muted ? "on-red" : ""}`} onClick={() => set({ muted: !track.muted })}>M</button>
        <button className={`small ${track.solo ? "on-amber" : ""}`} onClick={() => set({ solo: !track.solo })}>S</button>
        {track.role !== "dialogue" && (
          <button className={`small ${track.duck.enabled ? "active" : ""}`} onClick={() => set({ duck: { ...track.duck, enabled: !track.duck.enabled } })} title="Duck under dialogue">
            Duck
          </button>
        )}
      </div>
    </div>
  );
}

// Peak meter with a short peak-hold.
function Meter({ id }) {
  const levels = useStore(meters);
  const hold = useRef({ v: 0, t: 0 });
  const v = Math.min(1.2, levels[id] ?? 0);
  const now = performance.now();
  if (v > hold.current.v || now - hold.current.t > 1200) hold.current = { v, t: now };
  const toPct = (x) => Math.max(0, Math.min(100, ((20 * Math.log10(Math.max(x, 1e-4)) + 60) / 66) * 100));
  return (
    <div className="meter" title={`${db(v)} dBFS`}>
      <div className="meter-fill" style={{ height: `${toPct(v)}%` }} />
      <div className="meter-hold" style={{ bottom: `${toPct(hold.current.v)}%` }} />
    </div>
  );
}

function Range({ label, value, onChange, max = 100, unit = "" }) {
  return (
    <div className="slider-row">
      <span className="sr-label">{label}</span>
      <input type="range" min="0" max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="value">
        {value}
        {unit}
      </span>
      <span />
    </div>
  );
}

function Check({ label, value, onChange }) {
  return (
    <div className="toggle-row">
      <label className="switch">
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </label>
      <span className="tr-label">{label}</span>
    </div>
  );
}
