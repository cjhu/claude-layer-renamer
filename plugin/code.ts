/// <reference types="@figma/plugin-typings" />

// ─── Types shared between plugin and bridge ───────────────────────────────────
interface RenameCommand {
  action: "rename";
  nodeId: string;
  newName: string;
}

interface ReadTreeCommand {
  action: "readTree";
}

interface LayerInfo {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  children: LayerInfo[];
}

type Command = RenameCommand | ReadTreeCommand;

// ─── Show the plugin UI (ui.html) ─────────────────────────────────────────────
figma.showUI(__html__, { width: 300, height: 160, title: "Claude Layer Renamer" });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Recursively build a lightweight layer tree */
function buildTree(node: SceneNode, parentId: string | null = null): LayerInfo {
  const info: LayerInfo = {
    id: node.id,
    name: node.name,
    type: node.type,
    parentId,
    children: [],
  };

  if ("children" in node) {
    info.children = (node as ChildrenMixin).children.map((child) =>
      buildTree(child as SceneNode, node.id)
    );
  }

  return info;
}

/** Find a node by ID anywhere in the document */
function findNode(id: string): SceneNode | null {
  return figma.getNodeById(id) as SceneNode | null;
}

// ─── Message handler (receives commands from ui.html → bridge) ────────────────
figma.ui.onmessage = (msg: Command) => {
  if (msg.action === "readTree") {
    // Return the full layer tree of the current page
    const tree = figma.currentPage.children.map((n) => buildTree(n as SceneNode));
    figma.ui.postMessage({ action: "treeResult", tree });
    return;
  }

  if (msg.action === "rename") {
    const node = findNode(msg.nodeId);
    if (!node) {
      figma.ui.postMessage({ action: "error", message: `Node ${msg.nodeId} not found` });
      return;
    }
    const oldName = node.name;
    node.name = msg.newName;
    figma.notify(`✅ "${oldName}" → "${msg.newName}"`);
    figma.ui.postMessage({ action: "renamed", nodeId: msg.nodeId, newName: msg.newName });
    return;
  }
};