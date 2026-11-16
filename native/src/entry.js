// Glue between the native app and Cutroom's JavaScript engine: the same
// core/ and engine/ code the MCP server runs. The __* functions are Rust
// (native/src/engine.rs); everything here is synchronous underneath.
import * as model from "./core/model.js";
import * as ops from "./core/ops.js";
import * as render from "./core/render.js";
import * as captions from "./core/captions.js";
import * as transcript from "./core/transcript.js";
import * as catalog from "./core/catalog.js";
import * as capcut from "./core/capcut-import.js";
import * as analysis from "./core/analysis.js";
import { createMedia } from "./engine/media.js";
import { createExporter } from "./engine/exporter.js";
import { createPython } from "./engine/python.js";
import { createFlows } from "./engine/flows.js";

// shortcut: JSON round-trip instead of a real structuredClone; project data is plain JSON.
globalThis.structuredClone ??= (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
globalThis.console ??= { log: (...a) => __log(a.join(" ")), warn: (...a) => __log(a.join(" ")), error: (...a) => __log(a.join(" ")) };

// Windows paths (the app ships for Windows).
const join = (...parts) => parts.filter((x) => x !== "").join("\\").replace(/(?!^)[\\/]+/g, "\\");
const basename = (p) => p.split(/[\\/]/).pop();
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "") || p;
const extname = (p) => /(\.[^.]*)$/.exec(basename(p))?.[1] ?? "";

const host = {
  ...JSON.parse(__host_info()),
  join,
  basename,
  dirname,
  extname,
  run: (cmd, args, opts = {}) => JSON.parse(__run(cmd, JSON.stringify(args), JSON.stringify(opts.env ?? null), opts.onStdout ?? null)),
  peaks: (path, { perSecond, stream = 0 }) => JSON.parse(__peaks(path, perSecond, stream)),
  stat: (p) => JSON.parse(__stat(p)),
  mkdir: (p) => __mkdir(p),
  readText: (p) => __read_text(p),
  writeText: (p, text) => __write_text(p, text),
  rename: (from, to) => __rename(from, to),
  rm: (p) => __rm(p),
  mkdtemp: (prefix) => __mkdtemp(prefix),
  sha1: (text) => __sha1(text),
};

const media = createMedia(host);
const python = createPython(host, media);
const exporter = createExporter(host);
const spaces = { model, ops, render, captions, transcript, catalog, capcut, analysis, media, python, exporter, flows: createFlows(host, media, python, exporter) };
const signal = { get aborted() { return __cancelled(); }, addEventListener() {}, removeEventListener() {} };

globalThis.cut = {
  // Call `space.fn` with JSON arguments; returns JSON. Jobs get progress and
  // cancel hooks added to their options (the last argument).
  async call(name, json, job) {
    const [space, fn] = name.split(".");
    const f = spaces[space]?.[fn];
    if (typeof f !== "function") throw new Error(`No engine function ${name}`);
    const args = JSON.parse(json);
    if (job) {
      const i = Math.max(0, args.length - 1);
      args[i] = { ...(args[i] ?? {}), onProgress: (p) => __progress(p), signal };
    }
    const result = await f(...args);
    return JSON.stringify(result === undefined ? null : result);
  },
  // A constant such as catalog.FILTERS, as JSON.
  value(name) {
    const [space, key] = name.split(".");
    return JSON.stringify(spaces[space]?.[key] ?? null);
  },
};
