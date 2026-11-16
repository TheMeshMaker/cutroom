//! Live preview. FFmpeg renders the same filter graph as the export (from the
//! preview proxies), one process for raw RGBA frames and one for the sound;
//! the sound plays through the default output device and its sample count is
//! the clock the picture follows. What you see is what you export.

use std::collections::VecDeque;
use std::io::Read;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::Value;

use crate::host::{self, Tools};

const AHEAD_FRAMES: usize = 12;

pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

struct Audio {
    _stream: cpal::Stream,
    played: Arc<AtomicU64>,
    rate: u32,
}

pub struct Playback {
    from: f64,
    fps: f64,
    size: (u32, u32),
    frames: Arc<Mutex<VecDeque<Vec<u8>>>>,
    shown: u64,
    audio: Option<Audio>,
    began: Instant,
    stop: Arc<AtomicBool>,
    pub ended: Arc<AtomicBool>,
    children: Vec<Arc<Mutex<Child>>>,
    dirs: Vec<String>,
}

/// The default output device's sample rate (FFmpeg resamples to it).
pub fn output_rate() -> Option<u32> {
    cpal::default_host().default_output_device()?.default_output_config().ok().map(|c| c.sample_rate())
}

fn spawn(tools: &Tools, spec: &Value) -> Result<Child, String> {
    let args: Vec<String> = serde_json::from_value(spec["args"].clone()).map_err(|e| e.to_string())?;
    host::command(&tools.ffmpeg).args(&args).stderr(std::process::Stdio::null()).spawn().map_err(|e| host::spawn_error(&tools.ffmpeg, e))
}

impl Playback {
    /// `video` / `audio` are engine previewStream() results (audio may be null).
    pub fn start(tools: &Tools, from: f64, video: &Value, audio: &Value) -> Result<Playback, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let ended = Arc::new(AtomicBool::new(false));
        let frames = Arc::new(Mutex::new(VecDeque::new()));
        let mut children = Vec::new();
        let mut dirs = Vec::new();
        let (w, h) = (video["width"].as_u64().unwrap_or(960) as u32, video["height"].as_u64().unwrap_or(540) as u32);
        if !video.is_null() {
            dirs.push(video["dir"].as_str().unwrap_or_default().to_string());
            let mut child = spawn(tools, video)?;
            let mut out = child.stdout.take().expect("piped stdout");
            let (frames, stop, ended) = (frames.clone(), stop.clone(), ended.clone());
            let size = (w * h * 4) as usize;
            std::thread::spawn(move || {
                loop {
                    let mut buf = vec![0u8; size];
                    if out.read_exact(&mut buf).is_err() {
                        break;
                    }
                    // Render just ahead of the clock, no further.
                    while frames.lock().unwrap().len() >= AHEAD_FRAMES && !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(4));
                    }
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    frames.lock().unwrap().push_back(buf);
                }
                ended.store(true, Ordering::Relaxed);
            });
            children.push(Arc::new(Mutex::new(child)));
        }
        let audio_out = if audio.is_null() {
            None
        } else {
            dirs.push(audio["dir"].as_str().unwrap_or_default().to_string());
            let mut child = spawn(tools, audio)?;
            let out = child.stdout.take().expect("piped stdout");
            children.push(Arc::new(Mutex::new(child)));
            start_audio(out, stop.clone())
        };
        Ok(Playback {
            from,
            fps: video["fps"].as_f64().filter(|f| *f > 0.0).unwrap_or(30.0),
            size: (w, h),
            frames,
            shown: 0,
            audio: audio_out,
            began: Instant::now(),
            stop,
            ended,
            children,
            dirs,
        })
    }

    /// Where playback is now: the sound's clock, or wall time without sound.
    pub fn time(&self) -> f64 {
        match &self.audio {
            Some(a) => self.from + a.played.load(Ordering::Relaxed) as f64 / a.rate as f64,
            None => self.from + self.began.elapsed().as_secs_f64(),
        }
    }

    /// The newest frame due by now, if a new one is.
    pub fn frame(&mut self) -> Option<Frame> {
        let due = ((self.time() - self.from) * self.fps).floor() as u64 + 1;
        let mut queue = self.frames.lock().unwrap();
        let mut latest = None;
        while self.shown < due {
            match queue.pop_front() {
                Some(f) => {
                    latest = Some(f);
                    self.shown += 1;
                }
                None => break,
            }
        }
        latest.map(|rgba| Frame { width: self.size.0, height: self.size.1, rgba })
    }

    pub fn finished(&self) -> bool {
        self.ended.load(Ordering::Relaxed) && self.frames.lock().unwrap().is_empty()
    }
}

impl Drop for Playback {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for c in &self.children {
            let _ = c.lock().unwrap().kill();
        }
        for d in &self.dirs {
            let _ = host::remove(d);
        }
    }
}

// shortcut: only f32 output devices (WASAPI shared mode always is); others play silent and fall back to the wall clock.
fn start_audio(mut out: std::process::ChildStdout, stop: Arc<AtomicBool>) -> Option<Audio> {
    let device = cpal::default_host().default_output_device()?;
    let supported = device.default_output_config().ok()?;
    if supported.sample_format() != cpal::SampleFormat::F32 {
        return None;
    }
    let config = supported.config();
    let (rate, channels) = (config.sample_rate, config.channels as usize);
    let ring: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
    let played = Arc::new(AtomicU64::new(0));
    {
        let ring = ring.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            let mut carry: Vec<u8> = Vec::new();
            while let Ok(n @ 1..) = out.read(&mut buf) {
                carry.extend_from_slice(&buf[..n]);
                let usable = carry.len() / 4 * 4;
                let samples: Vec<f32> = carry[..usable].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
                carry.drain(..usable);
                // Keep about a second queued so the clock stays honest.
                while ring.lock().unwrap().len() > rate as usize * 2 && !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                ring.lock().unwrap().extend(samples);
            }
        });
    }
    let (ring_cb, played_cb) = (ring.clone(), played.clone());
    // For unattended checks: the clock runs, the speakers stay quiet.
    let gain = if std::env::var_os("CUTROOM_SILENT").is_some() { 0.0 } else { 1.0 };
    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [f32], _| {
                let mut ring = ring_cb.lock().unwrap();
                let frames = data.len() / channels;
                // Underruns play silence and hold the clock, so the picture waits.
                let available = ring.len() / 2;
                let take = frames.min(available);
                for (i, frame) in data.chunks_mut(channels).enumerate() {
                    let (l, r) = if i < take { (ring.pop_front().unwrap_or(0.0), ring.pop_front().unwrap_or(0.0)) } else { (0.0, 0.0) };
                    for (ch, s) in frame.iter_mut().enumerate() {
                        *s = match ch {
                            0 => l * gain,
                            1 => r * gain,
                            _ => 0.0,
                        };
                    }
                }
                played_cb.fetch_add(take as u64, Ordering::Relaxed);
            },
            |e| eprintln!("audio output: {e}"),
            None,
        )
        .ok()?;
    stream.play().ok()?;
    Some(Audio { _stream: stream, played, rate })
}
