// No console window next to the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod color;
mod editor;
mod engine;
mod host;
mod i18n;
mod model;
mod playback;
mod store;
mod theme;
mod timeline;
mod ui;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use iced::keyboard::{self, key::Named, Key, Modifiers};
use iced::widget::image;
use iced::{Size, Subscription, Task};
use serde_json::{json, Value};

use editor::{Editor, ExportForm, Menu, Panel, Strip};
use engine::{Engine, Hooks};
use host::Tools;
use i18n::{t, Lang};
use timeline::TlMsg;

fn main() -> iced::Result {
    if let Some(file) = std::env::args().find_map(|a| a.strip_prefix("--selftest=").map(String::from)) {
        selftest(&file);
        return Ok(());
    }
    iced::application(App::boot, App::update, App::view)
        .title(App::title)
        .subscription(App::subscription)
        .theme(|_: &App| theme::theme())
        .default_font(iced::Font::with_name("Segoe UI"))
        // The interface follows the screen: smaller on small or highly scaled screens (FHD at 150 %).
        .scale_factor(App::ui_scale)
        .window(iced::window::Settings {
            // `--shot-size=1600x2400` takes tall screenshots for checks (whole panels at once).
            size: arg("--shot-size=").and_then(|s| s.split_once('x').and_then(|(w, h)| Some(Size::new(w.parse().ok()?, h.parse().ok()?)))).unwrap_or(Size::new(1280.0, 800.0)),
            // Opens filling the screen, whatever its resolution; small enough to restore on an HD laptop.
            maximized: arg("--shot=").is_none(),
            min_size: Some(Size::new(900.0, 560.0)),
            // Screenshot checks run off-screen so they don't pop up over whatever you're doing.
            position: if arg("--shot=").is_some() { iced::window::Position::Specific(iced::Point::new(-4200.0, 40.0)) } else { iced::window::Position::Centered },
            ..Default::default()
        })
        .run()
}

pub enum Screen {
    Home,
    Editor(Box<Editor>),
}

pub struct Card {
    pub path: String,
    pub name: String,
    pub modified: f64,
    pub duration: f64,
    pub size: (u32, u32),
    pub missing: bool,
}

pub struct Toast {
    pub text: String,
    pub undo: bool,
    pub error: bool,
    pub until: Instant,
}

pub struct App {
    pub tools: Tools,
    pub engine: Rc<Engine>,
    pub jobs: Jobs,
    pub lang: Lang,
    pub screen: Screen,
    pub cards: Vec<Card>,
    pub thumbs: HashMap<String, image::Handle>,
    pub toast: Option<Toast>,
    pub window: Size,
    pub catalog: Catalog,
    /// Windows text-to-speech voices ("Name|culture" names), loaded at start.
    pub voices: Vec<String>,
    pub voice: Option<String>,
    /// Interface size: the user's choice, else fitted to the monitor (1.0 on a big screen).
    pub ui_manual: Option<f32>,
    pub ui_auto: f32,
    monitor_known: bool,
    /// `--shot=<png>`: save a screenshot of the window after a few seconds and quit (for checks).
    shot: Option<Instant>,
    /// `--do=play,audio,…`: messages sent once the editor has loaded (for checks).
    script: Option<(Instant, Vec<Vec<Message>>)>,
}

/// Background work: each job runs on a worker thread with its own engine.
/// Progress lands in `progress[id]`; `cancel(id)` stops it at its next output.
#[derive(Clone)]
pub struct Jobs {
    tools: Tools,
    progress: Arc<Mutex<HashMap<String, f64>>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Jobs {
    fn spawn<T: Send + 'static>(&self, id: &str, work: impl FnOnce(&Engine) -> Result<T, String> + Send + 'static, done: impl FnOnce(Result<T, String>) -> Message + Send + 'static) -> Task<Message> {
        let tools = self.tools.clone();
        let (progress, key) = (self.progress.clone(), id.to_string());
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(id.to_string(), cancel.clone());
        progress.lock().unwrap().insert(key.clone(), 0.0);
        let hooks = Hooks { progress: Arc::new(move |p| { progress.lock().unwrap().insert(key.clone(), p); }), cancel };
        Task::perform(async move { tokio::task::spawn_blocking(move || Engine::new(&tools, hooks).and_then(|e| work(&e))).await.unwrap_or_else(|e| Err(e.to_string())) }, done)
    }
    fn end(&self, id: &str) {
        self.progress.lock().unwrap().remove(id);
        self.cancels.lock().unwrap().remove(id);
    }
    fn cancel(&self, id: &str) {
        if let Some(c) = self.cancels.lock().unwrap().get(id) {
            c.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    pub fn progress(&self, id: &str) -> Option<f64> {
        self.progress.lock().unwrap().get(id).copied()
    }
}

/// Results of background work that the UI keeps.
#[derive(Debug, Clone)]
pub struct Prep {
    proxy: Option<String>,
    peaks: Option<Arc<Vec<u8>>>,
    strip: Option<(Vec<image::Handle>, u32, u32, f64)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AudioTool {
    Stems,
    NoMusic,
    Tracks,
}

#[derive(Debug, Clone)]
pub enum ExportMsg {
    Open,
    Close,
    Resolution(u32),
    Fps(u32),
    Quality(&'static str),
    Codec(&'static str),
    Start,
    Picked(Option<String>),
    Done(Result<String, String>),
    Cancel,
    Reveal(String),
}

#[derive(Debug, Clone)]
pub enum Message {
    Shot(iced::window::Screenshot),
    Tick,
    Event(iced::Event),
    Key(Key, Modifiers),
    SetLang(Lang),
    // projects home
    Thumb(String, Option<Vec<u8>>),
    NewProject,
    NewAt(Option<String>),
    OpenDialog,
    Open(String),
    ImportCapcut,
    CapcutPicked(Option<String>, Option<String>),
    Forget(String),
    Home,
    // editor
    Timeline(TlMsg),
    Undo,
    Redo,
    Play,
    Step(f64),
    Split,
    Delete(bool),
    DeleteSide(bool),
    Duplicate,
    Copy,
    Paste(Option<f64>),
    SelectAll,
    Marker(f64),
    Import,
    ImportPicked(Vec<String>),
    Imported(Result<Vec<Value>, String>),
    AddMedia(String),
    DragMedia(Option<String>),
    Prepared(String, Result<Prep, String>),
    Still(u64, Result<Vec<u8>, String>),
    SetClip(String, Value, &'static str),
    Audio(AudioTool),
    AudioDone(String, AudioTool, Result<Vec<Value>, String>),
    Panel(Panel),
    /// Select a clip and open one of its detail tabs.
    Reveal(String, Panel),
    Asset(editor::Asset),
    /// Run `ops.<name>(project, ...args)` as one undoable edit.
    Op(&'static str, Vec<Value>, Option<&'static str>),
    /// Run `flows.<name>(project, ...args)` in the background (args end with an options object).
    Flow(&'static str, Vec<Value>, &'static str),
    FlowDone(Result<Value, String>),
    Looks(String, Result<Value, String>),
    CancelFlow,
    Monitor(Option<Size>),
    UiScale(Option<f32>),
    CopyLook,
    PasteLook,
    RatioPick(f64, f64),
    Voices(Result<Value, String>),
    Voice(String),
    TextEdit(iced::widget::text_editor::Action),
    AnimSide(bool),
    CaptionLang(&'static str),
    Pick(&'static str),
    Picked(&'static str, Option<String>),
    CloseMenu,
    Export(ExportMsg),
    ToastClose,
    ToastUndo,
    Rename(String),
    Zoom(f32),
    Fit,
    Magnet(bool),
}

/// The interface scale that fits a screen of `w` x `h` (in Windows' scaled pixels):
/// the layout is designed for about 1600 x 900, so anything smaller shrinks to fit.
fn fit_scale(w: f32, h: f32) -> f32 {
    (w / 1600.0).min(h / 900.0).clamp(0.6, 1.0)
}

#[cfg(test)]
mod scale_tests {
    use super::fit_scale;

    #[test]
    fn fits_common_screens() {
        // Screen size as Windows reports it (resolution / display scaling).
        assert_eq!(fit_scale(1920.0, 1080.0), 1.0); // FHD at 100 %
        assert!((fit_scale(1536.0, 864.0) - 0.96).abs() < 0.01); // FHD at 125 %
        assert!((fit_scale(1280.0, 720.0) - 0.8).abs() < 0.01); // FHD at 150 %
        assert!((fit_scale(1366.0, 768.0) - 0.8533).abs() < 0.01); // HD laptop
        assert_eq!(fit_scale(2560.0, 1440.0), 1.0); // QHD, or 4K at 150 %
        assert_eq!(fit_scale(3840.0, 2160.0), 1.0); // 4K at 100 %
        assert_eq!(fit_scale(800.0, 450.0), 0.6); // never unreadably small
    }
}

/// What the asset and details panels offer, read once from the engine's catalog.
#[derive(Default)]
pub struct Catalog {
    pub filters: Vec<Value>,
    pub effects: Vec<Value>,
    pub transitions: Vec<Value>,
    pub animations: Vec<Value>,
    pub voices: Vec<Value>,
    pub styles: Vec<Value>,
    pub titles: Vec<Value>,
    pub font_names: Vec<String>,
    fonts: Vec<&'static str>,
    pub ramps: Vec<(String, String)>,
    pub adjust: Vec<(String, f64, f64)>,
}

impl Catalog {
    fn load(engine: &Engine) -> Catalog {
        let list = |name: &str| engine.value(name).as_array().cloned().unwrap_or_default();
        let font_names: Vec<String> = list("catalog.FONTS").iter().filter_map(|f| f["family"].as_str().map(String::from)).collect();
        Catalog {
            filters: list("catalog.FILTERS"),
            effects: list("catalog.EFFECTS"),
            transitions: list("catalog.TRANSITIONS"),
            animations: list("catalog.ANIMATIONS"),
            voices: list("catalog.VOICE_EFFECTS"),
            styles: list("catalog.TEXT_STYLES"),
            titles: list("catalog.TITLE_TEMPLATES"),
            // Fonts are named once at start-up and live for the whole run.
            fonts: font_names.iter().map(|f| &*Box::leak(f.clone().into_boxed_str())).collect(),
            font_names,
            ramps: engine.value("ops.SPEED_RAMPS").as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v["label"].as_str().unwrap_or(k).to_string())).collect()).unwrap_or_default(),
            adjust: engine.value("catalog.ADJUST_KEYS").as_object().map(|o| o.iter().map(|(k, r)| (k.clone(), r[0].as_f64().unwrap_or(-100.0), r[1].as_f64().unwrap_or(100.0))).collect()).unwrap_or_default(),
        }
    }

    pub fn font(&self, family: &str) -> iced::Font {
        iced::Font::with_name(self.fonts.iter().find(|f| **f == family).copied().unwrap_or("Segoe UI"))
    }

    /// The label of a color adjustment key (core/catalog.js ADJUST_KEYS).
    pub fn adjust_label(key: &str) -> &'static str {
        match key {
            "brightness" => "Brightness",
            "contrast" => "Contrast",
            "saturation" => "Saturation",
            "exposure" => "Exposure",
            "temperature" => "Temperature",
            "tint" => "Tint",
            "highlights" => "Highlights",
            "shadows" => "Shadows",
            "fade" => "Fade",
            "sharpen" => "Sharpen",
            "vignette" => "Vignette",
            "grain" => "Grain",
            _ => "Adjust",
        }
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

impl App {
    fn boot() -> (App, Task<Message>) {
        let tools = Tools::locate();
        let engine = Engine::new(&tools, Hooks::default()).unwrap_or_else(|e| panic!("engine failed to start: {e}"));
        // The saved choice, else the Windows display language on the first start.
        let lang = store::read_state()["language"].as_str().map(Lang::from_code).unwrap_or_else(Lang::system);
        let jobs = Jobs { tools: tools.clone(), progress: Arc::default(), cancels: Arc::default() };
        let catalog = Catalog::load(&engine);
        let voices_job = jobs.spawn("voices", |e| e.call("flows.voices", &json!([]), false), Message::Voices);
        let mut app = App { tools, engine: Rc::new(engine), jobs, lang, catalog, voices: Vec::new(), voice: None, ui_manual: store::read_state()["uiScale"].as_f64().map(|v| (v as f32).clamp(0.5, 2.0)), ui_auto: 1.0, monitor_known: false, screen: Screen::Home, cards: Vec::new(), thumbs: HashMap::new(), toast: None, window: Size::new(1600.0, 960.0), shot: arg("--shot=").map(|_| Instant::now()), script: arg("--do=").map(|s| (Instant::now(), s.split('|').map(|batch| batch.split(',').filter_map(scripted).collect()).collect())) };
        if let Some(code) = arg("--lang=") {
            app.lang = Lang::from_code(&code);
        }
        // Always start on the projects home; `--project=` opens one directly.
        let task = match arg("--project=") {
            Some(path) => Task::done(Message::Open(store::absolute(&path))),
            None => app.load_cards(),
        };
        (app, Task::batch([task, voices_job]))
    }

    fn title(&self) -> String {
        match &self.screen {
            Screen::Editor(ed) => format!("{} - Cutroom", ed.p.name),
            Screen::Home => "Cutroom".into(),
        }
    }

    pub fn ui_scale(&self) -> f32 {
        self.ui_manual.unwrap_or(self.ui_auto)
    }

    fn notify(&mut self, text: impl Into<String>, undo: bool) {
        self.toast = Some(Toast { text: text.into(), undo, error: false, until: Instant::now() + Duration::from_secs(if undo { 6 } else { 4 }) });
    }

    fn fail(&mut self, text: impl Into<String>) {
        let text = text.into();
        eprintln!("error: {text}");
        // Errors from the engine are English; show them in the chosen language.
        let text = i18n::message(self.lang, &text);
        self.toast = Some(Toast { text, undo: false, error: true, until: Instant::now() + Duration::from_secs(7) });
    }

    fn load_cards(&mut self) -> Task<Message> {
        self.cards = store::recent()
            .into_iter()
            .map(|path| {
                let st = host::stat(&path);
                let p = st.as_ref().and_then(|_| std::fs::read_to_string(&path).ok()).and_then(|t| serde_json::from_str::<model::Project>(&t).ok());
                Card {
                    name: p.as_ref().map(|p| p.name.clone()).unwrap_or_else(|| path.rsplit(['\\', '/']).next().unwrap_or(&path).replace(store::PROJECT_EXT, "")),
                    duration: p.as_ref().map(model::Project::duration).unwrap_or(0.0),
                    size: p.as_ref().map(|p| (p.canvas.width, p.canvas.height)).unwrap_or_default(),
                    modified: st.as_ref().map(|s| s.mtime_ms).unwrap_or(0.0),
                    missing: p.is_none(),
                    path,
                }
            })
            .collect();
        let tasks: Vec<Task<Message>> = self
            .cards
            .iter()
            .filter(|c| !c.missing && c.duration > 0.0 && !self.thumbs.contains_key(&c.path))
            .map(|c| (c.path.clone(), c.modified))
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(path, modified)| {
                let p2 = path.clone();
                self.jobs.spawn(&format!("thumb:{path}"), move |e| thumb(e, &p2, modified), move |r| Message::Thumb(path, r.ok()))
            })
            .collect();
        Task::batch(tasks)
    }

    fn open(&mut self, path: &str) -> Task<Message> {
        let loaded = std::fs::read_to_string(path).map_err(|e| e.to_string()).and_then(|text| {
            let raw: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            Ok((self.engine.call("model.normalizeProject", &json!([raw]), false)?, text))
        });
        match loaded {
            Ok((json, text)) => {
                // Screenshot checks leave your recent projects alone.
                if arg("--shot=").is_none() {
                    store::remember(path);
                }
                let mut ed = Box::new(Editor::open(path, json, text, self.lang));
                let task = prep_next(&mut ed, &self.jobs);
                self.screen = Screen::Editor(ed);
                task
            }
            Err(e) => {
                self.fail(format!("{path}: {e}"));
                Task::none()
            }
        }
    }

    fn ed(&mut self) -> Option<&mut Editor> {
        match &mut self.screen {
            Screen::Editor(ed) => Some(ed),
            Screen::Home => None,
        }
    }

    fn stop_playback(&mut self) {
        if let Some(ed) = self.ed() {
            if ed.playback.take().is_some() {
                ed.frame = None;
                ed.still_wanted += 1;
            }
        }
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match self.update_inner(message) {
            Ok(task) => task,
            Err(e) => {
                self.fail(e);
                Task::none()
            }
        }
    }

    fn update_inner(&mut self, message: Message) -> Result<Task<Message>, String> {
        let lang = self.lang;
        match message {
            Message::Tick => {
                let delay = arg("--shot-after=").and_then(|s| s.parse().ok()).unwrap_or(5000);
                // `--do=a,b|c,d`: one batch of steps every 1.5 s once the editor has loaded.
                if let Some((at, batches)) = self.script.as_mut().filter(|(at, b)| at.elapsed().as_millis() >= 2500 && !b.is_empty()) {
                    *at = Instant::now() - Duration::from_millis(1000);
                    return Ok(Task::batch(batches.remove(0).into_iter().map(Task::done)));
                }
                if self.shot.is_some_and(|at| at.elapsed().as_millis() >= delay) && self.window.width >= 1.0 {
                    self.shot = None;
                    return Ok(iced::window::latest().and_then(iced::window::screenshot).map(Message::Shot));
                }
                return Ok(self.tick());
            }
            Message::Shot(s) => {
                let path = arg("--shot=").unwrap_or_default();
                let img = ::image::RgbaImage::from_raw(s.size.width, s.size.height, s.rgba.to_vec()).ok_or("bad screenshot")?;
                img.save(&path).map_err(|e| e.to_string())?;
                return Ok(iced::exit());
            }
            Message::Event(iced::Event::Window(iced::window::Event::Resized(size))) => {
                self.window = size;
                // Measure the screen once the window exists.
                if !self.monitor_known {
                    self.monitor_known = true;
                    return Ok(iced::window::latest().and_then(iced::window::monitor_size).map(Message::Monitor));
                }
            }
            // Moved (maybe to another screen, same scaling or not): fit again.
            Message::Event(iced::Event::Window(iced::window::Event::Rescaled(_) | iced::window::Event::Moved(_))) => {
                return Ok(iced::window::latest().and_then(iced::window::monitor_size).map(Message::Monitor));
            }
            Message::Monitor(Some(size)) => {
                // iced reports the screen divided by our own scale; undo that to get it as Windows sees it.
                let (w, h) = (size.width * self.ui_scale(), size.height * self.ui_scale());
                // `--screen=1280x720` pretends to be another screen (for checks).
                let (w, h) = arg("--screen=").and_then(|s| s.split_once('x').and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)))).unwrap_or((w, h));
                self.ui_auto = fit_scale(w, h);
            }
            Message::Monitor(None) => {}
            Message::UiScale(choice) => {
                self.ui_manual = choice;
                if arg("--shot=").is_none() {
                    store::write_state(json!({ "uiScale": choice }));
                }
            }
            Message::Event(iced::Event::Mouse(iced::mouse::Event::ButtonReleased(_))) => {
                if let Some(ed) = self.ed() {
                    ed.drag_media = None;
                }
            }
            Message::Event(_) => {}
            Message::Key(key, mods) => return Ok(self.key(key, mods)),
            Message::Voices(result) => {
                self.jobs.end("voices");
                self.voices = result.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter_map(|v| v["name"].as_str().map(String::from)).collect();
            }
            Message::Voice(name) => self.voice = Some(name),
            Message::SetLang(lang) => {
                self.lang = lang;
                if arg("--shot=").is_none() {
                    store::write_state(json!({ "language": self.lang.code() }));
                }
                let l = self.lang;
                if let Some(ed) = self.ed() {
                    ed.lang = l;
                }
            }
            Message::Thumb(path, Some(bytes)) => {
                self.jobs.end(&format!("thumb:{path}"));
                self.thumbs.insert(path, image::Handle::from_bytes(bytes));
            }
            Message::Thumb(path, None) => self.jobs.end(&format!("thumb:{path}")),
            Message::NewProject => {
                let dir = host::home().join("Videos");
                return Ok(Task::perform(
                    async move { rfd::AsyncFileDialog::new().set_title(t(lang, "New project")).set_directory(dir).set_file_name(format!("Untitled{}", store::PROJECT_EXT)).add_filter("Cutroom project", &["json"]).save_file().await.map(|f| f.path().to_string_lossy().into_owned()) },
                    Message::NewAt,
                ));
            }
            Message::NewAt(Some(path)) => {
                let path = if path.ends_with(store::PROJECT_EXT) { path } else { format!("{}{}", path.trim_end_matches(".json"), store::PROJECT_EXT) };
                let name = path.rsplit(['\\', '/']).next().unwrap_or("Untitled").replace(store::PROJECT_EXT, "");
                let p = self.engine.call("model.createProject", &json!([{ "name": name, "canvas": "1080p" }]), false)?;
                store::save(&path, &p)?;
                return Ok(self.open(&path));
            }
            Message::NewAt(None) | Message::CapcutPicked(None, _) | Message::CapcutPicked(_, None) => {}
            Message::OpenDialog => {
                return Ok(Task::perform(
                    async move { rfd::AsyncFileDialog::new().set_title(t(lang, "Open project")).add_filter("Cutroom project", &["json"]).pick_file().await.map(|f| f.path().to_string_lossy().into_owned()) },
                    |p| p.map(Message::Open).unwrap_or(Message::CloseMenu),
                ));
            }
            Message::Open(path) => return Ok(self.open(&path)),
            Message::ImportCapcut => {
                let drafts = std::env::var("LOCALAPPDATA").map(|d| std::path::Path::new(&d).join("CapCut").join("User Data").join("Projects").join("com.lveditor.draft")).unwrap_or_default();
                return Ok(Task::perform(
                    async move {
                        let draft = rfd::AsyncFileDialog::new().set_title(t(lang, "Choose a CapCut draft_content.json")).set_directory(drafts).add_filter("CapCut draft", &["json"]).pick_file().await?;
                        let save = rfd::AsyncFileDialog::new().set_title(t(lang, "Save the imported project")).set_directory(host::home().join("Videos")).set_file_name(format!("CapCut import{}", store::PROJECT_EXT)).save_file().await?;
                        Some((draft.path().to_string_lossy().into_owned(), save.path().to_string_lossy().into_owned()))
                    },
                    |r| match r {
                        Some((a, b)) => Message::CapcutPicked(Some(a), Some(b)),
                        None => Message::CapcutPicked(None, None),
                    },
                ));
            }
            Message::CapcutPicked(Some(draft), Some(path)) => {
                let raw: Value = serde_json::from_str(&std::fs::read_to_string(&draft).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                let r = self.engine.call("capcut.importCapcutDraft", &json!([raw]), false)?;
                let path = if path.ends_with(store::PROJECT_EXT) { path } else { format!("{}{}", path.trim_end_matches(".json"), store::PROJECT_EXT) };
                store::save(&path, &r["project"])?;
                return Ok(self.open(&path));
            }
            Message::Forget(path) => {
                store::forget(&path);
                return Ok(self.load_cards());
            }
            Message::Home => {
                self.stop_playback();
                if let Some(ed) = self.ed() {
                    ed.last_edit = Instant::now() - Duration::from_secs(5);
                    ed.autosave()?;
                }
                self.screen = Screen::Home;
                return Ok(self.load_cards());
            }
            Message::ToastClose => self.toast = None,
            Message::ToastUndo => {
                self.toast = None;
                let (jobs, tmp) = (self.jobs.clone(), self.tools.tmp_dir.clone());
                if let Some(ed) = self.ed() {
                    ed.undo();
                    return Ok(want_still(ed, &jobs, &tmp));
                }
            }
            _ => return self.editor_update(message, lang),
        }
        Ok(Task::none())
    }

    fn editor_update(&mut self, message: Message, lang: Lang) -> Result<Task<Message>, String> {
        let engine_rc = self.engine.clone();
        let engine: &Engine = &engine_rc;
        let (jobs, tools, window_w) = (self.jobs.clone(), self.tools.clone(), self.window.width);
        let message = match message {
            Message::Export(m) => return self.export(m),
            m => m,
        };
        let Screen::Editor(ed) = &mut self.screen else { return Ok(Task::none()) };
        let mut toast: Option<(String, bool)> = None;
        let mut task = Task::none();
        match message {
            Message::Timeline(m) => match m {
                TlMsg::Seek(t) => {
                    ed.playback = None;
                    ed.frame = None;
                    ed.playhead = t.min(ed.p.duration()).max(0.0);
                    ed.still_wanted += 1;
                }
                TlMsg::ClickEmpty(t) => {
                    ed.selection.clear();
                    ed.menu = None;
                    ed.playback = None;
                    ed.frame = None;
                    ed.playhead = t.min(ed.p.duration()).max(0.0);
                    ed.still_wanted += 1;
                }
                TlMsg::Select(ids) => {
                    ed.selection = ids;
                    ed.menu = None;
                }
                TlMsg::Toggle(id) => {
                    if let Some(i) = ed.selection.iter().position(|x| x == &id) {
                        ed.selection.remove(i);
                    } else {
                        ed.selection.push(id);
                    }
                }
                TlMsg::Move { ids, delta, track, pointer } => {
                    let lead = ed.p.clip(&ids[0]).cloned().ok_or("clip gone")?;
                    let main = ed.p.main_track().map(|t| t.id.clone());
                    if ids.len() == 1 {
                        let to = track.unwrap_or(lead.track_id.clone());
                        if ed.p.settings.magnet && Some(&to) == main.as_ref() {
                            ed.op(engine, "insertOnTrack", vec![json!(lead.id), json!(pointer), json!(to)], None)?;
                        } else {
                            ed.op(engine, "moveClip", vec![json!(lead.id), json!({ "start": (lead.start + delta).max(0.0), "trackId": to })], None)?;
                        }
                    } else {
                        ed.op(engine, "moveClips", vec![json!(ids), json!(delta)], None)?;
                    }
                }
                TlMsg::Trim { id, left, t } => {
                    let c = ed.p.clip(&id).cloned().ok_or("clip gone")?;
                    let speed = if c.media_id.is_some() && c.speed > 0.0 { c.speed } else { 1.0 };
                    let patch = match (c.media_id.is_some(), left) {
                        (true, true) => json!({ "in": c.in_ + (t - c.start) * speed }),
                        (true, false) => json!({ "out": c.in_ + (t - c.start) * speed }),
                        (false, true) => json!({ "in": t - c.start }),
                        (false, false) => json!({ "out": (t - c.start).max(0.1) }),
                    };
                    ed.op(engine, "trimClip", vec![json!(id), patch], None)?;
                }
                TlMsg::View { pps, scroll } => {
                    ed.pps = pps;
                    ed.scroll = scroll;
                }
                TlMsg::Menu { x, y, clip, t } => {
                    if let Some(id) = &clip {
                        if !ed.selection.contains(id) {
                            ed.selection = vec![id.clone()];
                        }
                    }
                    ed.menu = Some(Menu { x, y, clip, t });
                }
                TlMsg::TrackFlag { id, flag } => {
                    let current = ed.json["tracks"].as_array().and_then(|t| t.iter().find(|t| t["id"] == id.as_str())).map(|t| t[flag].as_bool().unwrap_or(false)).unwrap_or(false);
                    ed.op(engine, "setTrack", vec![json!(id), json!({ flag: !current })], None)?;
                }
                TlMsg::Drop { t, track } => {
                    if let Some(media) = ed.drag_media.take() {
                        add_media(ed, engine, &media, Some((t, track)))?;
                    }
                }
            },
            Message::Undo => ed.undo(),
            Message::Redo => ed.redo(),
            Message::Play => {
                if ed.playback.is_some() {
                    ed.playback = None;
                    ed.frame = None;
                    ed.still_wanted += 1;
                } else if !ed.p.clips.is_empty() {
                    if ed.playhead >= ed.p.duration() - 0.05 {
                        ed.playhead = 0.0;
                    }
                    let project = ed.with_proxies();
                    let video = engine.call("exporter.previewStream", &json!([project, { "from": ed.playhead, "width": 960, "kind": "video" }]), false)?;
                    let rate = playback::output_rate().unwrap_or(48000);
                    let audio = engine.call("exporter.previewStream", &json!([project, { "from": ed.playhead, "kind": "audio", "rate": rate }]), false)?;
                    ed.playback = Some(playback::Playback::start(&tools, ed.playhead, &video, &audio)?);
                }
            }
            Message::Step(dt) => {
                ed.playback = None;
                ed.frame = None;
                ed.playhead = (ed.playhead + dt).clamp(0.0, ed.p.duration());
                ed.still_wanted += 1;
            }
            Message::Split => {
                let t = ed.playhead;
                if ed.selection.is_empty() {
                    ed.op(engine, "splitAt", vec![json!(t)], None)?;
                } else {
                    let mut p = ed.json.clone();
                    for id in ed.selection.clone() {
                        p = editor::project_of(&engine.call("ops.splitClip", &json!([p, id, t]), false)?);
                    }
                    let settled = engine.call("ops.settle", &json!([p]), false)?;
                    ed.commit(settled, None);
                }
            }
            Message::Delete(ripple) => {
                let ids = ed.selection.clone();
                if !ids.is_empty() {
                    ed.op(engine, "deleteClips", vec![json!(ids), json!({ "ripple": ripple })], None)?;
                    ed.selection.clear();
                    toast = Some((i18n::plural(lang, ids.len(), "Deleted 1 clip", "Deleted {0} clips"), true));
                }
            }
            Message::DeleteSide(left) => {
                let ids = ed.targets();
                if !ids.is_empty() {
                    let magnet = ed.p.settings.magnet;
                    ed.op(engine, "trimToTime", vec![json!(ids), json!(ed.playhead), json!(if left { "left" } else { "right" }), json!({ "ripple": magnet })], None)?;
                }
            }
            Message::Duplicate => {
                let ids = ed.targets();
                if !ids.is_empty() {
                    let end = ids.iter().filter_map(|id| ed.p.clip(id)).map(|c| c.end()).fold(0.0, f64::max);
                    let r = ed.op(engine, "duplicateClips", vec![json!(ids), json!(end)], None)?;
                    ed.selection = serde_json::from_value(r["ids"].clone()).unwrap_or_default();
                }
            }
            Message::Copy => ed.clipboard = ed.targets(),
            Message::CopyLook => {
                let id = ed.targets().first().cloned().ok_or_else(|| t(lang, "Select a clip to edit it.").to_string())?;
                let c = ed.clip_json(&id);
                let keys = ["filter", "adjust", "effects", "color", "lut", "mask", "chroma", "videoDenoise"];
                ed.look_clipboard = Some(Value::Object(keys.iter().map(|k| (k.to_string(), c[*k].clone())).collect()));
                toast = Some((t(lang, "Attributes copied").into(), false));
            }
            Message::PasteLook => {
                let look = ed.look_clipboard.clone().ok_or_else(|| t(lang, "Copy a clip's attributes first (Ctrl+Alt+C).").to_string())?;
                let ids: Vec<String> = ed.targets().into_iter().filter(|id| ed.p.clip(id).is_some_and(|c| c.media_id.is_some() || c.adjustment)).collect();
                // One undo step for all of them.
                let mut next = ed.json.clone();
                for id in &ids {
                    next = engine.call("ops.setClip", &json!([next, id, look]), false)?;
                }
                let settled = engine.call("ops.settle", &json!([next]), false)?;
                ed.commit(settled, None);
                toast = Some((i18n::plural(lang, ids.len(), "Attributes pasted to 1 clip", "Attributes pasted to {0} clips"), true));
            }
            Message::Paste(at) => {
                let ids: Vec<String> = ed.clipboard.iter().filter(|id| ed.p.clip(id).is_some()).cloned().collect();
                if !ids.is_empty() {
                    let at = at.unwrap_or(ed.playhead);
                    let r = ed.op(engine, "duplicateClips", vec![json!(ids), json!(at)], None)?;
                    ed.selection = serde_json::from_value(r["ids"].clone()).unwrap_or_default();
                }
                ed.menu = None;
            }
            Message::SelectAll => ed.selection = ed.p.clips.iter().filter(|c| !ed.p.track(&c.track_id).is_some_and(|t| t.locked)).map(|c| c.id.clone()).collect(),
            Message::Marker(t) => {
                ed.op(engine, "addMarker", vec![json!(t)], None)?;
                ed.menu = None;
            }
            Message::Import => {
                return Ok(Task::perform(
                    async move {
                        let files = rfd::AsyncFileDialog::new()
                            .set_title(t(lang, "Import media"))
                            .add_filter("Media", &["mp4", "mkv", "mov", "webm", "avi", "m4v", "wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "png", "jpg", "jpeg", "webp"])
                            .pick_files()
                            .await
                            .unwrap_or_default();
                        files.into_iter().map(|f| f.path().to_string_lossy().into_owned()).collect::<Vec<_>>()
                    },
                    Message::ImportPicked,
                ));
            }
            Message::ImportPicked(paths) => {
                if !paths.is_empty() {
                    return Ok(jobs.spawn("probe", move |e| paths.iter().map(|p| e.call("media.probe", &json!([p]), false)).collect(), Message::Imported));
                }
            }
            Message::Imported(Ok(infos)) => {
                jobs.end("probe");
                if infos.is_empty() {
                    return Ok(Task::none());
                }
                let empty = ed.p.clips.is_empty();
                let mut p = ed.json.clone();
                let mut first_video = None;
                let mut multitrack = None;
                for info in &infos {
                    let r = engine.call("ops.addMedia", &json!([p, info]), false)?;
                    p = r["project"].clone();
                    let id = r["media"]["id"].clone();
                    if empty {
                        p = engine.call("ops.addClip", &json!([p, { "mediaId": id }]), false)?["project"].clone();
                    }
                    if info["hasVideo"] == true && info["kind"] != "image" && first_video.is_none() {
                        first_video = Some(id.clone());
                    }
                    if info["audioTracks"].as_array().is_some_and(|a| a.len() > 1) {
                        multitrack = Some(info["audioTracks"].as_array().map(Vec::len).unwrap_or(0));
                    }
                }
                if let (true, Some(id)) = (empty, first_video) {
                    // The first video sets the project's size and frame rate.
                    p = engine.call("ops.matchCanvas", &json!([p, id]), false)?;
                }
                ed.commit(p, None);
                if empty {
                    ed.fitted = false;
                }
                toast = Some((match multitrack {
                    Some(n) => format!("{} — {}", i18n::plural(lang, infos.len(), "Imported 1 file", "Imported {0} files"), i18n::plural(lang, n, "1 recorded audio track", "{0} recorded audio tracks (OBS)")),
                    None => i18n::plural(lang, infos.len(), "Imported 1 file", "Imported {0} files"),
                }, false));
                task = prep_next(ed, &jobs);
            }
            Message::Imported(Err(e)) => {
                jobs.end("probe");
                return Err(e);
            }
            Message::AddMedia(id) => {
                add_media(ed, engine, &id, None)?;
            }
            Message::DragMedia(id) => ed.drag_media = id,
            Message::Prepared(id, result) => {
                ed.prep_busy = false;
                if let Ok(prep) = result {
                    if let Some(proxy) = prep.proxy {
                        ed.proxies.insert(id.clone(), proxy);
                    }
                    if let Some(peaks) = prep.peaks {
                        ed.waves.insert(id.clone(), peaks);
                    }
                    if let Some((tiles, tile_w, tile_h, interval)) = prep.strip {
                        ed.strips.insert(id.clone(), Arc::new(Strip { tiles, tile_w, tile_h, interval }));
                    }
                    ed.still_wanted += 1;
                }
                jobs.end(&format!("prep:{id}"));
                task = prep_next(ed, &jobs);
            }
            Message::Still(seq, result) => {
                ed.still_busy = false;
                ed.still_seen = seq;
                if let Ok(bytes) = result {
                    if seq <= ed.still_wanted {
                        ed.still = Some(image::Handle::from_bytes(bytes));
                    }
                }
                jobs.end("still");
            }
            Message::SetClip(id, patch, key) => {
                ed.op(engine, "setClip", vec![json!(id), patch], Some(key))?;
            }
            Message::Audio(tool) => {
                let ids = ed.targets();
                let Some(clip) = ids.first().and_then(|id| ed.p.clip(id)).cloned() else { return Err(t(lang, "Select a clip to edit it.").into()) };
                let media_id = clip.media_id.clone().ok_or_else(|| t(lang, "Select a clip to edit it.").to_string())?;
                let media = ed.json["media"].as_array().and_then(|m| m.iter().find(|m| m["id"] == media_id.as_str())).cloned().ok_or("media gone")?;
                let job = format!("audio:{media_id}");
                if ed.busy.is_some() {
                    return Err(t(lang, "Wait for the current task to finish").into());
                }
                ed.busy = Some((job.clone(), t(lang, if tool == AudioTool::Tracks { "Splitting recorded tracks…" } else { "Separating voice, game and music…" }).into()));
                let mid = media_id.clone();
                return Ok(jobs.spawn(&job, move |e| {
                    let path = media["path"].as_str().unwrap_or_default().to_string();
                    let media = if tool == AudioTool::Tracks { e.call("media.probe", &json!([path]), false).map(|mut fresh| {
                        fresh["id"] = media["id"].clone();
                        fresh
                    })? } else { media };
                    if tool == AudioTool::Tracks && media["audioTracks"].as_array().is_none_or(|a| a.len() < 2) {
                        return Ok(Vec::new());
                    }
                    let name = if tool == AudioTool::Tracks { "media.splitAudioTracks" } else { "python.separateStems" };
                    let r = e.call(name, &json!([media, {}]), true)?;
                    serde_json::from_value(r).map_err(|e| e.to_string())
                }, move |r| Message::AudioDone(mid, tool, r)));
            }
            Message::AudioDone(media_id, tool, result) => {
                ed.busy = None;
                let job = format!("audio:{media_id}");
                jobs.end(&job);
                let layers = result?;
                if layers.is_empty() {
                    return Err(t(lang, "This recording has one audio track. Use Separate voice, game & music instead.").into());
                }
                let keep: Vec<Value> = layers
                    .iter()
                    .filter(|l| !(tool == AudioTool::NoMusic && l["stem"] == "music"))
                    .map(|l| json!({ "info": l, "name": l["name"].as_str().unwrap_or("Audio").split(" (").next().unwrap_or("Audio"), "role": l["role"] }))
                    .collect();
                let n = keep.len();
                ed.op(engine, "addAudioLayers", vec![json!(media_id), json!(keep)], None)?;
                toast = Some((match tool {
                    AudioTool::Stems => t(lang, "Added voice, game and music tracks").into(),
                    AudioTool::NoMusic => t(lang, "Music removed: voice and game sound kept").into(),
                    AudioTool::Tracks => i18n::plural(lang, n, "Added 1 audio track", "Added {0} audio tracks"),
                }, true));
                task = prep_next(ed, &jobs);
            }
            Message::Panel(p) => ed.panel = p,
            Message::Reveal(id, p) => {
                ed.selection = vec![id];
                ed.panel = p;
            }
            Message::Asset(a) => ed.asset = a,
            Message::AnimSide(out) => ed.anim_out = out,
            Message::CaptionLang(code) => ed.caption_lang = code,
            Message::Op(name, args, coalesce) => {
                let result = ed.op(engine, name, args, coalesce)?;
                // Ops that add a clip (text, titles, adjustment layers) select it.
                if let Some(id) = result["clip"]["id"].as_str() {
                    ed.selection = vec![id.to_string()];
                }
            }
            Message::Flow(name, args, what) => {
                if ed.busy.is_some() {
                    return Err(t(lang, "Wait for the current task to finish").into());
                }
                let mut all = vec![ed.json.clone()];
                all.extend(args);
                ed.busy = Some(("flow".into(), t(lang, what).into()));
                // shortcut: edits made while this runs are replaced by its result; block the UI if that bites.
                return Ok(jobs.spawn("flow", move |e| e.call(&format!("flows.{name}"), &Value::Array(all), true), Message::FlowDone));
            }
            Message::CancelFlow => jobs.cancel("flow"),
            Message::RatioPick(w, h) => {
                let (cw, ch) = ui::ratio_size(&ed.p.canvas, w, h);
                ed.op(engine, "setCanvas", vec![json!({ "width": cw, "height": ch })], None)?;
            }
            Message::FlowDone(result) => {
                ed.busy = None;
                jobs.end("flow");
                let done = result?;
                let settled = engine.call("ops.settle", &json!([editor::project_of(&done)]), false)?;
                ed.commit(settled, None);
                if let Some(id) = done["clip"]["id"].as_str() {
                    ed.selection = vec![id.to_string()];
                }
                toast = Some((done["note"].as_str().map(|n| i18n::message(lang, n)).unwrap_or_else(|| t(lang, "Done").into()), true));
                task = prep_next(ed, &jobs);
            }
            Message::Looks(clip, result) => {
                ed.looks_busy = false;
                jobs.end("looks");
                let mut pictures = HashMap::new();
                match result {
                    Ok(v) => {
                        for (kind, items) in v.as_object().into_iter().flatten() {
                            for (id, path) in items.as_object().into_iter().flatten() {
                                pictures.insert(format!("{kind}:{id}"), image::Handle::from_path(path.as_str().unwrap_or_default()));
                            }
                        }
                    }
                    Err(e) => eprintln!("looks: {e}"),
                }
                ed.looks = Some((clip, pictures));
            }
            Message::TextEdit(action) => {
                if let Some((id, content)) = ed.text_box.as_mut() {
                    let edit = action.is_edit();
                    content.perform(action);
                    if edit {
                        let (id, text) = (id.clone(), content.text());
                        ed.op(engine, "setClip", vec![json!(id), json!({ "text": text.trim_end_matches('\n') })], Some("text"))?;
                    }
                }
            }
            Message::Pick(kind) => {
                let name = ed.p.name.clone();
                let dialog = rfd::AsyncFileDialog::new();
                let dialog = match kind {
                    "subtitles" => dialog.set_title(t(lang, "Import subtitles")).add_filter("Subtitles", &["srt", "vtt"]),
                    "lut" => dialog.set_title(t(lang, "Load a LUT")).add_filter("LUT", &["cube"]),
                    _ => dialog.set_title(t(lang, "Save captions")).set_file_name(format!("{name}.srt")).add_filter("SubRip", &["srt"]),
                };
                let save = kind == "save-srt";
                return Ok(Task::perform(
                    async move {
                        let file = if save { dialog.save_file().await } else { dialog.pick_file().await };
                        file.map(|f| f.path().to_string_lossy().into_owned())
                    },
                    move |path| Message::Picked(kind, path),
                ));
            }
            Message::Picked(_, None) => {}
            Message::Picked(kind, Some(path)) => match kind {
                "subtitles" => return Ok(Task::done(Message::Flow("importSubtitles", vec![json!(path), json!({})], "Importing subtitles…"))),
                "lut" => {
                    let id = ed.current().map(|c| c.id.clone()).ok_or_else(|| t(lang, "Select a clip to edit it.").to_string())?;
                    ed.op(engine, "setClip", vec![json!(id), json!({ "lut": path })], None)?;
                }
                _ => {
                    let saved = engine.call("flows.saveSubtitles", &json!([ed.json, path, {}]), false)?;
                    toast = Some((i18n::fill(t(lang, "Saved {0}"), &[saved["path"].as_str().unwrap_or_default().to_string()]), false));
                }
            },
            Message::CloseMenu => ed.menu = None,
            Message::Rename(name) => {
                if !name.trim().is_empty() {
                    ed.op(engine, "rename", vec![json!(name.trim())], Some("rename"))?;
                }
            }
            Message::Zoom(k) => ed.pps = (ed.pps * k).clamp(0.5, 800.0),
            Message::Fit => ed.fit(window_w),
            Message::Magnet(on) => {
                ed.op(engine, "setSettings", vec![json!({ "magnet": on })], None)?;
            }
            _ => {}
        }
        ed.sync_text_box();
        let panels = ed.panels();
        if !panels.contains(&ed.panel) {
            ed.panel = panels[0];
        }
        let still = Task::batch([want_still(ed, &jobs, &tools.tmp_dir), want_looks(ed, &jobs)]);
        if let Some((text, undo)) = toast {
            self.notify(text, undo);
        }
        Ok(Task::batch([task, still]))
    }

    fn export(&mut self, m: ExportMsg) -> Result<Task<Message>, String> {
        let (lang, jobs) = (self.lang, self.jobs.clone());
        let Screen::Editor(ed) = &mut self.screen else { return Ok(Task::none()) };
        match m {
            ExportMsg::Open => {
                ed.menu = None;
                ed.export = Some(ExportForm { resolution: 0, fps: 0, quality: "recommended", codec: "h264", running: None, done: None });
            }
            ExportMsg::Close => {
                if ed.export.as_ref().is_none_or(|f| f.running.is_none()) {
                    ed.export = None;
                }
            }
            ExportMsg::Resolution(r) => ed.export.as_mut().ok_or("")?.resolution = r,
            ExportMsg::Fps(f) => ed.export.as_mut().ok_or("")?.fps = f,
            ExportMsg::Quality(q) => ed.export.as_mut().ok_or("")?.quality = q,
            ExportMsg::Codec(c) => ed.export.as_mut().ok_or("")?.codec = c,
            ExportMsg::Start => {
                let ext = if ed.export.as_ref().is_some_and(|f| f.codec == "prores") { "mov" } else { "mp4" };
                let dir = std::path::Path::new(&ed.path).parent().map(std::path::Path::to_path_buf).unwrap_or_default();
                let name = format!("{}.{ext}", ed.p.name);
                return Ok(Task::perform(
                    async move { rfd::AsyncFileDialog::new().set_title(t(lang, "Export video")).set_directory(dir).set_file_name(name).add_filter(ext.to_uppercase(), &[ext]).save_file().await.map(|f| f.path().to_string_lossy().into_owned()) },
                    |p| Message::Export(ExportMsg::Picked(p)),
                ));
            }
            ExportMsg::Picked(None) => {}
            ExportMsg::Picked(Some(out)) => {
                let form = ed.export.clone().ok_or("")?;
                let mut opts = json!({ "outPath": out, "codec": form.codec, "quality": form.quality });
                if form.resolution > 0 {
                    opts["resolution"] = json!(form.resolution);
                }
                if form.fps > 0 {
                    opts["fps"] = json!(form.fps);
                }
                let project = ed.json.clone();
                ed.export.as_mut().ok_or("")?.running = Some("export".into());
                ed.export.as_mut().ok_or("")?.done = None;
                return Ok(jobs.spawn("export", move |e| e.call("exporter.renderProject", &json!([project, opts]), true).map(|r| r["path"].as_str().unwrap_or_default().to_string()), |r| Message::Export(ExportMsg::Done(r))));
            }
            ExportMsg::Done(r) => {
                if let Some(form) = ed.export.as_mut() {
                    form.running = None;
                    form.done = Some(r.map_err(|e| if e.contains("cancel") || e.contains("Cancel") { t(lang, "Export cancelled").to_string() } else { e }));
                }
                jobs.end("export");
            }
            ExportMsg::Cancel => {
                jobs.cancel("export");
            }
            ExportMsg::Reveal(path) => {
                let _ = std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn();
            }
        }
        Ok(Task::none())
    }

    fn tick(&mut self) -> Task<Message> {
        if self.toast.as_ref().is_some_and(|t| Instant::now() > t.until) {
            self.toast = None;
        }
        let (w, engine, jobs, tmp) = (self.window.width, self.engine.clone(), self.jobs.clone(), self.tools.tmp_dir.clone());
        let Screen::Editor(ed) = &mut self.screen else { return Task::none() };
        if !ed.fitted && ed.p.duration() > 0.0 {
            ed.fitted = true;
            ed.fit(w);
        }
        if let Some(at) = ed.resume.take() {
            if at < ed.p.duration() - 0.05 {
                ed.playhead = at;
                return Task::done(Message::Play);
            }
        }
        if let Some(pb) = ed.playback.as_mut() {
            if let Some(f) = pb.frame() {
                ed.frame = Some(image::Handle::from_rgba(f.width, f.height, f.rgba));
            }
            ed.playhead = pb.time().min(ed.p.duration());
            // Keep the playhead in view.
            let x = ed.playhead as f32 * ed.pps - ed.scroll;
            if x > w - timeline::HEADER - 80.0 || x < 0.0 {
                ed.scroll = (ed.playhead as f32 * ed.pps - 80.0).max(0.0);
            }
            if pb.finished() || ed.playhead >= ed.p.duration() - 1e-3 {
                ed.playback = None;
                ed.frame = None;
                ed.still_wanted += 1;
            }
            return Task::none();
        }
        let saved = ed.autosave();
        let external = ed.check_external(&engine);
        let still = want_still(ed, &jobs, &tmp);
        if let Err(e) = saved {
            self.fail(i18n::fill(t(self.lang, "Save failed: {0}"), &[e]));
        } else if external {
            self.notify(t(self.lang, "Project updated from outside (agent edit)"), false);
        }
        still
    }

    fn key(&mut self, key: Key, mods: Modifiers) -> Task<Message> {
        if !matches!(self.screen, Screen::Editor(_)) {
            return Task::none();
        }
        let ctrl = mods.control();
        if ctrl && mods.alt() {
            let look = match key.as_ref() {
                Key::Character("c") => Some(Message::CopyLook),
                Key::Character("v") => Some(Message::PasteLook),
                _ => None,
            };
            if let Some(m) = look {
                return Task::done(m);
            }
        }
        let msg = match key.as_ref() {
            Key::Named(Named::Space) => Message::Play,
            Key::Named(Named::Delete) | Key::Named(Named::Backspace) => Message::Delete(mods.shift()),
            Key::Named(Named::ArrowLeft) => Message::Step(if mods.shift() { -1.0 } else { -1.0 / self.fps() }),
            Key::Named(Named::ArrowRight) => Message::Step(if mods.shift() { 1.0 } else { 1.0 / self.fps() }),
            Key::Named(Named::Home) => Message::Step(-1e9),
            Key::Named(Named::End) => Message::Step(1e9),
            Key::Named(Named::Escape) => Message::CloseMenu,
            Key::Character(c) => match (ctrl, mods.shift(), c.to_lowercase().as_str()) {
                (true, false, "z") => Message::Undo,
                (true, true, "z") | (true, _, "y") => Message::Redo,
                (true, _, "b") => Message::Split,
                (true, _, "c") => Message::Copy,
                (true, _, "v") => Message::Paste(None),
                (true, _, "d") => Message::Duplicate,
                (true, _, "a") => Message::SelectAll,
                (true, _, "i") => Message::Import,
                (true, _, "e") => Message::Export(ExportMsg::Open),
                (true, _, "=") | (true, _, "+") => Message::Zoom(1.4),
                (true, _, "-") => Message::Zoom(1.0 / 1.4),
                (false, false, "q") => Message::DeleteSide(true),
                (false, false, "w") => Message::DeleteSide(false),
                (false, false, "m") => Message::Marker(self.playhead()),
                (false, true, "z") => Message::Fit,
                _ => return Task::none(),
            },
            _ => return Task::none(),
        };
        self.update(msg)
    }

    fn fps(&self) -> f64 {
        match &self.screen {
            Screen::Editor(ed) => ed.p.canvas.fps.max(1.0),
            Screen::Home => 30.0,
        }
    }

    fn playhead(&self) -> f64 {
        match &self.screen {
            Screen::Editor(ed) => ed.playhead,
            Screen::Home => 0.0,
        }
    }

    fn subscription(&self) -> Subscription<Message> {
        let playing = matches!(&self.screen, Screen::Editor(ed) if ed.playback.is_some());
        Subscription::batch([
            iced::time::every(Duration::from_millis(if playing { 15 } else { 120 })).map(|_| Message::Tick),
            keyboard::listen().filter_map(|e| match e {
                keyboard::Event::KeyPressed { key, physical_key, modifiers, .. } => Some(Message::Key(latin_key(&physical_key, key), modifiers)),
                _ => None,
            }),
            iced::event::listen().map(Message::Event),
        ])
    }

    fn view(&self) -> iced::Element<'_, Message> {
        ui::view(self)
    }
}

fn add_media(ed: &mut Editor, engine: &Engine, media_id: &str, at: Option<(f64, Option<String>)>) -> Result<(), String> {
    let media = ed.p.media(media_id).cloned().ok_or("media gone")?;
    let kind = if media.has_video { "video" } else { "audio" };
    let empty = ed.p.clips.is_empty();
    let mut p = ed.json.clone();
    if empty && media.has_video && media.kind != "image" {
        p = engine.call("ops.matchCanvas", &json!([p, media_id]), false)?;
    }
    let main = ed.p.main_track().map(|t| t.id.clone());
    let track = at.as_ref().and_then(|(_, t)| t.clone()).filter(|t| ed.p.track(t).is_some_and(|t| t.kind == kind));
    let next = match at {
        Some((t, _)) if ed.p.settings.magnet && media.has_video && (track.is_none() || track == main) => {
            // Magnetic main track: drop between clips, no gaps.
            let added = engine.call("ops.addClip", &json!([p, { "mediaId": media_id, "trackId": main, "start": ed.p.duration() + 100.0 }]), false)?;
            let id = added["clip"]["id"].clone();
            engine.call("ops.insertOnTrack", &json!([added["project"], id, t, main]), false)?
        }
        Some((t, _)) => engine.call("ops.addClip", &json!([p, { "mediaId": media_id, "start": t, "trackId": track }]), false)?["project"].clone(),
        None => engine.call("ops.addClip", &json!([p, { "mediaId": media_id }]), false)?["project"].clone(),
    };
    let settled = engine.call("ops.settle", &json!([next]), false)?;
    ed.commit(settled, None);
    if empty {
        ed.fitted = false;
    }
    Ok(())
}

/// Proxy, filmstrip tiles and waveform for one media item.
fn prepare(e: &Engine, media: &Value) -> Result<Prep, String> {
    let proxy = e.call("media.ensureProxy", &json!([media, {}]), true)?.as_str().map(String::from);
    // Pictures (photos, stickers, freeze frames) are their own thumbnail, scaled down whole.
    let picture = || {
        let t = ::image::open(media["path"].as_str()?).ok()?.thumbnail(192, 108).to_rgba8();
        let (w, h) = t.dimensions();
        Some((vec![image::Handle::from_rgba(w, h, t.into_raw())], w, h, f64::INFINITY))
    };
    let strip = if media["kind"] == "image" { picture() } else { None }.or_else(|| e.call("media.filmstrip", &json!([media, { "source": proxy }]), false).ok().filter(|s| !s.is_null() && media["kind"] != "image").and_then(|s| {
        let img = ::image::open(s["image"].as_str()?).ok()?.to_rgba8();
        let (cols, count) = (s["cols"].as_u64()? as u32, s["count"].as_u64()? as u32);
        let (tw, th) = (s["tileW"].as_u64()? as u32, s["tileH"].as_u64()? as u32);
        let tiles = (0..count)
            .filter_map(|i| {
                let (x, y) = ((i % cols) * tw, (i / cols) * th);
                (x + tw <= img.width() && y + th <= img.height()).then(|| image::Handle::from_rgba(tw, th, ::image::imageops::crop_imm(&img, x, y, tw, th).to_image().into_raw()))
            })
            .collect::<Vec<_>>();
        Some((tiles, tw, th, s["interval"].as_f64().unwrap_or(f64::INFINITY)))
    }));
    let peaks = if media["hasAudio"] == true {
        e.call("media.waveform", &json!([media]), false).ok().and_then(|w| serde_json::from_value::<Vec<u8>>(w["peaks"].clone()).ok()).map(Arc::new)
    } else {
        None
    };
    Ok(Prep { proxy, peaks, strip })
}

/// A cached still of a project for the home screen (a third of the way in).
fn thumb(e: &Engine, path: &str, modified: f64) -> Result<Vec<u8>, String> {
    let dir = std::env::temp_dir().join("cutroom").join("thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{}.jpg", &host::sha1_hex(&format!("{path}|{modified}"))[..16]));
    if !out.exists() {
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let p = e.call("model.normalizeProject", &json!([raw]), false)?;
        let d: model::Project = serde_json::from_value(p.clone()).map_err(|e| e.to_string())?;
        let at = (d.duration() / 3.0).min(d.duration() - 0.05).max(0.0);
        e.call("exporter.renderFrame", &json!([p, at, out.to_string_lossy(), { "previewWidth": 480 }]), false)?;
    }
    std::fs::read(&out).map_err(|e| e.to_string())
}

/// `cutroom --selftest=<media file>`: the embedded engine end to end.
fn selftest(file: &str) {
    let tools = host::Tools::locate();
    let engine = Engine::new(&tools, Hooks::default()).expect("engine starts");
    let p = engine.call("model.createProject", &json!([{ "name": "self test", "canvas": "1080p" }]), false).expect("createProject");
    let info = engine.call("media.probe", &json!([file]), false).expect("probe");
    let added = engine.call("ops.addMedia", &json!([p, info]), false).expect("addMedia");
    let with_clip = engine.call("ops.addClip", &json!([added["project"], { "mediaId": added["media"]["id"] }]), false).expect("addClip")["project"].clone();
    let split = engine.call("ops.splitAt", &json!([with_clip, 1.0]), false).expect("splitAt");
    let peaks = engine.call("media.waveform", &json!([info]), false).expect("waveform");
    let stream = engine.call("exporter.previewStream", &json!([split, { "from": 0.5, "width": 640, "kind": "video" }]), false).expect("previewStream");
    println!("SELFTEST probe {} {}x{} fps {}", info["name"], info["width"], info["height"], info["fps"]);
    println!("SELFTEST clips after split: {}", split["clips"].as_array().map_or(0, |c| c.len()));
    println!("SELFTEST waveform peaks: {}", peaks["peaks"].as_array().map_or(0, |c| c.len()));
    println!("SELFTEST preview stream {}x{} at {} fps", stream["width"], stream["height"], stream["fps"]);
    let _ = host::remove(stream["dir"].as_str().unwrap_or_default());
    println!("SELFTEST stamp {}", store::stamp());
    match engine.call("ops.splitClip", &json!([split, "missing", 1.0]), false) {
        Err(e) => println!("SELFTEST error passes through: {e}"),
        Ok(_) => println!("SELFTEST error NOT reported"),
    }
    let _ = now_ms();
    // Export through the job hooks, then a cancelled one.
    let out = format!("{}/cutroom-selftest.mp4", tools.tmp_dir);
    let seen = Arc::new(Mutex::new(Vec::<f64>::new()));
    let log = seen.clone();
    let hooks = Hooks { progress: Arc::new(move |p| log.lock().unwrap().push(p)), cancel: Arc::default() };
    let job_engine = Engine::new(&tools, hooks).expect("engine starts");
    let done = job_engine.call("exporter.renderProject", &json!([split, { "outPath": out, "quality": "compact" }]), true).expect("export");
    let probed = engine.call("media.probe", &json!([done["path"]]), false).expect("probe export");
    let seen = seen.lock().unwrap().clone();
    println!("SELFTEST export {} {}x{} {:.2}s, {} progress updates, last {:.2}", probed["name"], probed["width"], probed["height"], probed["duration"].as_f64().unwrap_or(0.0), seen.len(), seen.last().copied().unwrap_or(0.0));
    let cancel = Arc::new(AtomicBool::new(true));
    let cancelled = Engine::new(&tools, Hooks { progress: Arc::new(|_| {}), cancel }).expect("engine starts");
    match cancelled.call("exporter.renderProject", &json!([split, { "outPath": out }]), true) {
        Err(e) => println!("SELFTEST cancelled export: {e}"),
        Ok(_) => println!("SELFTEST cancel NOT honoured"),
    }
    let _ = host::remove(&out);
}

/// Filter/effect thumbnails for the clip the Filters or Effects tab applies to
/// (once its preview proxy exists).
fn want_looks(ed: &mut Editor, jobs: &Jobs) -> Task<Message> {
    if ed.looks_busy || !matches!(ed.asset, editor::Asset::Filters | editor::Asset::Effects) {
        return Task::none();
    }
    let Some(c) = ed.targets().first().and_then(|id| ed.p.clip(id)).cloned() else { return Task::none() };
    let ready = c.media_id.as_deref().is_some_and(|id| ed.p.media(id).is_some_and(|m| m.has_video) && ed.proxies.contains_key(id));
    let key = ed.looks_key();
    if !ready || ed.looks.as_ref().is_some_and(|(k, _)| Some(k) == key.as_ref()) {
        return Task::none();
    }
    ed.looks_busy = true;
    let (project, id, at) = (ed.with_proxies(), c.id.clone(), ed.playhead);
    let id2 = key.unwrap_or_default();
    jobs.spawn("looks", move |e| e.call("flows.lookPreviews", &json!([project, id, at, { "width": 220 }]), true), move |r| Message::Looks(id2, r))
}

/// Prepare the next media item: preview proxy, filmstrip, waveform.
fn prep_next(ed: &mut Editor, jobs: &Jobs) -> Task<Message> {
    if ed.prep_busy {
        return Task::none();
    }
    while let Some(id) = ed.prep.pop_front() {
        let Some(media) = ed.json["media"].as_array().and_then(|m| m.iter().find(|m| m["id"] == id.as_str())).cloned() else { continue };
        ed.prep_busy = true;
        let id2 = id.clone();
        return jobs.spawn(&format!("prep:{id}"), move |e| prepare(e, &media), move |r| Message::Prepared(id2, r));
    }
    Task::none()
}

/// Ask for the exact still at the playhead (paused only); one at a time,
/// always for the latest state.
fn want_still(ed: &mut Editor, jobs: &Jobs, tmp_dir: &str) -> Task<Message> {
    if ed.playback.is_some() || ed.still_busy || ed.p.clips.is_empty() || ed.still_seen == ed.still_wanted {
        return Task::none();
    }
    ed.still_busy = true;
    let seq = ed.still_wanted;
    let project = ed.with_proxies();
    let t = ed.playhead.min((ed.p.duration() - 1.0 / ed.p.canvas.fps.max(1.0)).max(0.0));
    let out = std::path::Path::new(tmp_dir).join("preview").join(format!("f{}.jpg", seq % 6)).to_string_lossy().into_owned();
    jobs.spawn("still", move |e| {
        std::fs::create_dir_all(std::path::Path::new(&out).parent().unwrap()).map_err(|e| e.to_string())?;
        e.call("exporter.renderFrame", &json!([project, t, out, { "previewWidth": 1280 }]), false)?;
        std::fs::read(&out).map_err(|e| e.to_string())
    }, move |r| Message::Still(seq, r))
}

fn arg(prefix: &str) -> Option<String> {
    std::env::args().find_map(|a| a.strip_prefix(prefix).map(String::from))
}

fn scripted(name: &str) -> Option<Message> {
    Some(match name {
        "play" => Message::Play,
        "audio" => Message::Panel(Panel::Audio),
        "project" => Message::Panel(Panel::Project),
        "video" => Message::Panel(Panel::Video),
        "text" => Message::Panel(Panel::Text),
        "speed" => Message::Panel(Panel::Speed),
        "anim" => Message::Panel(Panel::Animation),
        "color" => Message::Panel(Panel::Color),
        "a-media" => Message::Asset(editor::Asset::Media),
        "a-audio" => Message::Asset(editor::Asset::Audio),
        "a-text" => Message::Asset(editor::Asset::Text),
        "a-effects" => Message::Asset(editor::Asset::Effects),
        "a-transitions" => Message::Asset(editor::Asset::Transitions),
        "a-captions" => Message::Asset(editor::Asset::Captions),
        "a-filters" => Message::Asset(editor::Asset::Filters),
        "a-adjust" => Message::Asset(editor::Asset::Adjustment),
        "a-stickers" => Message::Asset(editor::Asset::Stickers),
        "sticker" => Message::Flow("addSticker", vec![json!({ "emoji": "🔥", "start": 1.0 })], "Adding the sticker…"),
        "split" => Message::Split,
        "copylook" => Message::CopyLook,
        // An engine error on purpose, to check it reads in the chosen language.
        "bad-beats" => Message::Flow("beats", vec![json!("no-such-clip"), json!({})], "Finding the beats…"),
        "pastelook" => Message::PasteLook,
        "undo" => Message::Undo,
        "redo" => Message::Redo,
        "dup" => Message::Duplicate,
        "copy" => Message::Copy,
        "paste" => Message::Paste(None),
        "del" => Message::Delete(false),
        "ripple" => Message::Delete(true),
        "dleft" => Message::DeleteSide(true),
        "dright" => Message::DeleteSide(false),
        "marker" => Message::Marker(1.0),
        "step" => Message::Step(0.5),
        "zoomin" => Message::Zoom(1.4),
        "zoomout" => Message::Zoom(1.0 / 1.4),
        "fit" => Message::Fit,
        "lang" => Message::SetLang(Lang::from_code("ar")),
        "lang-en" => Message::SetLang(Lang::default()),
        "magnet" => Message::Magnet(false),
        "close-export" => Message::Export(ExportMsg::Close),
        "close-menu" => Message::CloseMenu,
        "toast-undo" => Message::ToastUndo,
        "ratio916" => Message::RatioPick(9.0, 16.0),
        "ratio169" => Message::RatioPick(16.0, 9.0),
        "bgblur" => Message::Op("setSettings", vec![json!({ "background": "blur" })], None),
        "home" => Message::Home,
        "add-text" => Message::Op("addText", vec![json!({ "text": "Hello مرحبا", "start": 0.5 })], None),
        "add-title" => Message::Op("addTitle", vec![json!("lower-third"), json!({ "start": 0.5 })], None),
        "export" => Message::Export(ExportMsg::Open),
        "select" => Message::SelectAll,
        "split" => Message::Split,
        "stems" => Message::Audio(AudioTool::Stems),
        "nomusic" => Message::Audio(AudioTool::NoMusic),
        "tracks" => Message::Audio(AudioTool::Tracks),
        "menu" => Message::Timeline(TlMsg::Menu { x: 700.0, y: 640.0, clip: None, t: 1.0 }),
        _ => {
            eprintln!("unknown --do step: {name}");
            return None;
        }
    })
}

/// Shortcuts follow the physical key, so Q/W/M/Ctrl+B… work with an Arabic keyboard layout too.
fn latin_key(physical: &keyboard::key::Physical, key: Key) -> Key {
    let keyboard::key::Physical::Code(code) = physical else { return key };
    let name = format!("{code:?}");
    match (name.strip_prefix("Key"), name.as_str()) {
        (Some(letter), _) => Key::Character(letter.to_lowercase().into()),
        (_, "Equal") => Key::Character("=".into()),
        (_, "Minus") => Key::Character("-".into()),
        _ => key,
    }
}
