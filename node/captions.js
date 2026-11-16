// Local AI jobs for Node (MCP server, tests): speech to text and voice /
// effects / music separation. The logic is in engine/python.js.

import { createPython } from "../engine/python.js";
import { nodeHost } from "./host.js";
import { media } from "./media.js";

export const python = createPython(nodeHost, media);
export const { transcribe, separateStems } = python;
