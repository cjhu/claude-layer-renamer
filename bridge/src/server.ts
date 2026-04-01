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
  "Read the complete layer tree of the currently open Figma page. Returns each layer's id, name, type, and — importantly — all text content found inside it (the 'texts' field) plus the main component name for instances ('componentName'). Use the texts and componentName fields to understand what a layer actually represents, even if its name is stale or duplicated from another layer.",
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

// Tool 4: get all number variables from the design system
mcp.tool(
  "get_design_variables",
  "Fetch all NUMBER variables defined in the Figma file's local variable collections (e.g. spacing, corner radius tokens). Returns each variable's id, name, resolvedValue, and collectionName. Call this first so you know what variables are available to bind to.",
  {},
  async () => {
    const response = await sendToPlugin({ action: "getVariables" });
    const variables = (response as { action: string; variables: unknown[] }).variables;
    return {
      content: [{ type: "text", text: JSON.stringify(variables, null, 2) }],
    };
  }
);

// Tool 5: audit the file for hardcoded values that should be variables
mcp.tool(
  "audit_hardcoded_values",
  "Walk every node on the current Figma page and find corner radius or spacing values that are hardcoded (not bound to a variable) but are close to an existing design system variable. Returns a list of suggestions with nodeId, field, currentValue, and the closest matching variable. Use tolerance to control how many px off a value can be and still get snapped (e.g. tolerance=2 means 8px snaps to a 9px variable).",
  {
    tolerance: z.number().default(2).describe("Max px difference allowed when matching a hardcoded value to a variable (default: 2)"),
  },
  async ({ tolerance }) => {
    const response = await sendToPlugin({ action: "auditNodes", tolerance });
    const results = (response as { action: string; results: unknown[] }).results;
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

// Tool 6: apply variable bindings to nodes
mcp.tool(
  "apply_variable_bindings",
  "Bind design system variables to node fields in Figma, replacing hardcoded values. Use the output of audit_hardcoded_values to build the bindings list. Each binding needs a nodeId, the field to bind (e.g. 'topLeftRadius', 'paddingLeft'), and the variableId to bind to.",
  {
    bindings: z.array(
      z.object({
        nodeId: z.string().describe("Figma node ID"),
        field: z.string().describe("The field to bind e.g. topLeftRadius, paddingLeft, itemSpacing"),
        variableId: z.string().describe("The variable ID to bind to this field"),
      })
    ).describe("List of { nodeId, field, variableId } bindings to apply"),
  },
  async ({ bindings }) => {
    const response = await sendToPlugin({ action: "applyVariableBindings", bindings });
    const r = response as { action: string; applied: string[]; failed: string[] };
    return {
      content: [{
        type: "text",
        text: `Applied: ${r.applied.length}\nFailed: ${r.failed.length}\n\n${[...r.applied, ...r.failed.map(f => "❌ " + f)].join("\n")}`,
      }],
    };
  }
);


const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error("🤖 MCP server ready");