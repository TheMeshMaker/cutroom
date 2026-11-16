//! The open project: its JSON (the source of truth, edited only through the
//! engine), a typed view for drawing, undo history, autosave, media previews
//! (proxies, filmstrips, waveforms) and the view state of the editor.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use iced::widget::image;
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::i18n::Lang;
use crate::model::Project;
use crate::playback::Playback;
use crate::store;

/// Filmstrip thumbnails of one media item, cut out of its sprite sheet.
pub struct Strip {
    pub tiles: Vec<image::Handle>,
    pub tile_w: u32,
    pub tile_h: u32,
    pub interval: f64,
}

/// Tabs of the details panel on the right; which ones show depends on the clip.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Panel {
    Video,
    Text,
    Audio,
    Speed,
    Animation,
    Color,
    Project,
}

/// Tabs of the asset panel on the left.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Asset {
    Media,
    Audio,
    Text,
    Effects,
    Transitions,
    Captions,
    Filters,
    Adjustment,
    Stickers,
}

pub struct Menu {
    pub x: f32,
    pub y: f32,
    pub clip: Option<String>,
    pub t: f64,
}

#[derive(Clone)]
pub struct ExportForm {
    pub resolution: u32, // 0 = the project's size
    pub fps: u32,        // 0 = the project's
    pub quality: &'static str,
    pub codec: &'static str,
    pub running: Option<String>, // job id
    pub done: Option<Result<String, String>>,
}

pub struct Editor {
    pub path: String,
    pub json: Value,
    pub p: Project,
    pub lang: Lang,
    past: Vec<Value>,
    future: Vec<Value>,
    coalesce: Option<(String, Instant)>,
    pub dirty: bool,
    pub last_edit: Instant,
    pub saved_text: String,
    pub file_mtime: f64,
    pub selection: Vec<String>,
    pub playhead: f64,
    pub pps: f32,
    pub scroll: f32,
    pub fitted: bool,
    pub proxies: HashMap<String, String>,
    pub waves: HashMap<String, Arc<Vec<u8>>>,
    pub strips: HashMap<String, Arc<Strip>>,
    pub prep: VecDeque<String>,
    pub prep_busy: bool,
    pub still: Option<image::Handle>,
    pub still_wanted: u64,
    pub still_seen: u64,
    pub still_busy: bool,
    pub playback: Option<Playback>,
    pub frame: Option<image::Handle>,
    pub drag_media: Option<String>,
    pub menu: Option<Menu>,
    pub export: Option<ExportForm>,
    pub clipboard: Vec<String>,
    pub panel: Panel,
    pub asset: Asset,
    /// The background edit in progress (job id, what it does); one at a time.
    pub busy: Option<(String, String)>,
    /// The text box of the selected text clip (clip id, contents).
    pub text_box: Option<(String, iced::widget::text_editor::Content)>,
    pub anim_out: bool,
    pub caption_lang: &'static str,
    /// Filter and effect thumbnails of one clip ("filter:warm" -> picture), keyed by clip id.
    pub looks: Option<(String, HashMap<String, image::Handle>)>,
    pub looks_busy: bool,
    /// Playback stopped by an edit restarts here (so you see the change).
    pub resume: Option<f64>,
    /// A clip's look (filter, adjust, effects, color, LUT, mask, green screen) for Paste attributes.
    pub look_clipboard: Option<Value>,
}

/// Ops return either a project or `{ project, … }`.
pub fn project_of(result: &Value) -> Value {
    if result.get("clips").is_some() { result.clone() } else { result["project"].clone() }
}

impl Editor {
    pub fn open(path: &str, json: Value, text: String, lang: Lang) -> Editor {
        let p: Project = serde_json::from_value(json.clone()).unwrap_or_default();
        let prep = p.media.iter().map(|m| m.id.clone()).collect();
        Editor {
            path: path.to_string(),
            json,
            p,
            lang,
            past: Vec::new(),
            future: Vec::new(),
            coalesce: None,
            dirty: false,
            last_edit: Instant::now(),
            saved_text: text,
            file_mtime: crate::host::stat(path).map(|s| s.mtime_ms).unwrap_or(0.0),
            selection: Vec::new(),
            playhead: 0.0,
            pps: 40.0,
            scroll: 0.0,
            fitted: false,
            proxies: HashMap::new(),
            waves: HashMap::new(),
            strips: HashMap::new(),
            prep,
            prep_busy: false,
            still: None,
            still_wanted: 1,
            still_seen: 0,
            still_busy: false,
            playback: None,
            frame: None,
            drag_media: None,
            menu: None,
            export: None,
            clipboard: Vec::new(),
            panel: Panel::Video,
            asset: Asset::Media,
            busy: None,
            text_box: None,
            anim_out: false,
            caption_lang: "auto",
            looks: None,
            looks_busy: false,
            resume: None,
            look_clipboard: None,
        }
    }

    /// Replace the project (an edit). `coalesce` merges quick repeats of the
    /// same control into one undo step.
    pub fn commit(&mut self, next: Value, coalesce: Option<&str>) {
        if next == self.json {
            return;
        }
        let merge = matches!((&self.coalesce, coalesce), (Some((k, at)), Some(c)) if k == c && at.elapsed().as_millis() < 1500);
        if !merge {
            self.past.push(std::mem::replace(&mut self.json, Value::Null));
            if self.past.len() > 200 {
                self.past.remove(0);
            }
        }
        self.coalesce = coalesce.map(|c| (c.to_string(), Instant::now()));
        self.future.clear();
        self.set(next);
    }

    fn set(&mut self, next: Value) {
        // Playback renders the old version; restart it from the same spot.
        if let Some(pb) = self.playback.take() {
            self.resume = Some(pb.time());
            self.frame = None;
        }
        self.json = next;
        self.p = serde_json::from_value(self.json.clone()).unwrap_or_default();
        self.selection.retain(|id| self.p.clips.iter().any(|c| &c.id == id));
        // Keep the playhead on the timeline, and drop the old picture when nothing is left.
        self.playhead = self.playhead.min(self.p.duration());
        if self.p.clips.is_empty() {
            self.still = None;
            self.frame = None;
        }
        for m in &self.p.media {
            if !self.prep.contains(&m.id) && !self.proxies.contains_key(&m.id) && !self.waves.contains_key(&m.id) {
                self.prep.push_back(m.id.clone());
            }
        }
        self.dirty = true;
        self.last_edit = Instant::now();
        self.still_wanted += 1;
    }

    /// Run `ops.<name>(project, ...rest)` and keep the result (settled for the
    /// main-track magnet). Returns the raw result for ops that report ids.
    pub fn op(&mut self, engine: &Engine, name: &str, rest: Vec<Value>, coalesce: Option<&str>) -> Result<Value, String> {
        let mut args = vec![self.json.clone()];
        args.extend(rest);
        let result = engine.call(&format!("ops.{name}"), &Value::Array(args), false)?;
        let settled = engine.call("ops.settle", &json!([project_of(&result)]), false)?;
        self.commit(settled, coalesce);
        Ok(result)
    }

    pub fn undo(&mut self) {
        if let Some(prev) = self.past.pop() {
            let now = std::mem::replace(&mut self.json, Value::Null);
            self.future.push(now);
            self.coalesce = None;
            self.set(prev);
        }
    }

    pub fn redo(&mut self) {
        if let Some(next) = self.future.pop() {
            let now = std::mem::replace(&mut self.json, Value::Null);
            self.past.push(now);
            self.coalesce = None;
            self.set(next);
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.past.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.future.is_empty()
    }

    /// Save if edits have settled for a moment.
    pub fn autosave(&mut self) -> Result<(), String> {
        if !self.dirty || self.last_edit.elapsed().as_millis() < 450 {
            return Ok(());
        }
        self.dirty = false;
        self.saved_text = store::save(&self.path, &self.json)?;
        self.file_mtime = crate::host::stat(&self.path).map(|s| s.mtime_ms).unwrap_or(0.0);
        Ok(())
    }

    /// Agents (the MCP server) edit the file directly: take their version
    /// when the file changed and isn't what we wrote. Undo still works.
    pub fn check_external(&mut self, engine: &Engine) -> bool {
        let Some(st) = crate::host::stat(&self.path) else { return false };
        if st.mtime_ms == self.file_mtime {
            return false;
        }
        self.file_mtime = st.mtime_ms;
        let Ok(text) = std::fs::read_to_string(&self.path) else { return false };
        if text == self.saved_text || self.dirty {
            return false;
        }
        let Ok(raw) = serde_json::from_str::<Value>(&text) else { return false };
        let Ok(next) = engine.call("model.normalizeProject", &json!([raw]), false) else { return false };
        self.saved_text = text;
        self.past.push(std::mem::replace(&mut self.json, Value::Null));
        self.future.clear();
        self.set(next);
        self.dirty = false;
        true
    }

    /// The project with each media item pointing at its preview proxy, for
    /// fast preview renders.
    pub fn with_proxies(&self) -> Value {
        let mut p = self.json.clone();
        if let Some(media) = p["media"].as_array_mut() {
            for m in media {
                if let Some(proxy) = m["id"].as_str().and_then(|id| self.proxies.get(id)) {
                    m["path"] = json!(proxy);
                }
            }
        }
        p
    }

    /// What "current" actions use: the selection, else the clip under the
    /// playhead on the main track.
    pub fn targets(&self) -> Vec<String> {
        if !self.selection.is_empty() {
            return self.selection.clone();
        }
        let main = self.p.main_track().map(|t| t.id.clone());
        self.p.clips.iter().filter(|c| Some(&c.track_id) == main.as_ref() && c.start <= self.playhead && c.end() > self.playhead).map(|c| c.id.clone()).take(1).collect()
    }

    /// The clip the details panel edits: the first selected one.
    pub fn current(&self) -> Option<&crate::model::Clip> {
        self.selection.first().and_then(|id| self.p.clip(id))
    }

    /// Which clip and canvas the filter/effect thumbnails were made for.
    pub fn looks_key(&self) -> Option<String> {
        let id = self.targets().first()?.clone();
        Some(format!("{id}|{}x{}|{:?}", self.p.canvas.width, self.p.canvas.height, self.p.settings.background))
    }

    /// The details tabs this clip has, in order.
    pub fn panels(&self) -> Vec<Panel> {
        let Some(c) = self.current() else { return vec![Panel::Project] };
        let media = c.media_id.as_deref().and_then(|id| self.p.media(id));
        if c.text.is_some() {
            vec![Panel::Text, Panel::Animation]
        } else if c.adjustment {
            vec![Panel::Color]
        } else if media.is_some_and(|m| !m.has_video) {
            vec![Panel::Audio, Panel::Speed]
        } else if media.is_some_and(|m| m.kind == "image") {
            vec![Panel::Video, Panel::Animation, Panel::Color]
        } else {
            vec![Panel::Video, Panel::Audio, Panel::Speed, Panel::Animation, Panel::Color]
        }
    }

    /// The clip's raw JSON (every property, for the details panel).
    pub fn clip_json(&self, id: &str) -> &Value {
        self.json["clips"].as_array().and_then(|c| c.iter().find(|c| c["id"] == id)).unwrap_or(&Value::Null)
    }

    /// Keep the text box in step with the selected text clip.
    pub fn sync_text_box(&mut self) {
        let text = self.current().and_then(|c| Some((c.id.clone(), c.text.clone()?)));
        match (&self.text_box, text) {
            (Some((id, content)), Some((cid, t))) if *id == cid && content.text().trim_end_matches('\n') == t.trim_end_matches('\n') => {}
            (_, Some((cid, t))) => self.text_box = Some((cid, iced::widget::text_editor::Content::with_text(&t))),
            (_, None) => self.text_box = None,
        }
    }

    pub fn fit(&mut self, width: f32) {
        let d = self.p.duration().max(5.0) as f32;
        self.pps = ((width - crate::timeline::HEADER - 40.0) / d).clamp(0.5, 400.0);
        self.scroll = 0.0;
    }
}
