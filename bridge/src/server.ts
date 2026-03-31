import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LayerInfo {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  children: LayerInfo[];
}

interface PluginMessage {
  action: string;
  [key: string]: unknown;
}

// ─── WebSocket server (talks to Figma plugin) ─────────────────────────────────

const wss = new WebSocketServer({ port: 9001 });
let pluginSocket: WebSocket | null = null;

wss.on("connection", (ws) => {
  pluginSocket = ws;
  console.error("✅ Figma plugin connected");

  ws.on("close", () => {
    pluginSocket = null;
    console.error("⚠️  Figma plugin disconnected");
  });
});

console.error("🔌 WebSocket server listening on ws://localhost:9001");

// ─── Helper: send a command to the plugin and wait for a response ─────────────

function sendToPlugin(command: PluginMessage): Promise<PluginMessage> {
  return new Promise((resolve, reject) => {
    if (!pluginSocket || pluginSocket.readyState !== WebSocket.OPEN) {
      return reject(new Error("Figma plugin is not connected. Open the plugin in Figma first."));
    }

    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for Figma plugin response."));
    }, 10_000);

    pluginSocket.once("message", (data) => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data.toString()) as PluginMessage);
      } catch {
        reject(new Error("Invalid JSON from plugin: " + data));
      }
    });

    pluginSocket.send(JSON.stringify(command));
  });
}

// ─── MCP server (talks to Claude Code) ───────────────────────────────────────

const mcp = new McpServer({
  name: "figma-layer-renamer",
  version: "1.0.0",
});

// Tool 1: read the full layer tree from the current Figma page
mcp.tool(
  "read_layer_tree",
  "Read the complete layer tree of the currently open Figma page. Returns a nested JSON structure with each layer's id, name, and type. Always call this before renaming so you know the node IDs.",
  {},
  async () => {
    const response = await sendToPlugin({ action: "readTree" });
    const tree = (response as { action: string; tree: LayerInfo[] }).tree;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(tree, null, 2),
        },
      ],
    };
  }
);

// Tool 2: rename a single layer by node ID
mcp.tool(
  "rename_layer",
  "Rename a single layer in Figma by its node ID. Use read_layer_tree first to get node IDs. Choose names that are semantic and descriptive — reflect the layer's visual role (e.g. 'hero/title', 'nav/cta-button', 'card/thumbnail'). Avoid generic names like 'Frame 1' or 'Rectangle 3'.",
  {
    nodeId: z.string().describe("The Figma node ID to rename (e.g. '12:34')"),
    newName: z.string().describe("The new name for the layer"),
  },
  async ({ nodeId, newName }) => {
    const response = await sendToPlugin({ action: "rename", nodeId, newName });
    return {
      content: [
        {
          type: "text",
          text:
            response.action === "renamed"
              ? `✅ Renamed node ${nodeId} to "${newName}"`
              : `❌ Error: ${response.message}`,
        },
      ],
    };
  }
);

// Tool 3: rename multiple layers in one shot
mcp.tool(
  "rename_layers_bulk",
  "Rename multiple Figma layers at once. Use this after read_layer_tree to rename many layers efficiently. Apply consistent, semantic naming across the file.",
  {
    renames: z
      .array(
        z.object({
          nodeId: z.string().describe("The Figma node ID"),
          newName: z.string().describe("The new name for this layer"),
        })
      )
      .describe("List of { nodeId, newName } pairs"),
  },
  async ({ renames }) => {
    const results: string[] = [];

    for (const { nodeId, newName } of renames) {
      try {
        const response = await sendToPlugin({ action: "rename", nodeId, newName });
        results.push(
          response.action === "renamed"
            ? `✅ ${nodeId} → "${newName}"`
            : `❌ ${nodeId}: ${response.message}`
        );
      } catch (err) {
        results.push(`❌ ${nodeId}: ${(err as Error).message}`);
      }
    }

    return {
      content: [{ type: "text", text: results.join("\n") }],
    };
  }
);

// ─── Start MCP over stdio (how Claude Code talks to it) ───────────────────────

const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error("🤖 MCP server ready");