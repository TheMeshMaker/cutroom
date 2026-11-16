// Renders for Node (MCP server, tests); the logic is in engine/exporter.js.

import { createExporter } from "../engine/exporter.js";
import { nodeHost } from "./host.js";

export const { availableEncoders, renderProject, renderFrame, renderAudio } = createExporter(nodeHost);
