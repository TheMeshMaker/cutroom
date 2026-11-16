//! A typed, read-only view of a normalized project (core/model.js) for
//! drawing. Edits never touch it: they go through the engine on the JSON.

use serde::Deserialize;

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub canvas: Canvas,
    pub settings: Settings,
    pub media: Vec<Media>,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
    pub markers: Vec<Marker>,
    pub bleeps: Vec<Bleep>,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub magnet: bool,
    pub loudness: Option<f64>,
    pub background: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub path: String,
    pub name: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub kind: String,
    pub audio_tracks: Option<Vec<String>>,
    pub derived_from: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Track {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub muted: bool,
    pub hidden: bool,
    pub locked: bool,
    pub volume: f64,
    pub role: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Transform {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub track_id: String,
    pub media_id: Option<String>,
    pub text: Option<String>,
    pub adjustment: bool,
    pub start: f64,
    #[serde(rename = "in")]
    pub in_: f64,
    pub out: f64,
    pub speed: f64,
    pub volume: f64,
    pub muted: bool,
    pub fade_in: f64,
    pub fade_out: f64,
    pub opacity: f64,
    pub label: Option<String>,
    pub transform: Transform,
    pub keyframes: Vec<Keyframe>,
    pub transition: Option<Transition>,
}

/// `t` is seconds from the clip's start on the timeline.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Keyframe {
    pub t: f64,
}

/// The transition from the previous clip into this one.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Transition {
    #[serde(rename = "type")]
    pub kind: String,
    pub duration: f64,
}

impl Clip {
    pub fn len(&self) -> f64 {
        if self.media_id.is_some() {
            (self.out - self.in_) / if self.speed > 0.0 { self.speed } else { 1.0 }
        } else {
            self.out - self.in_
        }
    }
    pub fn end(&self) -> f64 {
        self.start + self.len()
    }
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Marker {
    pub id: String,
    pub time: f64,
    pub end: Option<f64>,
    pub label: String,
    pub color: String,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Bleep {
    pub id: String,
    pub start: f64,
    pub end: f64,
}

impl Project {
    pub fn duration(&self) -> f64 {
        self.clips.iter().map(Clip::end).fold(0.0, f64::max)
    }
    pub fn media(&self, id: &str) -> Option<&Media> {
        self.media.iter().find(|m| m.id == id)
    }
    pub fn clip(&self, id: &str) -> Option<&Clip> {
        self.clips.iter().find(|c| c.id == id)
    }
    pub fn track(&self, id: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }
    /// The main track: the last video track in display order.
    pub fn main_track(&self) -> Option<&Track> {
        self.tracks.iter().rev().find(|t| t.kind == "video")
    }
}

/// "01:23:45" / "12:05.3" style timecode (hh:mm:ss:ff like the web app).
pub fn timecode(t: f64, fps: f64) -> String {
    let fps = if fps > 0.0 { fps } else { 30.0 };
    let total = (t.max(0.0) * fps).round() as i64;
    let f = total % fps.round() as i64;
    let s = total / fps.round() as i64;
    format!("{:02}:{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60, f)
}
