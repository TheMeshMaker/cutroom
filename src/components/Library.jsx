import { useMemo, useState } from "react";
import { ADJUST_KEYS, EFFECTS, FILTERS, TEXT_STYLES, TRANSITIONS, DEFAULT_TEXT_STYLE } from "../../core/catalog.js";
import { detectBeats } from "../../core/analysis.js";
import { clipById, clipEnd, formatTime, isText, mediaById } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { useEditor } from "../editor.js";
import { cssFilter } from "../look.js";
import { mediaUrl } from "../state.js";
import Icon from "./icons.jsx";

const TABS = [
  ["media", "Media", "film"],
  ["audio", "Audio", "music"],
  ["text", "Text", "text"],
  ["effects", "Effects", "sparkles"],
  ["transitions", "Transitions", "transition"],
  ["filters", "Filters", "filter"],
  ["captions", "Captions", "captions"],
];

export const dragItem = (e, item) => {
  e.dataTransfer.setData("application/x-cutroom-item", JSON.stringify(item));
  e.dataTransfer.effectAllowed = "copy";
};

export function Thumb({ media, strips, className = "", style }) {
  const strip = strips[media?.id];
  if (!media) return <div className={`thumb ${className}`} style={style} />;
  if (media.kind === "image") return <div className={`thumb ${className}`} style={{ backgroundImage: `url("${mediaUrl(media.path)}")`, backgroundSize: "cover", backgroundPosition: "center", ...style }} />;
  if (!strip) return <div className={`thumb placeholder ${className}`} style={style}><Icon name={media.hasVideo ? "film" : "music"} size={22} /></div>;
  const i = Math.floor(strip.count / 3);
  const col = i % strip.cols;
  const row = Math.floor(i / strip.cols);
  return (
    <div
      className={`thumb ${className}`}
      style={{
        backgroundImage: `url("${mediaUrl(strip.image)}")`,
        backgroundSize: `${strip.cols * 100}% ${strip.rows * 100}%`,
        backgroundPosition: `${strip.cols > 1 ? (col / (strip.cols - 1)) * 100 : 0}% ${strip.rows > 1 ? (row / (strip.rows - 1)) * 100 : 0}%`,
        ...style,
      }}
    />
  );
}

export default function Library() {
  const { libraryTab, setLibraryTab } = useEditor();
  return (
    <aside className="panel library">
      <nav className="lib-tabs">
        {TABS.map(([id, label, icon]) => (
          <button key={id} className={`lib-tab ${libraryTab === id ? "active" : ""}`} onClick={() => setLibraryTab(id)}>
            <Icon name={icon} size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="lib-body">
        {libraryTab === "media" && <MediaTab />}
        {libraryTab === "audio" && <AudioTab />}
        {libraryTab === "text" && <TextTab />}
        {libraryTab === "effects" && <EffectsTab />}
        {libraryTab === "transitions" && <TransitionsTab />}
        {libraryTab === "filters" && <FiltersTab />}
        {libraryTab === "captions" && <CaptionsTab />}
      </div>
    </aside>
  );
}

function Section({ title, children, aside }) {
  return (
    <section className="lib-section">
      <div className="lib-section-head">
        <h4>{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

function MediaTab() {
  const { project, proxies, strips, actions } = useEditor();
  const used = new Set(project.clips.map((c) => c.mediaId));
  const visual = project.media.filter((m) => m.hasVideo);
  return (
    <Section title="Local">
      <div className="grid media-grid">
        <button className="import-card" onClick={actions.importMedia} title="Import (Ctrl+I)">
          <Icon name="plus" size={22} />
          <span>Import</span>
        </button>
        {visual.map((m) => {
          const proxy = proxies[m.id];
          const progress = proxy && typeof proxy === "object" && !proxy.error ? proxy.progress ?? 0 : null;
          return (
            <div
              key={m.id}
              className="media-card"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-cutroom-media", m.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onDoubleClick={() => actions.addMedia(m.id)}
              title={`${m.path}\nDrag to the timeline or click +`}
            >
              <Thumb media={m} strips={strips} />
              {m.kind !== "image" && <span className="dur">{formatTime(m.duration).replace(/:\d\d$/, "")}</span>}
              {used.has(m.id) && <span className="added">Added</span>}
              {progress != null && (
                <div className="card-progress">
                  <div style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              <button className="card-add" onClick={() => actions.addMedia(m.id)} title="Add to timeline">
                <Icon name="plus" size={14} />
              </button>
              <div className="card-name">{m.name}</div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function AudioTab() {
  const { project, selection, waves, apply, actions, notify } = useEditor();
  const audio = project.media.filter((m) => !m.hasVideo);
  const [sens, setSens] = useState(50);
  const sel = selection.clips.map((id) => clipById(project, id)).find((c) => c && !isText(c));
  const beats = () => {
    if (!sel) return notify("Select a clip with audio to detect its beats", "error");
    const wave = waves[sel.mediaId];
    if (!wave) return notify("Waveform still loading", "error");
    const times = detectBeats(wave, { sensitivity: sens / 100 })
      .filter((t) => t >= sel.in && t < sel.out)
      .map((t) => sel.start + (t - sel.in) / sel.speed)
      .filter((t) => t < clipEnd(sel));
    apply((p) => ops.addMarkers(p, times.map((time) => ({ time, label: "beat", color: "beat" }))));
    notify(`Marked ${times.length} beats`);
  };
  return (
    <>
      <Section title="Local audio" aside={<button className="small" onClick={actions.importMedia}><Icon name="plus" size={12} /> Import</button>}>
        {!audio.length && <p className="muted small">Import music, voice-overs or sound effects (WAV, MP3, M4A, FLAC…).</p>}
        <div className="list">
          {audio.map((m) => (
            <div key={m.id} className="list-item" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-cutroom-media", m.id)} onDoubleClick={() => actions.addMedia(m.id)}>
              <span className="li-icon audio"><Icon name="music" /></span>
              <span className="li-name">{m.name}</span>
              <span className="li-meta">{formatTime(m.duration).replace(/:\d\d$/, "")}</span>
              <button className="ghost icon-only small" onClick={() => actions.addMedia(m.id)} title="Add to timeline"><Icon name="plus" size={14} /></button>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Tools">
        <div className="tool-card">
          <div className="tool-title"><Icon name="headphones" /> Extract audio</div>
          <p className="muted small">Moves the selected video clip's sound onto its own audio track.</p>
          <button className="small" onClick={actions.extractAudio}>Extract from selection</button>
        </div>
        <div className="tool-card">
          <div className="tool-title"><Icon name="beat" /> Beat detection</div>
          <p className="muted small">Marks the beats of the selected clip on the timeline, for cutting to music.</p>
          <label className="field inline"><span className="field-label">Sensitivity</span><input type="range" min="0" max="100" value={sens} onChange={(e) => setSens(Number(e.target.value))} /></label>
          <button className="small" onClick={beats}>Detect beats</button>
        </div>
      </Section>
    </>
  );
}

function TextTab() {
  const { actions } = useEditor();
  return (
    <>
      <Section title="Default">
        <button className="text-add" onClick={() => actions.addText("classic")} draggable onDragStart={(e) => dragItem(e, { kind: "text", id: "classic" })}>
          <Icon name="plus" /> Add text
        </button>
      </Section>
      <Section title="Styles">
        <div className="grid style-grid">
          {TEXT_STYLES.map((s) => {
            const st = { ...DEFAULT_TEXT_STYLE, ...s.style };
            return (
              <button key={s.id} className="style-card" onClick={() => actions.addText(s.id, s.id === "arabic" ? "نص" : "Text")} draggable onDragStart={(e) => dragItem(e, { kind: "text", id: s.id })} title="Click to add (or restyle the selected text)">
                <span
                  style={{
                    fontFamily: `"${st.font}"`,
                    fontWeight: st.bold ? 700 : 400,
                    color: st.color,
                    WebkitTextStroke: st.strokeWidth ? `${Math.min(2, st.strokeWidth / 2.5)}px ${st.strokeColor}` : undefined,
                    paintOrder: "stroke fill",
                    background: st.bg ? `#${st.bg.slice(1)}` : undefined,
                    padding: st.bg ? "1px 6px" : undefined,
                    textShadow: st.shadow ? "0 2px 4px #000c" : undefined,
                  }}
                >
                  {s.id === "arabic" ? "نص" : "Aa"}
                </span>
                <small>{s.name}</small>
              </button>
            );
          })}
        </div>
      </Section>
    </>
  );
}

function sampleMedia(project) {
  return project.media.find((m) => m.hasVideo) ?? null;
}

function EffectsTab() {
  const { project, strips, actions } = useEditor();
  const sample = sampleMedia(project);
  const zero = Object.fromEntries(Object.keys(ADJUST_KEYS).map((k) => [k, 0]));
  return (
    <Section title="Video effects">
      <div className="grid fx-grid">
        {EFFECTS.map((fx) => (
          <button key={fx.id} className={`fx-card fx-${fx.id}`} onClick={() => actions.applyEffect(fx.id)} draggable onDragStart={(e) => dragItem(e, { kind: "effect", id: fx.id })} title="Click to apply to the selected clip, or drag onto a clip">
            <Thumb media={sample} strips={strips} style={{ filter: cssFilter({ adjust: zero, filter: null, effects: [{ id: fx.id, intensity: 80 }] }) }} className="fx-thumb" />
            <small>{fx.name}</small>
          </button>
        ))}
      </div>
    </Section>
  );
}

function TransitionsTab() {
  const { actions } = useEditor();
  return (
    <Section title="Transitions">
      <p className="muted small">Click to add at the cut nearest the playhead, or drag onto the second clip of a cut.</p>
      <div className="grid fx-grid">
        {TRANSITIONS.map((t) => (
          <button key={t.id} className={`fx-card tr-card tr-${t.xfade}`} onClick={() => actions.applyTransition(t.id)} draggable onDragStart={(e) => dragItem(e, { kind: "transition", id: t.id })}>
            <div className="tr-thumb"><span className="a" /><span className="b" /></div>
            <small>{t.name}</small>
          </button>
        ))}
      </div>
    </Section>
  );
}

function FiltersTab() {
  const { project, strips, actions } = useEditor();
  const sample = sampleMedia(project);
  const zero = Object.fromEntries(Object.keys(ADJUST_KEYS).map((k) => [k, 0]));
  return (
    <Section title="Filters" aside={<button className="small ghost" onClick={() => actions.applyFilter(null)}>None</button>}>
      <div className="grid fx-grid">
        {FILTERS.map((f) => (
          <button key={f.id} className="fx-card" onClick={() => actions.applyFilter(f.id)} draggable onDragStart={(e) => dragItem(e, { kind: "filter", id: f.id })}>
            <Thumb media={sample} strips={strips} className="fx-thumb" style={{ filter: cssFilter({ adjust: zero, filter: { id: f.id, intensity: 100 }, effects: [] }) }} />
            <small>{f.name}</small>
          </button>
        ))}
      </div>
    </Section>
  );
}

const LANGS = [["auto", "Auto-detect"], ["en", "English"], ["ar", "Arabic"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["tr", "Turkish"], ["ur", "Urdu"], ["hi", "Hindi"], ["id", "Indonesian"], ["ru", "Russian"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["pt", "Portuguese"]];

function CaptionsTab() {
  const { project, jobs, actions, apply } = useEditor();
  const audible = useMemo(() => {
    const used = new Set(project.clips.map((c) => c.mediaId));
    return project.media.filter((m) => used.has(m.id) && m.hasAudio);
  }, [project]);
  const [source, setSource] = useState(null);
  const [lang, setLang] = useState("auto");
  const [style, setStyle] = useState("subtitle");
  const sourceId = source ?? (audible.find((m) => !m.hasVideo) ?? audible[0])?.id;
  const running = Object.entries(jobs).find(([k]) => k.startsWith("captions:"));
  const captionTracks = project.tracks.filter((t) => t.kind === "text" && t.name.startsWith("Captions"));
  return (
    <Section title="Auto captions">
      <p className="muted small">Speech to text with Whisper large-v3, on your own GPU. Nothing is uploaded.</p>
      <label className="field"><span className="field-label">Listen to</span>
        <select value={sourceId ?? ""} onChange={(e) => setSource(e.target.value)} disabled={!audible.length}>
          {audible.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <div className="row-2">
        <label className="field"><span className="field-label">Language</span>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>{LANGS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </label>
        <label className="field"><span className="field-label">Style</span>
          <select value={style} onChange={(e) => setStyle(e.target.value)}>{TEXT_STYLES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </label>
      </div>
      {running ? (
        <div className="job"><div className="bar"><div style={{ width: `${Math.round(running[1] * 100)}%` }} /></div><span>Transcribing… {Math.round(running[1] * 100)}%</span></div>
      ) : (
        <button className="primary wide" disabled={!sourceId} onClick={() => actions.autoCaptions({ mediaId: sourceId, language: lang, styleId: style })}>
          <Icon name="captions" /> Generate captions
        </button>
      )}
      {captionTracks.length > 0 && (
        <button className="small ghost wide" onClick={() => captionTracks.forEach((t) => apply((p) => ops.removeTrack(p, t.id)))}>Remove caption tracks</button>
      )}
    </Section>
  );
}
