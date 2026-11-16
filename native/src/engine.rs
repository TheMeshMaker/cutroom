//! Runs Cutroom's JavaScript engine (core/ and engine/, the same code the MCP
//! server uses) inside QuickJS, with the Rust host in host.rs underneath.
//! One engine per thread: the UI thread keeps one for edits, and every long
//! job (proxy, export, stems…) gets its own on a worker thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rquickjs::function::This;
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::{Context, Ctx, Exception, Function, Module, Object, Promise, Runtime};
use serde_json::Value;

use crate::host::{self, Tools};

static SOURCES: &[(&str, &str)] = &[
    ("entry.js", include_str!("entry.js")),
    ("core/model.js", include_str!("../../core/model.js")),
    ("core/ops.js", include_str!("../../core/ops.js")),
    ("core/render.js", include_str!("../../core/render.js")),
    ("core/catalog.js", include_str!("../../core/catalog.js")),
    ("core/captions.js", include_str!("../../core/captions.js")),
    ("core/transcript.js", include_str!("../../core/transcript.js")),
    ("core/capcut-import.js", include_str!("../../core/capcut-import.js")),
    ("core/analysis.js", include_str!("../../core/analysis.js")),
    ("engine/media.js", include_str!("../../engine/media.js")),
    ("engine/exporter.js", include_str!("../../engine/exporter.js")),
    ("engine/python.js", include_str!("../../engine/python.js")),
    ("engine/flows.js", include_str!("../../engine/flows.js")),
];

struct Embedded;

impl Resolver for Embedded {
    // "./model.js" from "core/ops.js" -> "core/model.js", "../core/x.js" from "engine/y.js" -> "core/x.js"
    fn resolve<'js>(&mut self, _ctx: &Ctx<'js>, base: &str, name: &str, _attributes: Option<ImportAttributes<'js>>) -> rquickjs::Result<String> {
        let mut parts: Vec<&str> = base.split('/').collect();
        parts.pop();
        for seg in name.split('/') {
            match seg {
                "." | "" => {}
                ".." => {
                    parts.pop();
                }
                s => parts.push(s),
            }
        }
        Ok(parts.join("/"))
    }
}

impl Loader for Embedded {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str, _attributes: Option<ImportAttributes<'js>>) -> rquickjs::Result<Module<'js, rquickjs::module::Declared>> {
        let (_, source) = SOURCES.iter().find(|(n, _)| *n == name).ok_or_else(|| rquickjs::Error::new_loading(name))?;
        Module::declare(ctx.clone(), name, *source)
    }
}

/// Progress and cancel hooks for a long job.
#[derive(Clone)]
pub struct Hooks {
    pub progress: Arc<dyn Fn(f64) + Send + Sync>,
    pub cancel: Arc<AtomicBool>,
}

impl Default for Hooks {
    fn default() -> Self {
        Hooks { progress: Arc::new(|_| {}), cancel: Arc::new(AtomicBool::new(false)) }
    }
}

pub struct Engine {
    _runtime: Runtime,
    context: Context,
}

fn message(ctx: &Ctx, e: rquickjs::Error) -> String {
    if let rquickjs::Error::Exception = e {
        let v = ctx.catch();
        if let Some(ex) = v.as_exception() {
            return ex.message().unwrap_or_else(|| "JavaScript error".into());
        }
        return v.as_string().and_then(|s| s.to_string().ok()).unwrap_or_else(|| format!("{v:?}"));
    }
    e.to_string()
}

impl Engine {
    pub fn new(tools: &Tools, hooks: Hooks) -> Result<Engine, String> {
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_loader(Embedded, Embedded);
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;
        context.with(|ctx| -> Result<(), String> {
            register(&ctx, tools, hooks).map_err(|e| message(&ctx, e))?;
            Module::import(&ctx, "entry.js").and_then(|p| p.finish::<()>()).map_err(|e| message(&ctx, e))
        })?;
        Ok(Engine { _runtime: runtime, context })
    }

    /// Call an engine function such as "ops.splitClip" with JSON arguments.
    /// `job` adds progress/cancel hooks to the last (options) argument.
    pub fn call(&self, name: &str, args: &Value, job: bool) -> Result<Value, String> {
        let json = args.to_string();
        self.context.with(|ctx| {
            let run = || -> rquickjs::Result<String> {
                let cut: Object = ctx.globals().get("cut")?;
                let call: Function = cut.get("call")?;
                let promise: Promise = call.call((This(cut), name, json, job))?;
                promise.finish::<String>()
            };
            let text = run().map_err(|e| message(&ctx, e))?;
            serde_json::from_str(&text).map_err(|e| e.to_string())
        })
    }

    /// A constant such as "catalog.TITLE_TEMPLATES".
    pub fn value(&self, name: &str) -> Value {
        self.context.with(|ctx| {
            let get = || -> rquickjs::Result<String> {
                let cut: Object = ctx.globals().get("cut")?;
                let value: Function = cut.get("value")?;
                value.call((This(cut), name))
            };
            get().ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
        })
    }
}

fn register<'js>(ctx: &Ctx<'js>, tools: &Tools, hooks: Hooks) -> rquickjs::Result<()> {
    let g = ctx.globals();
    let info = serde_json::to_string(tools).unwrap_or_default();
    let fail = |ctx: &Ctx<'js>, msg: String| Exception::throw_message(ctx, &msg);
    g.set("__host_info", Function::new(ctx.clone(), move || info.clone())?)?;
    g.set("__log", Function::new(ctx.clone(), |text: String| eprintln!("[engine] {text}"))?)?;
    let progress = hooks.progress.clone();
    g.set("__progress", Function::new(ctx.clone(), move |p: f64| progress(p))?)?;
    let cancel = hooks.cancel.clone();
    g.set("__cancelled", Function::new(ctx.clone(), move || cancel.load(Ordering::Relaxed))?)?;
    let cancel = hooks.cancel.clone();
    g.set(
        "__run",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, cmd: String, args: String, env: String, on_stdout: Option<Function<'js>>| -> rquickjs::Result<String> {
            let args: Vec<String> = serde_json::from_str(&args).map_err(|e| fail(&ctx, e.to_string()))?;
            let env: Vec<(String, String)> = serde_json::from_str::<Option<std::collections::HashMap<String, String>>>(&env).ok().flatten().map(|m| m.into_iter().collect()).unwrap_or_default();
            let result = host::run(&cmd, &args, &env, |chunk| {
                if let Some(f) = &on_stdout {
                    let _ = f.call::<_, ()>((chunk.to_string(),));
                }
            }, &cancel)
            .map_err(|e| fail(&ctx, e))?;
            Ok(serde_json::to_string(&result).unwrap_or_default())
        })?,
    )?;
    let ffmpeg = tools.ffmpeg.clone();
    g.set(
        "__peaks",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, path: String, per_second: u32, stream: u32| -> rquickjs::Result<String> {
            let peaks = host::peaks(&ffmpeg, &path, per_second, stream).map_err(|e| fail(&ctx, e))?;
            Ok(serde_json::to_string(&peaks).unwrap_or_default())
        })?,
    )?;
    g.set("__stat", Function::new(ctx.clone(), |path: String| serde_json::to_string(&host::stat(&path)).unwrap_or_else(|_| "null".into()))?)?;
    g.set("__mkdir", Function::new(ctx.clone(), move |ctx: Ctx<'js>, path: String| std::fs::create_dir_all(&path).map_err(|e| fail(&ctx, format!("{path}: {e}"))))?)?;
    g.set("__read_text", Function::new(ctx.clone(), move |ctx: Ctx<'js>, path: String| std::fs::read_to_string(&path).map_err(|e| fail(&ctx, format!("{path}: {e}"))))?)?;
    g.set("__write_text", Function::new(ctx.clone(), move |ctx: Ctx<'js>, path: String, text: String| std::fs::write(&path, text).map_err(|e| fail(&ctx, format!("{path}: {e}"))))?)?;
    g.set("__rename", Function::new(ctx.clone(), move |ctx: Ctx<'js>, from: String, to: String| std::fs::rename(&from, &to).map_err(|e| fail(&ctx, format!("{from}: {e}"))))?)?;
    g.set("__rm", Function::new(ctx.clone(), move |ctx: Ctx<'js>, path: String| host::remove(&path).map_err(|e| fail(&ctx, format!("{path}: {e}"))))?)?;
    g.set("__mkdtemp", Function::new(ctx.clone(), move |ctx: Ctx<'js>, prefix: String| host::mkdtemp(&prefix).map_err(|e| fail(&ctx, e.to_string())))?)?;
    g.set("__sha1", Function::new(ctx.clone(), |text: String| host::sha1_hex(&text))?)?;
    Ok(())
}
