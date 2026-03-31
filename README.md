# Claude Layer Renamer

A Claude Code MCP skill that renames layers in Figma using AI.

Claude reads your Figma layer tree and renames layers to be semantic and descriptive — no more "Frame 47" or "Rectangle 3".

---

## How it works

```
Claude Code ↔ Bridge Server (MCP + WebSocket) ↔ Figma Plugin ↔ Your Figma file
```

---

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v18+
- [Figma Desktop](https://www.figma.com/downloads/)
- [Claude Code](https://claude.ai/code)

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/claude-layer-renamer.git
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

> Replace the path with the actual absolute path on your machine. Run `pwd` inside the `bridge` folder to get it.

---

## Usage

Every session:

1. Start the bridge server:
```bash
cd bridge && node dist/server.js
```
2. Open Figma and run **Plugins → Development → Claude Layer Renamer**
3. Wait for the plugin to show **"✅ Connected"**
4. In Claude Code, ask:

```
Rename all the layers in my Figma file to be more semantic and descriptive
```

---

## Available MCP Tools

| Tool | Description |
|---|---|
| `read_layer_tree` | Reads the full layer tree of the current Figma page |
| `rename_layer` | Renames a single layer by node ID |
| `rename_layers_bulk` | Renames multiple layers at once |

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