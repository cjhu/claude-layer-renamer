# Claude Figma MCP

An MCP server that gives Claude Code direct read and write access to your Figma files. Rename layers, bind design system variables, and generate design specs — all from Claude Code.

---

## What it can do

| Use case | Tools used |
|---|---|
| **Rename layers** | Reads layer content and text to rename stale, duplicate, or default-named layers |
| **Fix design tokens** | Finds hardcoded corner radius and spacing values and binds them to design system variables |
| **Generate design specs** | Reads your prototype connections, groups screens with their states, and builds a spec page in Figma with interaction tables and dev notes |

---

## How it works

```
Claude Code ↔ Bridge Server (MCP + WebSocket) ↔ Figma Plugin ↔ Your Figma file
```

---

## Prerequisites
- [Node.js](https://nodejs.org/) v18+
- [Figma Desktop](https://www.figma.com/downloads/)
- [Claude Code](https://claude.ai/code)

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/cjhu/claude-layer-renamer.git
cd claude-layer-renamer
```

### 2. Build the bridge server

```bash
cd bridge
npm install
npm run build
```

### 3. Build the Figma plugin

```bash
cd ../plugin
npm install
npm run build
```

### 4. Load the plugin in Figma

1. Open Figma Desktop
2. Go to **Plugins → Development → Import plugin from manifest**
3. Select `plugin/manifest.json`

### 5. Register the MCP with Claude Code

Add this to your `~/.claude.json` under `mcpServers`:

```json
"figma-layer-renamer": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/claude-layer-renamer/bridge/dist/server.js"]
}
```

> Run `pwd` inside the `bridge` folder to get your absolute path.

---

## Usage

Every session:

1. Start the bridge server:
```bash
cd bridge && node dist/server.js
```
2. Open Figma and run **Plugins → Development → Claude Layer Renamer**
3. Wait for **✅ Connected**
4. Open Claude Code and use the prompts below

---

## Prompts

### Rename layers
```
Use the figma-layer-renamer read_layer_tree and rename_layers_bulk tools 
to rename every layer in my Figma file. Process one top-level frame at a 
time. Use the text content inside each layer to figure out what it 
represents — even if the layer name is stale or duplicated.
```

### Fix design tokens
```
Use the figma-layer-renamer MCP tools to fix hardcoded values in my Figma file.
1. Call get_design_variables to see available variables
2. Call audit_hardcoded_values with tolerance=2
3. Show me a summary before making any changes
4. Ask me to confirm before calling apply_variable_bindings — flag anything 
   where the delta is greater than 1px
```

### Generate a design spec
```
Use only the figma-layer-renamer MCP tools to generate a design spec from 
this Figma prototype. Read the layer tree and prototype connections, group 
screens by flow with hover/overlay states beside each screen, then build a 
spec page in Figma with interaction tables and dev notes as annotations.
```

---

## MCP Tools

### Layer Renaming
| Tool | Description |
|---|---|
| `read_layer_tree` | Reads the full layer tree including text content and component names |
| `rename_layer` | Renames a single layer by node ID |
| `rename_layers_bulk` | Renames multiple layers at once |

### Design Tokens
| Tool | Description |
|---|---|
| `get_design_variables` | Fetches all number variables from your design system |
| `audit_hardcoded_values` | Finds nodes with hardcoded values that should be variables |
| `apply_variable_bindings` | Binds design system variables to nodes, replacing hardcoded values |

### Design Spec
| Tool | Description |
|---|---|
| `get_prototype_connections` | Reads all prototype reactions to map flows and identify states |
| `create_spec_page` | Creates a fresh spec page in the Figma file |
| `copy_frame_to_spec_page` | Copies a screen onto the spec page at a given position |
| `create_spec_annotation` | Creates an annotation panel below a screen with interactions, states, and dev notes |

---

## Project Structure

```
claude-layer-renamer/
├── plugin/          # Figma plugin (runs inside Figma)
│   ├── code.ts
│   ├── ui.html
│   └── manifest.json
└── bridge/          # MCP + WebSocket server (runs on your machine)
    └── src/
        └── server.ts
```

---

## Getting updates

```bash
git pull
cd plugin && npm install && npm run build
cd ../bridge && npm install && npm run build
```

Then restart the bridge server and reopen the plugin in Figma.