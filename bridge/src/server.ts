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

// ── Tool 1: read the full layer tree ─────────────────────────────────────────
mcp.tool(
  "read_layer_tree",
  "Read the complete layer tree of the currently open Figma page. Returns a nested JSON structure with each layer's id, name, type, text content, and component name. Always call this before renaming so you know the node IDs.",
  {},
  async () => {
    const response = await sendToPlugin({ action: "readTree" });
    const tree = (response as { action: string; tree: LayerInfo[] }).tree;
    return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
  }
);

// ── Tool 2: rename a single layer ─────────────────────────────────────────────
mcp.tool(
  "rename_layer",
  "Rename a single layer in Figma by its node ID. Use read_layer_tree first to get node IDs. Choose names that are semantic and descriptive.",
  {
    nodeId: z.string().describe("The Figma node ID to rename (e.g. '12:34')"),
    newName: z.string().describe("The new name for the layer"),
  },
  async ({ nodeId, newName }) => {
    const response = await sendToPlugin({ action: "rename", nodeId, newName });
    return {
      content: [{
        type: "text",
        text: response.action === "renamed"
          ? `✅ Renamed node ${nodeId} to "${newName}"`
          : `❌ Error: ${response.message}`,
      }],
    };
  }
);

// ── Tool 3: rename multiple layers at once ────────────────────────────────────
mcp.tool(
  "rename_layers_bulk",
  "Rename multiple Figma layers at once. Use this after read_layer_tree to rename many layers efficiently.",
  {
    renames: z.array(z.object({
      nodeId: z.string().describe("The Figma node ID"),
      newName: z.string().describe("The new name for this layer"),
    })).describe("List of { nodeId, newName } pairs"),
  },
  async ({ renames }) => {
    const results: string[] = [];
    for (const { nodeId, newName } of renames) {
      try {
        const response = await sendToPlugin({ action: "rename", nodeId, newName });
        results.push(response.action === "renamed"
          ? `✅ ${nodeId} → "${newName}"`
          : `❌ ${nodeId}: ${response.message}`
        );
      } catch (err) {
        results.push(`❌ ${nodeId}: ${(err as Error).message}`);
      }
    }
    return { content: [{ type: "text", text: results.join("\n") }] };
  }
);

// ── Tool 4: get all number variables from the design system ───────────────────
mcp.tool(
  "get_design_variables",
  "Fetch all NUMBER variables defined in the Figma file's local variable collections (e.g. spacing, corner radius tokens). Returns each variable's id, name, resolvedValue, and collectionName.",
  {},
  async () => {
    const response = await sendToPlugin({ action: "getVariables" });
    const variables = (response as { action: string; variables: unknown[] }).variables;
    return { content: [{ type: "text", text: JSON.stringify(variables, null, 2) }] };
  }
);

// ── Tool 5: audit the file for hardcoded values ───────────────────────────────
mcp.tool(
  "audit_hardcoded_values",
  "Walk every node on the current Figma page and find corner radius or spacing values that are hardcoded but close to an existing design system variable. Use tolerance to control how many px off a value can be.",
  {
    tolerance: z.number().default(2).describe("Max px difference allowed when matching a hardcoded value to a variable (default: 2)"),
  },
  async ({ tolerance }) => {
    const response = await sendToPlugin({ action: "auditNodes", tolerance });
    const results = (response as { action: string; results: unknown[] }).results;
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ── Tool 6: apply variable bindings ──────────────────────────────────────────
mcp.tool(
  "apply_variable_bindings",
  "Bind design system variables to node fields in Figma, replacing hardcoded values. Use the output of audit_hardcoded_values to build the bindings list.",
  {
    bindings: z.array(z.object({
      nodeId: z.string().describe("Figma node ID"),
      field: z.string().describe("The field to bind e.g. topLeftRadius, paddingLeft, itemSpacing"),
      variableId: z.string().describe("The variable ID to bind to this field"),
    })).describe("List of { nodeId, field, variableId } bindings to apply"),
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

// ── Tool 7: get all prototype connections ─────────────────────────────────────
mcp.tool(
  "get_prototype_connections",
  "Read all prototype connections on the current Figma page. Returns every reaction found on every node — including the source node, trigger type (ON_CLICK, MOUSE_ENTER, ON_HOVER, etc.), destination frame, and animation. Use this to understand the intended user flow and identify hover states and overlays.",
  {},
  async () => {
    const response = await sendToPlugin({ action: "getPrototypeConnections" });
    const connections = (response as { action: string; results: unknown[] }).results;
    return { content: [{ type: "text", text: JSON.stringify(connections, null, 2) }] };
  }
);

// ── Tool 8: create a fresh spec page ─────────────────────────────────────────
mcp.tool(
  "create_spec_page",
  "Create a new page in the Figma file for the design spec. If a page with that name already exists it will be replaced. Returns the new page's ID which you must pass to copy_frame_to_spec_page and create_spec_annotation.",
  {
    pageName: z.string().default("Design Spec").describe("Name for the new spec page"),
  },
  async ({ pageName }) => {
    const response = await sendToPlugin({ action: "createSpecPage", pageName });
    const r = response as { action: string; pageId: string };
    return { content: [{ type: "text", text: `Spec page created. pageId: ${r.pageId}` }] };
  }
);

// ── Tool 9: copy a frame onto the spec page ───────────────────────────────────
mcp.tool(
  "copy_frame_to_spec_page",
  "Copy a screen frame from the prototype page onto the spec page at a given x/y position. Use this to place the main screen and each of its states (hover, overlay) side by side. Returns the cloned node ID.",
  {
    sourceNodeId: z.string().describe("Node ID of the frame to copy"),
    targetPageId: z.string().describe("Page ID of the spec page (from create_spec_page)"),
    x: z.number().describe("X position on the spec page"),
    y: z.number().describe("Y position on the spec page"),
  },
  async ({ sourceNodeId, targetPageId, x, y }) => {
    const response = await sendToPlugin({ action: "copyFrameToPage", sourceNodeId, targetPageId, x, y });
    const r = response as { action: string; nodeId: string; name: string };
    return { content: [{ type: "text", text: `Copied "${r.name}" to spec page. nodeId: ${r.nodeId}` }] };
  }
);

// ── Tool 10: create an annotation frame below a screen ────────────────────────
mcp.tool(
  "create_spec_annotation",
  "Create an annotation frame on the spec page below a screen. Include the interaction table, states list, and dev notes. Position it directly below the screen frame — use the screen's y + height + 24 as the annotation y value.",
  {
    targetPageId: z.string().describe("Page ID of the spec page"),
    x: z.number().describe("X position — should match the screen frame's x"),
    y: z.number().describe("Y position — screen y + screen height + 24"),
    width: z.number().describe("Width — should match the screen frame's width"),
    screenName: z.string().describe("Name of the screen being annotated"),
    interactions: z.array(z.object({
      element: z.string(),
      trigger: z.string(),
      result: z.string(),
    })).describe("Interaction table rows"),
    states: z.array(z.object({
      name: z.string(),
      description: z.string(),
    })).describe("States for this screen e.g. default, hover, loading"),
    devNotes: z.array(z.string()).describe("Developer notes and edge cases"),
  },
  async (args) => {
    const response = await sendToPlugin({ action: "createAnnotation", ...args });
    const r = response as { action: string; screenName: string };
    return { content: [{ type: "text", text: `Annotation created for "${r.screenName}"` }] };
  }
);

// ─── Start MCP over stdio (how Claude Code talks to it) ───────────────────────

const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error("🤖 MCP server ready");