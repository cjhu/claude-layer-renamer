/// <reference types="@figma/plugin-typings" />

// ─── Types ────────────────────────────────────────────────────────────────────

interface RenameCommand { action: "rename"; nodeId: string; newName: string; }
interface ReadTreeCommand { action: "readTree"; }
interface GetVariablesCommand { action: "getVariables"; }
interface AuditNodesCommand { action: "auditNodes"; tolerance: number; }
interface GetPrototypeConnectionsCommand { action: "getPrototypeConnections"; }
interface CreateSpecPageCommand { action: "createSpecPage"; pageName: string; }
interface CopyFrameToPageCommand { action: "copyFrameToPage"; sourceNodeId: string; targetPageId: string; x: number; y: number; }
interface CreateAnnotationCommand {
  action: "createAnnotation";
  targetPageId: string;
  x: number;
  y: number;
  width: number;
  screenName: string;
  interactions: { element: string; trigger: string; result: string }[];
  states: { name: string; description: string }[];
  devNotes: string[];
}
interface ApplyVariableBindingsCommand {
  action: "applyVariableBindings";
  bindings: VariableBinding[];
}
interface VariableBinding {
  nodeId: string;
  field: VariableBindableNodeField;
  variableId: string;
}
interface LayerInfo {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  children: LayerInfo[];
  texts: string[];
  componentName?: string;
}
interface VariableInfo {
  id: string;
  name: string;
  resolvedValue: number;
  collectionName: string;
}
interface AuditResult {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  field: string;
  currentValue: number;
  suggestedVariableId: string;
  suggestedVariableName: string;
  suggestedVariableValue: number;
  delta: number;
}
interface PrototypeConnection {
  sourceNodeId: string;
  sourceNodeName: string;
  sourceNodeType: string;
  trigger: string;
  destinationNodeId: string | null;
  destinationNodeName: string | null;
  animation: string | null;
}

type Command =
  | RenameCommand
  | ReadTreeCommand
  | GetVariablesCommand
  | AuditNodesCommand
  | ApplyVariableBindingsCommand
  | GetPrototypeConnectionsCommand
  | CreateSpecPageCommand
  | CopyFrameToPageCommand
  | CreateAnnotationCommand;

// ─── Show the plugin UI ───────────────────────────────────────────────────────

figma.showUI(__html__, { width: 300, height: 160, title: "Claude Layer Renamer" });

// ─── Layer tree helpers ───────────────────────────────────────────────────────

function collectTexts(node: SceneNode): string[] {
  const texts: string[] = [];
  if (node.type === "TEXT") {
    const chars = (node as TextNode).characters.trim();
    if (chars) texts.push(chars);
  }
  if ("children" in node) {
    for (const child of (node as ChildrenMixin).children)
      texts.push(...collectTexts(child as SceneNode));
  }
  return texts;
}

function buildTree(node: SceneNode, parentId: string | null = null): LayerInfo {
  const info: LayerInfo = {
    id: node.id, name: node.name, type: node.type,
    parentId, texts: collectTexts(node), children: [],
  };
  if (node.type === "INSTANCE") {
    const main = (node as InstanceNode).mainComponent;
    if (main) info.componentName = main.name;
  }
  if ("children" in node) {
    info.children = (node as ChildrenMixin).children.map(
      child => buildTree(child as SceneNode, node.id)
    );
  }
  return info;
}

function findNode(id: string): SceneNode | null {
  return figma.getNodeById(id) as SceneNode | null;
}

// ─── Variable helpers ─────────────────────────────────────────────────────────

const RADIUS_FIELDS: VariableBindableNodeField[] = [
  "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
];
const SPACING_FIELDS: VariableBindableNodeField[] = [
  "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "counterAxisSpacing",
];

async function getNumberVariables(): Promise<VariableInfo[]> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const results: VariableInfo[] = [];
  for (const col of collections) {
    for (const varId of col.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(varId);
      if (!v || v.resolvedType !== "FLOAT") continue;
      const value = v.valuesByMode[col.defaultModeId];
      if (typeof value === "number")
        results.push({ id: v.id, name: v.name, resolvedValue: value, collectionName: col.name });
    }
  }
  return results;
}

function findClosestVariable(value: number, variables: VariableInfo[], tolerance: number): VariableInfo | null {
  let closest: VariableInfo | null = null;
  let minDelta = Infinity;
  for (const v of variables) {
    const delta = Math.abs(v.resolvedValue - value);
    if (delta <= tolerance && delta < minDelta) { minDelta = delta; closest = v; }
  }
  return closest;
}

async function auditNode(node: SceneNode, variables: VariableInfo[], tolerance: number, results: AuditResult[]): Promise<void> {
  const n = node as SceneNode & Record<string, unknown>;
  if ("topLeftRadius" in node) {
    for (const field of RADIUS_FIELDS) {
      const bound = (node.boundVariables as Record<string, unknown>)?.[field];
      if (bound) continue;
      const value = n[field] as number;
      if (typeof value !== "number" || value === 0) continue;
      const match = findClosestVariable(value, variables, tolerance);
      if (match) results.push({
        nodeId: node.id, nodeName: node.name, nodeType: node.type,
        field, currentValue: value,
        suggestedVariableId: match.id, suggestedVariableName: match.name,
        suggestedVariableValue: match.resolvedValue,
        delta: Math.abs(match.resolvedValue - value),
      });
    }
  }
  if ("paddingLeft" in node && (node as FrameNode).layoutMode !== "NONE") {
    for (const field of SPACING_FIELDS) {
      const bound = (node.boundVariables as Record<string, unknown>)?.[field];
      if (bound) continue;
      const value = n[field] as number;
      if (typeof value !== "number" || value === 0) continue;
      const match = findClosestVariable(value, variables, tolerance);
      if (match) results.push({
        nodeId: node.id, nodeName: node.name, nodeType: node.type,
        field, currentValue: value,
        suggestedVariableId: match.id, suggestedVariableName: match.name,
        suggestedVariableValue: match.resolvedValue,
        delta: Math.abs(match.resolvedValue - value),
      });
    }
  }
  if ("children" in node) {
    for (const child of (node as ChildrenMixin).children)
      await auditNode(child as SceneNode, variables, tolerance, results);
  }
}

// ─── Spec page helpers ────────────────────────────────────────────────────────

function createAnnotationFrame(
  page: PageNode, x: number, y: number, width: number, screenName: string,
  interactions: { element: string; trigger: string; result: string }[],
  states: { name: string; description: string }[],
  devNotes: string[]
): void {
  const PADDING = 24;
  const SECTION_GAP = 16;
  const frame = figma.createFrame();
  frame.name = `annotation/${screenName}`;
  frame.x = x; frame.y = y;
  frame.resize(width, 100);
  frame.fills = [{ type: "SOLID", color: { r: 0.97, g: 0.97, b: 1 } }];
  frame.cornerRadius = 8;
  frame.layoutMode = "VERTICAL";
  frame.paddingTop = PADDING; frame.paddingBottom = PADDING;
  frame.paddingLeft = PADDING; frame.paddingRight = PADDING;
  frame.itemSpacing = SECTION_GAP;
  frame.primaryAxisSizingMode = "AUTO";
  frame.counterAxisSizingMode = "FIXED";
  page.appendChild(frame);

  const addText = (content: string, size: number, bold: boolean, color = { r: 0.1, g: 0.1, b: 0.1 }) => {
    const t = figma.createText();
    t.characters = content;
    t.fontSize = size;
    t.fontName = { family: "Inter", style: bold ? "Semi Bold" : "Regular" };
    t.fills = [{ type: "SOLID", color }];
    t.textAutoResize = "HEIGHT";
    t.resize(width - PADDING * 2, 20);
    frame.appendChild(t);
  };

  addText(screenName, 14, true, { r: 0.2, g: 0.2, b: 0.8 });
  if (interactions.length > 0) {
    addText("Interactions", 12, true);
    for (const i of interactions)
      addText(`• ${i.element}  →  [${i.trigger}]  →  ${i.result}`, 11, false);
  }
  if (states.length > 0) {
    addText("States", 12, true);
    for (const s of states)
      addText(`• ${s.name}: ${s.description}`, 11, false);
  }
  if (devNotes.length > 0) {
    addText("Dev Notes", 12, true, { r: 0.7, g: 0.4, b: 0 });
    for (const n of devNotes)
      addText(`• ${n}`, 11, false, { r: 0.5, g: 0.3, b: 0 });
  }
}

// ─── Prototype helpers ────────────────────────────────────────────────────────

function collectPrototypeConnections(node: SceneNode, results: PrototypeConnection[]): void {
  if ("reactions" in node) {
    for (const reaction of (node as ReactionMixin).reactions) {
      if (!reaction.action) continue;
      let destinationId: string | null = null;
      let destinationName: string | null = null;
      if (reaction.action.type === "NODE" && reaction.action.destinationId) {
        destinationId = reaction.action.destinationId;
        const destNode = figma.getNodeById(destinationId);
        destinationName = destNode ? destNode.name : null;
      }
      results.push({
        sourceNodeId: node.id,
        sourceNodeName: node.name,
        sourceNodeType: node.type,
        trigger: reaction.trigger?.type ?? "UNKNOWN",
        destinationNodeId: destinationId,
        destinationNodeName: destinationName,
        animation: reaction.action.type === "NODE"
          ? (reaction.action.transition?.type ?? null)
          : null,
      });
    }
  }
  if ("children" in node) {
    for (const child of (node as ChildrenMixin).children)
      collectPrototypeConnections(child as SceneNode, results);
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: Command) => {

  if (msg.action === "readTree") {
    const tree = figma.currentPage.children.map(n => buildTree(n as SceneNode));
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

  if (msg.action === "getVariables") {
    const variables = await getNumberVariables();
    figma.ui.postMessage({ action: "variablesResult", variables });
    return;
  }

  if (msg.action === "auditNodes") {
    const variables = await getNumberVariables();
    const results: AuditResult[] = [];
    for (const node of figma.currentPage.children)
      await auditNode(node as SceneNode, variables, msg.tolerance, results);
    figma.ui.postMessage({ action: "auditResult", results });
    return;
  }

  if (msg.action === "applyVariableBindings") {
    const applied: string[] = [];
    const failed: string[] = [];
    for (const { nodeId, field, variableId } of msg.bindings) {
      const node = figma.getNodeById(nodeId) as SceneNode;
      if (!node) { failed.push(`${nodeId}: node not found`); continue; }
      const variable = await figma.variables.getVariableByIdAsync(variableId);
      if (!variable) { failed.push(`${nodeId}: variable not found`); continue; }
      try {
        (node as SceneNode & { setBoundVariable: Function }).setBoundVariable(field, variable);
        applied.push(`${node.name} → ${field}: ${variable.name}`);
      } catch (e) {
        failed.push(`${nodeId} ${field}: ${(e as Error).message}`);
      }
    }
    figma.notify(`✅ ${applied.length} bindings applied${failed.length ? `, ❌ ${failed.length} failed` : ""}`);
    figma.ui.postMessage({ action: "bindingsApplied", applied, failed });
    return;
  }

  if (msg.action === "getPrototypeConnections") {
    const results: PrototypeConnection[] = [];
    for (const node of figma.currentPage.children)
      collectPrototypeConnections(node as SceneNode, results);
    figma.ui.postMessage({ action: "prototypeConnectionsResult", results });
    return;
  }

  if (msg.action === "createSpecPage") {
    const existing = figma.root.children.find(p => p.name === msg.pageName);
    if (existing) existing.remove();
    const page = figma.createPage();
    page.name = msg.pageName;
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
    figma.ui.postMessage({ action: "specPageCreated", pageId: page.id });
    return;
  }

  if (msg.action === "copyFrameToPage") {
    const sourceNode = figma.getNodeById(msg.sourceNodeId) as SceneNode;
    if (!sourceNode) {
      figma.ui.postMessage({ action: "error", message: `Node ${msg.sourceNodeId} not found` });
      return;
    }
    const targetPage = figma.getNodeById(msg.targetPageId) as PageNode;
    if (!targetPage) {
      figma.ui.postMessage({ action: "error", message: `Page ${msg.targetPageId} not found` });
      return;
    }
    const clone = (sourceNode as FrameNode).clone();
    targetPage.appendChild(clone);
    clone.x = msg.x;
    clone.y = msg.y;
    figma.ui.postMessage({ action: "frameCopied", nodeId: clone.id, name: clone.name });
    return;
  }

  if (msg.action === "createAnnotation") {
    const targetPage = figma.getNodeById(msg.targetPageId) as PageNode;
    if (!targetPage) {
      figma.ui.postMessage({ action: "error", message: `Page ${msg.targetPageId} not found` });
      return;
    }
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
    createAnnotationFrame(
      targetPage, msg.x, msg.y, msg.width,
      msg.screenName, msg.interactions, msg.states, msg.devNotes
    );
    figma.ui.postMessage({ action: "annotationCreated", screenName: msg.screenName });
    return;
  }

};