// Dev loop: Vite for the renderer (hot reload) + Electron pointed at it.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";

const server = await createServer({ configFile: new URL("../vite.config.js", import.meta.url).pathname.replace(/^\/(\w:)/, "$1") });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`renderer at ${url}`);

const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, ["."], { stdio: "inherit", env: { ...process.env, CUTROOM_DEV_URL: url } });
child.on("close", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
