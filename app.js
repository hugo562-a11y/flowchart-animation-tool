"use strict";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const sampleText = `1.讀取 SpaceMouse 六軸
2.確認游標所在區域
3.畫布區
\t3.1優先允許 Z：縮放畫布
4.時間軸區
\t4.1優先允許 rx / ry / rz
5.中間安全帶
\t5.1只允許 x / y 移動滑鼠`;

const templates = {
  pink: { fill1: "#fff2fb", fill2: "#f425cb", stroke: "#101185", textColor: "#ffffff" },
  green: { fill1: "#f1fff0", fill2: "#1dcc18", stroke: "#101185", textColor: "#ffffff" },
  blue: { fill1: "#edf8ff", fill2: "#438ddb", stroke: "#101185", textColor: "#ffffff" },
  yellow: { fill1: "#fffdf1", fill2: "#ffd735", stroke: "#101185", textColor: "#ffffff" },
  simple: { fill1: "#303b49", fill2: "#303b49", stroke: "#76879b", textColor: "#ffffff" }
};
const defaultState = () => ({
  sourceText: "",
  nodes: [], lines: [], selectedNodes: [], selectedLine: null,
  canvas: { width: 1920, height: 1080, backgroundType: "solid", color1: "#ffffff", color2: "#c9e7ff", image: "" },
  showNumbers: false, zoom: 0.55, playhead: 999, playing: false,
  ui: { leftWidth: 270, rightWidth: 270, timelineHeight: 225, canvasPanX: 0, canvasPanY: 0 },
  timelineOrder: [], selectedTimelineItems: [],
  media: null, subtitles: []
});
let state = defaultState();
let undoStack = [], redoStack = [], drag = null, linkMode = false, linkSourceId = null, linkPreview = null, selectionRect = null, timelineSelection = null, selectedControlPoint = null, spacePressed = false, playStartedAt = 0, playBase = 0, shuttleSpeed = 0, toastTimer, uiResizeFrame, exportingVideo = false;
const STORAGE_KEY = "flow-animation-editor-v1";
const LAYOUT_STORAGE_KEY = "flow-animation-editor-layout-v1";
let TIMELINE_PX_PER_SECOND = 90;
const fallbackFonts = ["Microsoft JhengHei", "Microsoft JhengHei UI", "Arial", "Calibri", "Consolas", "Segoe UI", "Times New Roman", "Verdana"];

function id(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function esc(text) { return String(text).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
const { parseSource, naturalNumberParts, compareNumbers } = FlowParser;
function showToast(message) {
  $("toast").textContent = message; $("toast").classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 3500);
}
function populateFonts() {
  const fonts = [...new Set([...(globalThis.INSTALLED_FONTS || []), ...fallbackFonts])].sort((a, b) => a.localeCompare(b));
  $("nodeFont").innerHTML = fonts.map((font) => `<option value="${esc(font)}" style="font-family:${esc(font)}">${esc(font)}</option>`).join("");
}
function pushUndo() {
  undoStack.push(clone(state)); if (undoStack.length > 80) undoStack.shift();
  redoStack = [];
}
function undo() { if (!undoStack.length) return; redoStack.push(clone(state)); state = undoStack.pop(); renderAll(); saveLocal(); }
function redo() { if (!redoStack.length) return; undoStack.push(clone(state)); state = redoStack.pop(); renderAll(); saveLocal(); }
function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  $("saveState").textContent = "已自動保存";
}
function commit(mutator) { pushUndo(); mutator(); renderAll(); saveLocal(); }

function makeNode(parsed, order) {
  const t = templates[["pink", "green", "blue", "yellow"][order % 4]];
  const size = estimateNodeSize(parsed.text);
  return {
    id: id("node"), number: parsed.number, text: parsed.text, x: 0, y: 0, width: size.width, height: size.height,
    radius: size.height / 2, shape: "capsule", fillMode: "gradient", template: "pink", fill1: t.fill1, fill2: t.fill2, strokeMode: "solid", stroke: t.stroke, stroke2: "#7280ff", strokeWidth: 5,
    textColor: t.textColor, textStroke: "#101185", textStrokeWidth: 1.5, font: "Microsoft JhengHei", fontSize: 28,
    start: order * 1.2, duration: 0.55, effect: "fade", easing: "easeInOut"
  };
}
function textUnits(text) {
  return [...text].reduce((sum, char) => sum + (/[\u2e80-\uffff]/.test(char) ? 1 : 0.58), 0);
}
function estimateNodeSize(text, fontSize = 28) {
  const width = clamp(Math.ceil(textUnits(text) * fontSize + 72), 150, 620);
  return { width, height: clamp(Math.ceil(fontSize * 2.45), 60, 120) };
}
function edgePoint(node, anchor) { return { x: node.x + node.width * anchor.x, y: node.y + node.height * anchor.y }; }
function makeLine(from, to, order) {
  const a = defaultAnchor(from, to), b = defaultAnchor(to, from);
  return {
    id: id("line"), from: from.id, to: to.id, color: "#a4a1ff", width: 5, dash: "solid", type: "straight", arrow: "none", startMarker: "none", endMarker: "none", markerSize: 16,
    startAnchor: a, endAnchor: b, controlPoints: [],
    start: Math.max(from.start + from.duration, to.start - 0.55), duration: 0.45, effect: "draw", easing: "easeInOut", order
  };
}
function defaultAnchor(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) return { x: dx > 0 ? 1 : 0, y: 0.5 };
  return { x: 0.5, y: dy > 0 ? 1 : 0 };
}
function buildGraph() {
  const result = parseSource(state.sourceText);
  $("parseErrors").textContent = result.errors.join("\n");
  if (result.errors.length) return;
  pushUndo();
  const nodes = result.nodes.map(makeNode);
  const byNumber = new Map(nodes.map((n) => [n.number, n]));
  const lines = [];
  const integers = nodes.filter((n) => n.number.indexOf(".") < 0).sort((a, b) => compareNumbers(a.number, b.number));
  integers.slice(1).forEach((node, i) => lines.push(makeLine(integers[i], node, lines.length)));
  nodes.filter((n) => n.number.includes(".")).forEach((node) => {
    const parent = byNumber.get(node.number.split(".").slice(0, -1).join("."));
    if (parent) lines.push(makeLine(parent, node, lines.length));
  });
  state.nodes = nodes; state.lines = lines; state.selectedNodes = []; state.selectedLine = null; state.timelineOrder = defaultTimelineOrder(); state.selectedTimelineItems = []; document.body.classList.remove("line-editing");
  autoLayout(false); scheduleDefaults(); renderAll(); saveLocal(); showToast(`已建立 ${nodes.length} 個節點與 ${lines.length} 條連接線。`);
}
function scheduleDefaults() {
  const ordered = [...state.nodes].sort((a, b) => compareNumbers(a.number, b.number));
  const index = new Map(ordered.map((n, i) => [n.id, i]));
  ordered.forEach((n, i) => { n.start = i * 1.2; n.duration = 0.55; });
  state.lines.forEach((line) => {
    const from = nodeById(line.from), to = nodeById(line.to);
    line.start = Math.max(from.start + from.duration, to.start - 0.55); line.duration = 0.45; line.order = index.get(to.id);
  });
}
function autoLayout(commitChange = true) {
  if (commitChange) pushUndo();
  const levels = new Map();
  state.nodes.sort((a, b) => compareNumbers(a.number, b.number)).forEach((node) => {
    const depth = node.number.split(".").length - 1;
    if (!levels.has(depth)) levels.set(depth, []);
    levels.get(depth).push(node);
  });
  const sortedLevels = [...levels.entries()].sort((a, b) => a[0] - b[0]), maxDepth = Math.max(0, ...levels.keys());
  sortedLevels.forEach(([depth, nodes]) => {
    const widest = Math.max(...nodes.map((node) => node.width));
    const columnX = maxDepth ? 60 + depth * ((state.canvas.width - 120 - widest) / maxDepth) : (state.canvas.width - widest) / 2;
    const usableHeight = state.canvas.height - 120, gap = usableHeight / (nodes.length + 1);
    nodes.forEach((node, index) => { node.x = clamp(columnX, 30, state.canvas.width - node.width - 30); node.y = clamp(60 + gap * (index + 1) - node.height / 2, 30, state.canvas.height - node.height - 30); });
  });
  state.lines.forEach((line) => {
    const from = nodeById(line.from), to = nodeById(line.to);
    if (!from || !to) return;
    line.startAnchor = defaultAnchor(from, to); line.endAnchor = defaultAnchor(to, from);
  });
  if (commitChange) { renderAll(); saveLocal(); }
}
function nodeById(nodeId) { return state.nodes.find((n) => n.id === nodeId); }
function lineById(lineId) { return state.lines.find((l) => l.id === lineId); }
function defaultTimelineOrder() {
  const orderedNodes = [...state.nodes].sort((a, b) => compareNumbers(a.number, b.number)), usedLines = new Set(), result = [];
  orderedNodes.forEach((node) => {
    result.push(node.id);
    state.lines.filter((line) => line.from === node.id).sort((a, b) => compareNumbers(nodeById(a.to)?.number ?? "", nodeById(b.to)?.number ?? "")).forEach((line) => { result.push(line.id); usedLines.add(line.id); });
  });
  state.lines.filter((line) => !usedLines.has(line.id)).forEach((line) => result.push(line.id));
  return result;
}
function insertTimelineLine(line) {
  const siblings = state.lines.filter((item) => item.from === line.from && item.id !== line.id).map((item) => item.id), sourceIndex = state.timelineOrder.indexOf(line.from);
  const indexes = [sourceIndex, ...siblings.map((itemId) => state.timelineOrder.indexOf(itemId))].filter((index) => index >= 0);
  state.timelineOrder.splice((indexes.length ? Math.max(...indexes) : state.timelineOrder.length - 1) + 1, 0, line.id);
}
function upgradeState() {
  state.ui ||= { leftWidth: 270, rightWidth: 270, timelineHeight: 225, canvasPanX: 0, canvasPanY: 0 };
  state.ui.canvasPanX ||= 0; state.ui.canvasPanY ||= 0;
  state.selectedTimelineItems ||= [];
  state.subtitles ||= [];
  state.media ||= null;
  if (state.media) { state.media.projectStart ||= 0; state.media.offset ||= 0; state.media.fileDuration ||= state.media.duration; }
  state.nodes.forEach((node) => { if (!node.easing) node.easing = "easeInOut"; if (node.effect === "slide") node.effect = "slideLeft"; node.shape ||= "capsule"; node.fillMode ||= "gradient"; node.strokeMode ||= "solid"; node.stroke2 ||= node.stroke; });
  state.lines.forEach((line) => {
    if (!line.easing) line.easing = "easeInOut";
    line.markerSize ||= 16;
    if (!line.startMarker) line.startMarker = line.arrow === "both" || line.arrow === "start" ? "arrow" : "none";
    if (!line.endMarker) line.endMarker = line.arrow === "both" || line.arrow === "end" ? "arrow" : "none";
    if (!Array.isArray(line.controlPoints)) {
      line.controlPoints = [];
      if (line.type === "curve" && line.control) {
        const from = nodeById(line.from), to = nodeById(line.to);
        if (from && to) {
          const a = edgePoint(from, line.startAnchor), b = edgePoint(to, line.endAnchor);
          line.controlPoints.push({ x: a.x + (b.x - a.x) * line.control.x, y: a.y + (b.y - a.y) * line.control.y });
        }
      }
    }
  });
  const currentIds = [...state.nodes, ...state.lines].map((item) => item.id), previousOrder = state.timelineOrder || [];
  state.timelineOrder = [...previousOrder.filter((itemId) => currentIds.includes(itemId)), ...currentIds.filter((itemId) => !previousOrder.includes(itemId))];
}
function totalDuration() {
  const base = Math.max(0.1, ...state.nodes.map((n) => n.start + n.duration), ...state.lines.map((l) => l.start + l.duration));
  const mediaDuration = state.media?.duration || 0;
  const subEnd = state.subtitles.length ? Math.max(...state.subtitles.map((s) => s.end)) : 0;
  return Math.max(base, mediaDuration, subEnd);
}
function rawProgress(item) { return clamp((state.playhead - item.start) / item.duration, 0, 1); }
function ease(value, type = "linear") {
  const t = clamp(value, 0, 1);
  if (type === "easeIn") return t * t;
  if (type === "easeOut") return 1 - (1 - t) * (1 - t);
  if (type === "easeInOut") return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  if (type === "elastic") return t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
  if (type === "back") { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  return t;
}
function progress(item) { return ease(rawProgress(item), item.easing); }
function pathFor(line, reverse = false) {
  const from = nodeById(line.from), to = nodeById(line.to); if (!from || !to) return "";
  let a = edgePoint(from, line.startAnchor), b = edgePoint(to, line.endAnchor), controlPoints = line.controlPoints;
  if (reverse) { [a, b] = [b, a]; controlPoints = [...controlPoints].reverse(); }
  if (line.type === "curve" && controlPoints.length) {
    const points = [a, ...controlPoints, b];
    if (points.length === 3) return `M ${a.x} ${a.y} Q ${points[1].x} ${points[1].y} ${b.x} ${b.y}`;
    let d = `M ${a.x} ${a.y}`;
    for (let i = 1; i < points.length - 1; i++) {
      const midpoint = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
      d += ` Q ${points[i].x} ${points[i].y} ${midpoint.x} ${midpoint.y}`;
    }
    d += ` T ${b.x} ${b.y}`;
    return d;
  }
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  return el;
}
function renderCanvas(editing = true) {
  const svg = $("canvasSvg"), c = state.canvas;
  const markerQueue = [];
  svg.replaceChildren(); svg.setAttribute("viewBox", `0 0 ${c.width} ${c.height}`);
  svg.classList.toggle("transparent-canvas", editing && c.backgroundType === "transparent");
  svg.style.width = `${c.width * state.zoom}px`; svg.style.height = `${c.height * state.zoom}px`;
  svg.style.transform = `translate(${state.ui.canvasPanX || 0}px, ${state.ui.canvasPanY || 0}px)`;
  const defs = svgEl("defs");
  svg.appendChild(defs);
  if (c.backgroundType !== "transparent") {
    let fill = c.color1;
    if (c.backgroundType === "gradient") {
      const grad = svgEl("linearGradient", { id: "canvasBg", x1: "0", y1: "0", x2: "0", y2: "1" });
      grad.append(svgEl("stop", { offset: "0%", "stop-color": c.color1 }), svgEl("stop", { offset: "100%", "stop-color": c.color2 }));
      defs.append(grad); fill = "url(#canvasBg)";
    }
    svg.append(svgEl("rect", { x: 0, y: 0, width: c.width, height: c.height, fill, "pointer-events": "none" }));
  }
  if (c.backgroundType === "image" && c.image) svg.append(svgEl("image", { href: c.image, x: 0, y: 0, width: c.width, height: c.height, preserveAspectRatio: "xMidYMid slice", "pointer-events": "none" }));
  state.lines.forEach((line) => {
    const reverse = line.arrow === "start", d = pathFor(line, reverse), p = progress(line), selected = state.selectedLine === line.id, maskId = `reveal-${line.id}`;
    const group = svgEl("g"), hit = svgEl("path", { d, class: "edge-hit" });
    if (editing) hit.addEventListener("click", (e) => { e.stopPropagation(); selectLine(line.id); });
    const visible = svgEl("path", { d, class: "edge-visible", stroke: selected ? "#52b5ff" : line.color, "stroke-width": selected ? line.width + 2 : line.width, "stroke-dasharray": line.dash === "dash" ? "18 12" : "none", opacity: line.effect === "fade" ? p : 1 });
    if (line.effect !== "fade") {
      const mask = svgEl("mask", { id: maskId, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: c.width, height: c.height }), reveal = svgEl("path", { d, fill: "none", stroke: "#fff", "stroke-width": line.width + 8, pathLength: "1", "stroke-dasharray": line.effect === "center" ? `${p / 2} ${1 - p} ${p / 2}` : `${p} ${1 - p}`, "stroke-dashoffset": line.effect === "center" ? String(-0.5 + p / 2) : "0" });
      mask.append(reveal); defs.append(mask); visible.setAttribute("mask", `url(#${maskId})`);
    }
    if (editing) group.append(hit);
    group.append(visible); svg.append(group); markerQueue.push({ path: visible, line, p });
  });
  state.nodes.forEach((node) => renderNode(svg, defs, node));
  markerQueue.forEach(({ path, line, p }) => renderAnimatedMarkers(svg, path, line, p, editing));
  if (editing && state.selectedLine) renderLineHandles(svg, lineById(state.selectedLine));
  if (editing && linkPreview) svg.append(svgEl("path", { d: `M ${linkPreview.start.x} ${linkPreview.start.y} L ${linkPreview.end.x} ${linkPreview.end.y}`, class: "link-preview" }));
  if (editing && selectionRect) svg.append(svgEl("rect", { x: Math.min(selectionRect.start.x, selectionRect.end.x), y: Math.min(selectionRect.start.y, selectionRect.end.y), width: Math.abs(selectionRect.end.x - selectionRect.start.x), height: Math.abs(selectionRect.end.y - selectionRect.start.y), class: "selection-rect" }));
  if (editing) svg.addEventListener("pointerdown", startCanvasInteraction);
}
function renderAnimatedMarkers(svg, path, line, p, editing) {
  if (line.arrow === "none" || p <= 0.001) return;
  if (line.arrow === "end") appendMarkerAt(svg, path, p, line.endMarker, line, false, editing);
  if (line.arrow === "start") appendMarkerAt(svg, path, p, line.startMarker, line, false, editing);
  if (line.arrow === "both") {
    appendMarkerAt(svg, path, 0.5 + p / 2, line.endMarker, line, false, editing);
    appendMarkerAt(svg, path, 0.5 - p / 2, line.startMarker, line, true, editing);
  }
}
function appendMarkerAt(svg, path, ratio, shape, line, reverse = false, editing = true) {
  if (!shape || shape === "none") return;
  const length = path.getTotalLength(), at = length * clamp(ratio, 0, 1), pos = path.getPointAtLength(at), epsilon = Math.max(1, Math.min(6, length * 0.02));
  const before = path.getPointAtLength(clamp(at - epsilon, 0, length)), after = path.getPointAtLength(clamp(at + epsilon, 0, length));
  const angle = Math.atan2(reverse ? before.y - after.y : after.y - before.y, reverse ? before.x - after.x : after.x - before.x) * 180 / Math.PI, size = line.markerSize;
  const g = svgEl("g", { class: "marker-shape", transform: `translate(${pos.x} ${pos.y}) rotate(${angle}) scale(${size / 10})`, fill: line.color, stroke: line.color, "stroke-width": 1.4 });
  const shapes = {
    arrow: ["path", { d: "M-10,-5 L0,0 L-10,5 z" }],
    openArrow: ["path", { d: "M-10,-5 L0,0 L-10,5", fill: "none", "stroke-width": 2 }],
    triangle: ["path", { d: "M-9,-5 L0,0 L-9,5 z" }],
    circle: ["circle", { cx: -4, cy: 0, r: 4 }],
    square: ["rect", { x: -8, y: -4, width: 8, height: 8 }],
    diamond: ["path", { d: "M-8,0 L-4,-4 L0,0 L-4,4 z" }]
  };
  const spec = shapes[shape]; if (!spec) return; g.append(svgEl(spec[0], spec[1]));
  if (editing) g.addEventListener("click", (e) => { e.stopPropagation(); selectLine(line.id); });
  svg.append(g);
}
function renderNode(svg, defs, node) {
  const p = progress(node), selected = state.selectedNodes.includes(node.id), g = svgEl("g", { class: `node-shape ${linkSourceId === node.id ? "link-source" : ""}`, "data-node": node.id });
  let transform = `translate(${node.x} ${node.y})`, opacity = node.effect === "fadeOut" ? 1 - p : p;
  if (node.effect === "scale") transform += ` translate(${node.width / 2} ${node.height / 2}) scale(${0.6 + 0.4 * p}) translate(${-node.width / 2} ${-node.height / 2})`;
  if (node.effect === "scaleDown") transform += ` translate(${node.width / 2} ${node.height / 2}) scale(${1.4 - 0.4 * p}) translate(${-node.width / 2} ${-node.height / 2})`;
  if (node.effect === "slideLeft") transform += ` translate(${(1 - p) * -100} 0)`;
  if (node.effect === "slideRight") transform += ` translate(${(1 - p) * 100} 0)`;
  if (node.effect === "slideUp") transform += ` translate(0 ${(1 - p) * -100})`;
  if (node.effect === "slideDown") transform += ` translate(0 ${(1 - p) * 100})`;
  if (node.effect === "bounce") transform += ` translate(0 ${-Math.abs(Math.sin(p * Math.PI * 2.5)) * (1 - p) * 90})`;
  if (node.effect === "flip") transform += ` translate(${node.width / 2} 0) scale(${Math.max(0.05, Math.abs(Math.cos((1 - p) * Math.PI / 2)))} 1) translate(${-node.width / 2} 0)`;
  g.setAttribute("transform", transform); g.setAttribute("opacity", opacity);
  const gradientId = `grad-${node.id}`, grad = svgEl("linearGradient", { id: gradientId, x1: "0", y1: "0", x2: "0", y2: "1" });
  grad.append(svgEl("stop", { offset: "0%", "stop-color": node.fill1 }), svgEl("stop", { offset: "100%", "stop-color": node.fill2 })); defs.append(grad);
  const strokeGradientId = `stroke-grad-${node.id}`, strokeGrad = svgEl("linearGradient", { id: strokeGradientId, x1: "0", y1: "0", x2: "1", y2: "1" });
  strokeGrad.append(svgEl("stop", { offset: "0%", "stop-color": node.stroke }), svgEl("stop", { offset: "100%", "stop-color": node.stroke2 })); defs.append(strokeGrad);
  const fill = node.fillMode === "none" ? "none" : node.fillMode === "solid" ? node.fill1 : `url(#${gradientId})`, radius = nodeShapeRadius(node);
  const stroke = selected ? "#52b5ff" : node.strokeMode === "none" ? "none" : node.strokeMode === "gradient" ? `url(#${strokeGradientId})` : node.stroke, strokeWidth = selected ? node.strokeWidth + 3 : node.strokeWidth;
  g.append(svgEl(node.shape === "ellipse" || node.shape === "circle" ? "ellipse" : "rect", node.shape === "ellipse" || node.shape === "circle" ? { cx: node.width / 2, cy: node.height / 2, rx: node.width / 2, ry: node.height / 2, fill, stroke, "stroke-width": strokeWidth } : { width: node.width, height: node.height, rx: radius, fill, stroke, "stroke-width": strokeWidth }));
  const text = svgEl("text", { x: node.width / 2, y: node.height / 2, "dominant-baseline": "central", "text-anchor": "middle", fill: node.textColor, stroke: node.textStroke, "stroke-width": node.textStrokeWidth, "paint-order": "stroke", "font-family": node.font, "font-size": node.fontSize, "font-weight": "700" });
  const fullText = `${state.showNumbers ? `${node.number} ` : ""}${node.text}`;
  text.textContent = node.effect === "typewriter" ? fullText.slice(0, Math.ceil(fullText.length * p)) : fullText; g.append(text);
  g.addEventListener("pointerdown", (e) => startNodeDrag(e, node));
  g.addEventListener("click", (e) => { e.stopPropagation(); if (!linkMode) selectNode(node.id, e.ctrlKey ? "subtract" : e.shiftKey ? "add" : "replace"); });
  svg.append(g);
}
function nodeShapeRadius(node) {
  if (node.shape === "rectangle") return 0;
  if (node.shape === "capsule") return node.height / 2;
  return Math.min(node.radius, Math.max(0, Math.min(node.width, node.height) / 3));
}
function renderLineHandles(svg, line) {
  const from = nodeById(line.from), to = nodeById(line.to), a = edgePoint(from, line.startAnchor), b = edgePoint(to, line.endAnchor);
  [["start", a], ["end", b]].forEach(([kind, p]) => {
    const h = svgEl("circle", { cx: p.x, cy: p.y, r: 11, class: "handle" });
    h.addEventListener("pointerdown", (e) => startHandleDrag(e, line, kind)); svg.append(h);
  });
  line.controlPoints.forEach((c, index) => {
    const h = svgEl("circle", { cx: c.x, cy: c.y, r: 11, class: `control-handle ${selectedControlPoint === index ? "selected" : ""}` });
    h.addEventListener("click", (e) => { e.stopPropagation(); selectedControlPoint = index; renderCanvas(); });
    h.addEventListener("pointerdown", (e) => startHandleDrag(e, line, "control", index)); svg.append(h);
  });
}
function svgPoint(e) {
  const svg = $("canvasSvg"), point = svg.createSVGPoint(); point.x = e.clientX; point.y = e.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}
function createConnection(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return false;
  if (state.lines.some((line) => line.from === fromId && line.to === toId)) { showToast("這條連接線已經存在。"); return false; }
  linkSourceId = null;
  commit(() => { const line = makeLine(nodeById(fromId), nodeById(toId), state.lines.length); state.lines.push(line); insertTimelineLine(line); state.selectedLine = line.id; state.selectedNodes = []; });
  document.body.classList.add("line-editing"); showToast("連接線已建立。可繼續點選下一個來源節點。"); return true;
}
function startNodeDrag(e, node) {
  e.stopPropagation(); const p = svgPoint(e);
  if (linkMode) {
    e.preventDefault();
    if (linkSourceId && linkSourceId !== node.id) { createConnection(linkSourceId, node.id); return; }
    drag = { kind: "newLine", fromId: node.id }; linkPreview = { start: p, end: p };
    window.addEventListener("pointermove", onDrag); window.addEventListener("pointerup", endDrag, { once: true }); renderCanvas(); return;
  }
  if (e.shiftKey || e.ctrlKey) return;
  const selected = state.selectedNodes.includes(node.id) ? state.selectedNodes : [node.id];
  if (!state.selectedNodes.includes(node.id)) { state.selectedNodes = selected; state.selectedLine = null; }
  pushUndo(); drag = { kind: "nodes", start: p, original: selected.map((nodeId) => ({ nodeId, x: nodeById(nodeId).x, y: nodeById(nodeId).y })) };
  window.addEventListener("pointermove", onDrag); window.addEventListener("pointerup", endDrag, { once: true }); renderAll();
}
function startHandleDrag(e, line, kind, pointIndex = null) {
  e.stopPropagation(); pushUndo(); drag = { kind, lineId: line.id, pointIndex };
  window.addEventListener("pointermove", onDrag); window.addEventListener("pointerup", endDrag, { once: true });
}
function onDrag(e) {
  if (!drag) return; const p = svgPoint(e);
  if (drag.kind === "newLine") { linkPreview.end = p; renderCanvas(); return; }
  if (drag.kind === "nodes") {
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    drag.original.forEach((o) => { const n = nodeById(o.nodeId); n.x = clamp(o.x + dx, 0, state.canvas.width - n.width); n.y = clamp(o.y + dy, 0, state.canvas.height - n.height); });
  } else {
    const line = lineById(drag.lineId), from = nodeById(line.from), to = nodeById(line.to);
    if (drag.kind === "control") {
      line.controlPoints[drag.pointIndex] = { x: p.x, y: p.y };
    } else {
      const n = drag.kind === "start" ? from : to, localX = clamp((p.x - n.x) / n.width, 0, 1), localY = clamp((p.y - n.y) / n.height, 0, 1);
      const candidates = [{ x: localX, y: 0 }, { x: localX, y: 1 }, { x: 0, y: localY }, { x: 1, y: localY }];
      const best = candidates.sort((a, b) => Math.hypot(a.x - localX, a.y - localY) - Math.hypot(b.x - localX, b.y - localY))[0];
      line[drag.kind === "start" ? "startAnchor" : "endAnchor"] = best;
    }
  }
  renderCanvas();
}
function nodeAtPoint(p) {
  return [...state.nodes].reverse().find((node) => p.x >= node.x && p.x <= node.x + node.width && p.y >= node.y && p.y <= node.y + node.height);
}
function startCanvasInteraction(e) {
  if (e.target !== $("canvasSvg") || linkMode) return;
  if (e.button === 1) { startCanvasPan(e); return; }
  if (e.button !== 0) return;
  startCanvasSelection(e);
}
function startCanvasPan(e) {
  const viewport = $("canvasViewport"), svg = $("canvasSvg"), originX = e.clientX, originY = e.clientY, startX = state.ui.canvasPanX || 0, startY = state.ui.canvasPanY || 0;
  e.preventDefault(); viewport.classList.add("panning");
  const move = (event) => { state.ui.canvasPanX = startX + event.clientX - originX; state.ui.canvasPanY = startY + event.clientY - originY; svg.style.transform = `translate(${state.ui.canvasPanX}px, ${state.ui.canvasPanY}px)`; };
  const up = () => { window.removeEventListener("pointermove", move); viewport.classList.remove("panning"); saveLocal(); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
}
function startCanvasSelection(e) {
  const p = svgPoint(e); e.preventDefault();
  selectionRect = { start: p, end: p, mode: e.ctrlKey ? "subtract" : e.shiftKey ? "add" : "replace" };
  window.addEventListener("pointermove", onCanvasSelection);
  window.addEventListener("pointerup", endCanvasSelection, { once: true });
}
function onCanvasSelection(e) { if (!selectionRect) return; selectionRect.end = svgPoint(e); renderCanvas(); }
function endCanvasSelection() {
  window.removeEventListener("pointermove", onCanvasSelection);
  if (!selectionRect) return;
  const x1 = Math.min(selectionRect.start.x, selectionRect.end.x), x2 = Math.max(selectionRect.start.x, selectionRect.end.x), y1 = Math.min(selectionRect.start.y, selectionRect.end.y), y2 = Math.max(selectionRect.start.y, selectionRect.end.y);
  const picked = state.nodes.filter((n) => n.x < x2 && n.x + n.width > x1 && n.y < y2 && n.y + n.height > y1).map((n) => n.id);
  state.selectedNodes = selectionRect.mode === "subtract" ? state.selectedNodes.filter((id) => !picked.includes(id)) : selectionRect.mode === "add" ? [...new Set([...state.selectedNodes, ...picked])] : picked;
  state.selectedLine = null; document.body.classList.remove("line-editing"); selectionRect = null; renderAll();
}
function zoomCanvasAtPointer(e) {
  e.preventDefault();
  const viewport = $("canvasViewport"), svg = $("canvasSvg"), rect = svg.getBoundingClientRect(), oldZoom = state.zoom;
  const pointX = (e.clientX - rect.left) / oldZoom, pointY = (e.clientY - rect.top) / oldZoom;
  state.zoom = clamp(oldZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.2, 1.6);
  renderAll();
  requestAnimationFrame(() => { const nextRect = svg.getBoundingClientRect(); state.ui.canvasPanX += e.clientX - (nextRect.left + pointX * state.zoom); state.ui.canvasPanY += e.clientY - (nextRect.top + pointY * state.zoom); renderCanvas(); saveLocal(); });
}
function endDrag(e) {
  window.removeEventListener("pointermove", onDrag);
  if (!drag) return;
  const p = svgPoint(e), target = nodeAtPoint(p);
  if (drag.kind === "newLine") {
    linkPreview = null;
    if (target && target.id !== drag.fromId) createConnection(drag.fromId, target.id);
    else { linkSourceId = drag.fromId; renderAll(); showToast("已選擇來源節點，請點擊目標節點；也可以重新拖拉。"); }
    drag = null; return;
  }
  if ((drag.kind === "start" || drag.kind === "end") && target) {
    const line = lineById(drag.lineId), otherId = drag.kind === "start" ? line.to : line.from;
    if (target.id !== otherId) {
      line[drag.kind === "start" ? "from" : "to"] = target.id;
      const other = nodeById(otherId);
      line[drag.kind === "start" ? "startAnchor" : "endAnchor"] = defaultAnchor(target, other);
    }
  }
  drag = null; renderAll(); saveLocal();
}
function selectNode(nodeId, mode = "replace") {
  state.selectedLine = null;
  document.body.classList.remove("line-editing");
  if (mode === "subtract") state.selectedNodes = state.selectedNodes.filter((id) => id !== nodeId);
  else if (mode === "add") state.selectedNodes = state.selectedNodes.includes(nodeId) ? state.selectedNodes : [...state.selectedNodes, nodeId];
  else state.selectedNodes = [nodeId];
  renderAll();
}
function selectLine(lineId) { state.selectedNodes = []; state.selectedLine = lineId; selectedControlPoint = null; document.body.classList.add("line-editing"); renderAll(); }

function renderLists() {
  const activeDepth = state.selectedNodes.length === 1 ? nodeById(state.selectedNodes[0])?.number.split(".").length - 1 : null;
  $("nodeList").innerHTML = state.nodes.sort((a, b) => compareNumbers(a.number, b.number)).map((n) => { const depth = (n.parts?.length ?? n.number.split(".").length) - 1; return `<div class="object-row ${state.selectedNodes.includes(n.id) ? "selected" : ""} ${activeDepth === depth ? "layer-selected" : ""}" data-id="${n.id}"><span class="indent" style="width:${depth * 14}px"></span>${esc(n.number)} ${esc(n.text)}</div>`; }).join("");
  $("nodeList").querySelectorAll(".object-row").forEach((row) => row.onclick = (e) => selectNode(row.dataset.id, e.ctrlKey ? "subtract" : e.shiftKey ? "add" : "replace"));
}
function fillSelect(select, selected) {
  select.innerHTML = state.nodes.map((n) => `<option value="${n.id}" ${n.id === selected ? "selected" : ""}>${esc(n.number)} ${esc(n.text)}</option>`).join("");
}
function renderProperties() {
  const nodes = state.selectedNodes.map(nodeById).filter(Boolean), line = lineById(state.selectedLine);
  $("emptyProperties").classList.toggle("hidden", nodes.length || line);
  $("nodeProperties").classList.toggle("hidden", !nodes.length);
  $("lineProperties").classList.toggle("hidden", !line);
  if (nodes.length) {
    const n = nodes[0]; $("nodeSelectionCount").textContent = nodes.length > 1 ? `(${nodes.length} 個)` : "";
    setValues({ nodeText: n.text, nodeTemplate: n.template, nodeShape: n.shape, nodeFillMode: n.fillMode, nodeWidth: n.width, nodeWidthRange: n.width, nodeHeight: n.height, nodeHeightRange: n.height, nodeFill1: n.fill1, nodeFill2: n.fill2, nodeStrokeMode: n.strokeMode, nodeStroke: n.stroke, nodeStroke2: n.stroke2, nodeStrokeWidth: n.strokeWidth, nodeTextColor: n.textColor, nodeTextStroke: n.textStroke, nodeFont: n.font, nodeFontSize: n.fontSize, nodeTextStrokeWidth: n.textStrokeWidth, nodeRadius: n.radius, nodeRadiusRange: n.radius, nodeStart: n.start, nodeDuration: n.duration, nodeEffect: n.effect, nodeEasing: n.easing });
    $("nodeText").disabled = nodes.length > 1;
  }
  if (line) {
    fillSelect($("lineFrom"), line.from); fillSelect($("lineTo"), line.to);
    setValues({ lineColor: line.color, lineWidth: line.width, lineWidthRange: line.width, lineDash: line.dash, lineType: line.type, lineArrow: line.arrow, lineStartMarker: line.startMarker, lineEndMarker: line.endMarker, lineMarkerSize: line.markerSize, lineStart: line.start, lineDuration: line.duration, lineEffect: line.effect, lineEasing: line.easing });
  }
}
function setValues(values) { Object.entries(values).forEach(([key, value]) => { $(key).value = value; }); }
function renderTimeline() {
  const total = totalDuration(), currentTime = Math.min(state.playhead, total);
  $("playhead").max = total; $("playhead").value = currentTime; $("timeLabel").textContent = `${currentTime.toFixed(2)} / ${total.toFixed(2)} 秒`;
  const extraTracks = [];
  if (state.media) extraTracks.push({ id: "audio-track", type: "audio", label: "🔊 音訊", start: 0, duration: state.media.duration });
  if (state.subtitles?.length) extraTracks.push({ id: "subtitle-track", type: "subtitle", label: "📝 字幕", start: 0, duration: total });
  const unsortedTracks = [
    ...state.nodes.map((n) => ({ label: `節點 ${n.number} ${n.text}`, type: "node", ...n })),
    ...state.lines.map((l) => ({ ...l, label: `線條 ${nodeById(l.from)?.number ?? "?"} → ${nodeById(l.to)?.number ?? "?"}`, type: "line" }))
  ];
  const order = new Map((state.timelineOrder || []).map((itemId, index) => [itemId, index]));
  const tracks = [...extraTracks, ...unsortedTracks.sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999))];
  let html = `<div id="timelinePlayhead" class="timeline-playhead"><span></span></div>`;
  tracks.forEach((t) => {
    if (t.type === "audio") {
      const m = state.media, ps = m?.projectStart || 0;
      const durationPx = Math.max(7, t.duration * TIMELINE_PX_PER_SECOND);
      html += `<div class="track audio" data-id="${t.id}"><div class="track-label"><span class="track-grip">⋮⋮</span><span class="track-name">${esc(t.label)}</span></div><div class="track-lane"><div class="track-clip" data-type="audio" data-id="${t.id}" style="left:calc(50% + ${(ps - currentTime) * TIMELINE_PX_PER_SECOND}px);width:${durationPx}px">`;
      if (m?.waveform?.length) {
        html += `<canvas class="audio-waveform" width="${Math.ceil(durationPx)}" height="30"></canvas>`;
      }
      html += `</div></div></div>`;
    } else if (t.type === "subtitle") {
      html += `<div class="track subtitle" data-id="${t.id}"><div class="track-label"><span class="track-grip">⋮⋮</span><span class="track-name">${esc(t.label)}</span></div><div class="track-lane" style="overflow:visible">`;
      state.subtitles.forEach((sub) => {
        const left = (sub.start - currentTime) * TIMELINE_PX_PER_SECOND + 50;
        const width = Math.max(7, (sub.end - sub.start) * TIMELINE_PX_PER_SECOND);
        html += `<div class="sub-segment" data-id="${sub.id}" style="left:calc(50% + ${(sub.start - currentTime) * TIMELINE_PX_PER_SECOND}px);width:${width}px"><span class="sub-seg-text">${esc(sub.text)}</span></div>`;
      });
      html += `</div></div>`;
    } else {
      const selected = t.type === "node" ? state.selectedNodes.includes(t.id) : state.selectedLine === t.id;
      const groupSelected = state.selectedTimelineItems.includes(t.id);
      html += `<div class="track ${t.type} ${selected ? "selected" : ""} ${groupSelected ? "layer-selected" : ""}" data-id="${t.id}" data-type="${t.type}"><div class="track-label" data-id="${t.id}" data-type="${t.type}"><span class="track-grip">⋮⋮</span><span class="track-name">${esc(t.label)}</span></div><div class="track-lane"><div class="track-clip ${groupSelected ? "group-selected" : ""}" data-type="${t.type}" data-id="${t.id}" style="left:calc(50% + ${(t.start - currentTime) * TIMELINE_PX_PER_SECOND}px);width:${Math.max(7, t.duration * TIMELINE_PX_PER_SECOND)}px"></div></div></div>`;
    }
  });
  $("timeline").innerHTML = html;
  // Draw waveform on canvas
  $("timeline").querySelectorAll(".audio-waveform").forEach((canvas) => {
    const wf = state.media?.waveform;
    if (!wf?.length) return;
    const m = state.media;
    const fileDur = m.fileDuration || m.duration;
    const startFrac = Math.max(0, (m.offset || 0) / fileDur);
    const endFrac = Math.min(1, ((m.offset || 0) + m.duration) / fileDur);
    const startIdx = Math.floor(startFrac * wf.length);
    const endIdx = Math.ceil(endFrac * wf.length);
    const segLen = Math.max(1, endIdx - startIdx);
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height, half = h / 2;
    ctx.clearRect(0, 0, w, h);
    const barCount = Math.min(segLen, Math.floor(w));
    const step = segLen / barCount;
    for (let i = 0; i < barCount; i++) {
      const idx = startIdx + Math.floor(i * step);
      const barH = Math.max(2, wf[idx] * half);
      ctx.fillStyle = "rgba(127,200,255,0.85)";
      ctx.fillRect(i * (w / barCount), half - barH, Math.max(1, w / barCount), barH * 2);
    }
  });
  $("timeline").querySelectorAll(".track-clip").forEach((clip) => {
    if (clip.closest(".track")?.classList.contains("subtitle")) return;
    clip.addEventListener("pointerdown", startTimelineDrag);
  });
  $("timeline").querySelectorAll(".track-label").forEach((label) => {
    if (label.closest(".track")?.classList.contains("audio") || label.closest(".track")?.classList.contains("subtitle")) return;
    label.addEventListener("pointerdown", startTrackReorder);
  });
  $("timelinePlayhead").addEventListener("pointerdown", startPlayheadDrag);
  renderTimelineSelection();
  renderTimelinePlayhead();
}
function renderBackgroundInputs() {
  $("canvasWidth").value = state.canvas.width; $("canvasHeight").value = state.canvas.height; $("backgroundType").value = state.canvas.backgroundType;
  $("backgroundColor1").value = state.canvas.color1; $("backgroundColor2").value = state.canvas.color2; $("showNumbers").checked = state.showNumbers;
  $("zoomRange").value = state.zoom * 100; $("zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
}
function renderAll() { applyUiSizes(); renderBackgroundInputs(); renderCanvas(); renderLists(); renderProperties(); renderTimeline(); }

function bindValue(idValue, apply, event = "change") {
  $(idValue).addEventListener(event, () => commit(() => apply($(idValue).value)));
}
function bindNodeValue(idValue, key, convert = (v) => v) {
  bindValue(idValue, (value) => state.selectedNodes.map(nodeById).filter(Boolean).forEach((n) => n[key] = convert(value)), "change");
}
function bindLineValue(idValue, key, convert = (v) => v) { bindValue(idValue, (value) => { const line = lineById(state.selectedLine); if (line) line[key] = convert(value); }, "change"); }
function bindLive(idValue, apply) {
  const input = $(idValue); let snapshotted = false;
  input.addEventListener("pointerdown", () => { pushUndo(); snapshotted = true; });
  input.addEventListener("input", () => { if (!snapshotted) { pushUndo(); snapshotted = true; } apply(input.value); renderCanvas(); renderProperties(); renderTimeline(); saveLocal(); });
  input.addEventListener("change", () => { snapshotted = false; renderAll(); saveLocal(); });
}
function applyNodeGeometry(node, key, value) {
  node[key] = Number(value);
  if (node.shape === "circle") { const size = key === "height" ? node.height : node.width; node.width = size; node.height = size; }
}
function applyNodeShape(shape) {
  state.selectedNodes.map(nodeById).filter(Boolean).forEach((node) => {
    node.shape = shape;
    if (shape === "rectangle") node.radius = 0;
    if (shape === "capsule") node.radius = node.height / 2;
    if (shape === "circle") { const size = Math.max(node.width, node.height); node.width = size; node.height = size; }
  });
}
function constrainUiSizes() {
  const defaults = defaultState().ui, width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
  state.ui = { ...defaults, ...(state.ui || {}) };
  const compact = width < 800, leftMin = compact ? 140 : 190, rightMin = compact ? 150 : 220, centerMin = compact ? 220 : 360;
  const panelBudget = Math.max(leftMin + rightMin, width - centerMin - 12);
  state.ui.leftWidth = clamp(Number(state.ui.leftWidth) || defaults.leftWidth, leftMin, Math.min(520, panelBudget - rightMin));
  state.ui.rightWidth = clamp(Number(state.ui.rightWidth) || defaults.rightWidth, rightMin, Math.min(560, panelBudget - state.ui.leftWidth));
  if (state.ui.leftWidth + state.ui.rightWidth > panelBudget) state.ui.leftWidth = Math.max(leftMin, panelBudget - state.ui.rightWidth);
  const topbarHeight = document.querySelector(".topbar")?.offsetHeight || 48;
  state.ui.timelineHeight = clamp(Number(state.ui.timelineHeight) || defaults.timelineHeight, 110, Math.max(110, Math.min(600, height - topbarHeight - 180)));
}
function applyUiSizes() {
  constrainUiSizes();
  document.documentElement.style.setProperty("--left-panel-width", `${state.ui.leftWidth}px`);
  document.documentElement.style.setProperty("--right-panel-width", `${state.ui.rightWidth}px`);
  document.documentElement.style.setProperty("--timeline-height", `${state.ui.timelineHeight}px`);
}
function startPanelResize(kind, e) {
  e.preventDefault(); const startX = e.clientX, startY = e.clientY, original = clone(state.ui);
  const move = (event) => {
    if (kind === "left") state.ui.leftWidth = clamp(original.leftWidth + event.clientX - startX, 140, 520);
    if (kind === "right") state.ui.rightWidth = clamp(original.rightWidth - event.clientX + startX, 150, 560);
    if (kind === "timeline") state.ui.timelineHeight = clamp(original.timelineHeight - event.clientY + startY, 110, Math.min(600, innerHeight - 180));
    applyUiSizes();
    if (kind === "timeline") requestAnimationFrame(() => { fitCanvasToViewport(); renderCanvas(); renderBackgroundInputs(); });
  };
  const up = () => { window.removeEventListener("pointermove", move); saveLocal(); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
}
function fitCanvasToViewport(allowGrow = false) {
  const viewport = $("canvasViewport"), fitted = Math.min((viewport.clientWidth - 45) / state.canvas.width, (viewport.clientHeight - 45) / state.canvas.height);
  state.zoom = clamp(allowGrow ? fitted : Math.min(state.zoom, fitted), 0.05, 1.6);
}
function timelinePlayheadLeft() {
  const timeline = $("timeline"), lane = timeline.querySelector(".track-lane"); if (!lane) return 162;
  return lane.offsetLeft + lane.clientWidth / 2;
}
function renderTimelinePlayhead() {
  const timeline = $("timeline"), head = $("timelinePlayhead"); if (!head) return;
  head.style.left = `${timelinePlayheadLeft()}px`; head.style.top = `${timeline.scrollTop}px`; head.style.height = `${timeline.clientHeight}px`;
}
function timelineTimeAtClientX(clientX) {
  const lane = $("timeline").querySelector(".track-lane"); if (!lane) return 0;
  const rect = lane.getBoundingClientRect(); return clamp(Math.min(state.playhead, totalDuration()) + (clientX - (rect.left + rect.width / 2)) / TIMELINE_PX_PER_SECOND, 0, totalDuration());
}
function startPlayheadDrag(e) {
  e.preventDefault(); e.stopPropagation(); state.playing = false; $("playBtn").textContent = "播放";
  const originX = e.clientX, originalTime = Math.min(state.playhead, totalDuration());
  const move = (event) => { state.playhead = clamp(originalTime + (event.clientX - originX) / TIMELINE_PX_PER_SECOND, 0, totalDuration()); renderCanvas(); renderTimeline(); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
}
function nudgePlayhead(delta) { state.playing = false; $("playBtn").textContent = "播放"; state.playhead = clamp(Math.min(state.playhead, totalDuration()) + delta, 0, totalDuration()); if (state.media?.element) try { state.media.element.currentTime = audioTimeAtPlayhead(); } catch (_) {} renderCanvas(); renderTimeline(); }
function timelineItem(type, itemId) { return type === "node" ? nodeById(itemId) : lineById(itemId); }
function timelineItemById(itemId) { return nodeById(itemId) || lineById(itemId); }
function getActiveTimelineItem() {
  return state.selectedTimelineItems.length ? timelineItemById(state.selectedTimelineItems[0]) : state.selectedNodes.length ? nodeById(state.selectedNodes[0]) : state.selectedLine ? lineById(state.selectedLine) : null;
}
function orderedTimelineIds() {
  const currentIds = [...state.nodes, ...state.lines].map((item) => item.id);
  const ordered = [...(state.timelineOrder || []).filter((id) => currentIds.includes(id)), ...currentIds.filter((id) => !(state.timelineOrder || []).includes(id))];
  return ordered;
}
function selectTimelineItemById(itemId) {
  const node = nodeById(itemId), line = lineById(itemId);
  if (!node && !line) return;
  state.selectedTimelineItems = [itemId];
  if (node) {
    state.selectedNodes = [node.id];
    state.selectedLine = null;
    document.body.classList.remove("line-editing");
    focusCanvasOnNode(node.id);
  } else {
    state.selectedNodes = [];
    state.selectedLine = line.id;
    selectedControlPoint = null;
    document.body.classList.add("line-editing");
  }
  renderAll();
}
function selectRelativeTimelineLayer(delta) {
  const ordered = orderedTimelineIds();
  if (!ordered.length) return;
  const current = state.selectedTimelineItems[0] || state.selectedNodes[0] || state.selectedLine || ordered[0];
  const currentIndex = Math.max(0, ordered.indexOf(current));
  const next = ordered[clamp(currentIndex + delta, 0, ordered.length - 1)];
  selectTimelineItemById(next);
}
function moveTimelineLayer(delta) {
  commit(() => {
    const ordered = orderedTimelineIds();
    if (!ordered.length) return;
    const current = state.selectedTimelineItems[0] || state.selectedNodes[0] || state.selectedLine;
    if (!current) return;
    const idx = state.timelineOrder.indexOf(current);
    if (idx < 0) return;
    const target = clamp(idx + delta, 0, state.timelineOrder.length - 1);
    if (target === idx) return;
    state.timelineOrder.splice(idx, 1);
    state.timelineOrder.splice(target, 0, current);
  });
}
function selectedTimelineItems() {
  const ids = state.selectedTimelineItems.length ? state.selectedTimelineItems : [state.selectedNodes[0], state.selectedLine].filter(Boolean);
  return ids.map(timelineItemById).filter(Boolean);
}
function alignSelectedTimelineStartToPlayhead() {
  const items = selectedTimelineItems();
  if (!items.length) return;
  commit(() => items.forEach((item) => { item.start = snapTime(state.playhead); }));
}
function alignSelectedTimelineEndToPlayhead() {
  const items = selectedTimelineItems();
  if (!items.length) return;
  commit(() => items.forEach((item) => { item.start = snapTime(Math.max(0, state.playhead - item.duration)); }));
}
function movePlayheadToSelectedTimelineEdge(edge) {
  const items = selectedTimelineItems();
  if (!items.length) return;
  const time = edge === "start" ? Math.min(...items.map((item) => item.start)) : Math.max(...items.map((item) => item.start + item.duration));
  state.playhead = clamp(time, 0, totalDuration());
  if (state.media?.element) try { state.media.element.currentTime = audioTimeAtPlayhead(); } catch (_) {}
  renderCanvas(); renderTimeline();
}
function zoomTimelineAtWheel(event) {
  if (!event.shiftKey) return;
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
  TIMELINE_PX_PER_SECOND = Math.round(clamp(TIMELINE_PX_PER_SECOND * factor, 24, 360));
  renderTimeline();
}
function renderTimelineSelection() {
  $("timeline").querySelector(".timeline-selection")?.remove();
  if (!timelineSelection) return;
  const box = document.createElement("div"), left = Math.min(timelineSelection.startX, timelineSelection.endX), top = Math.min(timelineSelection.startY, timelineSelection.endY);
  box.className = "timeline-selection"; Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${Math.abs(timelineSelection.endX - timelineSelection.startX)}px`, height: `${Math.abs(timelineSelection.endY - timelineSelection.startY)}px` });
  $("timeline").append(box);
}
function startTimelineMarquee(e) {
  e.preventDefault(); state.playing = false; $("playBtn").textContent = "播放";
  const timeline = $("timeline"), rect = timeline.getBoundingClientRect(), startClientX = e.clientX, startClientY = e.clientY;
  timelineSelection = { startX: e.clientX - rect.left + timeline.scrollLeft, startY: e.clientY - rect.top + timeline.scrollTop, endX: e.clientX - rect.left + timeline.scrollLeft, endY: e.clientY - rect.top + timeline.scrollTop, additive: e.shiftKey };
  const move = (event) => { timelineSelection.endX = event.clientX - rect.left + timeline.scrollLeft; timelineSelection.endY = event.clientY - rect.top + timeline.scrollTop; renderTimelineSelection(); };
  const up = (event) => {
    window.removeEventListener("pointermove", move);
    const moved = Math.hypot(event.clientX - startClientX, event.clientY - startClientY);
    if (moved < 5) state.playhead = timelineTimeAtClientX(event.clientX);
    else {
      const selectionRect = { left: Math.min(startClientX, event.clientX), right: Math.max(startClientX, event.clientX), top: Math.min(startClientY, event.clientY), bottom: Math.max(startClientY, event.clientY) };
      const picked = [...timeline.querySelectorAll(".track-clip")].filter((clip) => { const clipRect = clip.getBoundingClientRect(); return clipRect.right >= selectionRect.left && clipRect.left <= selectionRect.right && clipRect.bottom >= selectionRect.top && clipRect.top <= selectionRect.bottom; }).map((clip) => clip.dataset.id);
      state.selectedTimelineItems = timelineSelection.additive ? [...new Set([...state.selectedTimelineItems, ...picked])] : picked;
    }
    timelineSelection = null; renderCanvas(); renderTimeline();
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
}
function startTrackReorder(e) {
  e.preventDefault(); e.stopPropagation();
  const itemId = e.currentTarget.dataset.id, type = e.currentTarget.dataset.type, originY = e.clientY;
  if (e.ctrlKey) state.selectedTimelineItems = state.selectedTimelineItems.includes(itemId) ? state.selectedTimelineItems.filter((id) => id !== itemId) : [...state.selectedTimelineItems, itemId];
  else if (!state.selectedTimelineItems.includes(itemId)) state.selectedTimelineItems = [itemId];
  if (type === "node") { state.selectedNodes = [itemId]; state.selectedLine = null; document.body.classList.remove("line-editing"); focusCanvasOnNode(itemId); }
  else { state.selectedNodes = []; state.selectedLine = itemId; selectedControlPoint = null; document.body.classList.add("line-editing"); }
  const selectedSet = new Set(state.selectedTimelineItems.length ? state.selectedTimelineItems : [itemId]), movingIds = state.timelineOrder.filter((id) => selectedSet.has(id));
  let started = false;
  const move = (event) => {
    if (!started && Math.abs(event.clientY - originY) < 5) return;
    if (!started) { pushUndo(); started = true; }
    const target = [...$("timeline").querySelectorAll(".track")].find((track) => { const rect = track.getBoundingClientRect(); return event.clientY >= rect.top && event.clientY <= rect.bottom; });
    if (!target || movingIds.includes(target.dataset.id)) return;
    const rect = target.getBoundingClientRect(), order = state.timelineOrder.filter((id) => !movingIds.includes(id)), index = order.indexOf(target.dataset.id) + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
    order.splice(index, 0, ...movingIds); state.timelineOrder = order; renderTimeline();
  };
  const up = () => { window.removeEventListener("pointermove", move); renderAll(); saveLocal(); };
  renderAll();
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
}
function startTimelineDrag(e) {
  e.preventDefault(); e.stopPropagation();
  const clip = e.currentTarget, rect = clip.getBoundingClientRect();
  const edge = e.clientX - rect.left < 7 ? "resizeStart" : rect.right - e.clientX < 7 ? "resizeEnd" : "move";
  pushUndo();
  if (clip.dataset.type === "audio") {
    const m = state.media;
    drag = { kind: "timeline-audio", edge, originX: e.clientX, originalProjectStart: m.projectStart || 0, originalOffset: m.offset || 0, originalDuration: m.duration };
    window.addEventListener("pointermove", onTimelineDrag); window.addEventListener("pointerup", endTimelineDrag, { once: true });
    return;
  }
  const item = timelineItem(clip.dataset.type, clip.dataset.id);
  if (!item) return;
  if (!state.selectedTimelineItems.includes(item.id)) state.selectedTimelineItems = [item.id];
  const items = edge === "move" ? state.selectedTimelineItems.map(timelineItemById).filter(Boolean).map((value) => ({ item: value, start: value.start })) : [{ item, start: item.start }];
  drag = { kind: "timeline", edge, item, items, minStart: Math.min(...items.map((value) => value.start)), originX: e.clientX, originalStart: item.start, originalDuration: item.duration };
  if (clip.dataset.type === "node") { selectNode(item.id); focusCanvasOnNode(item.id); } else selectLine(item.id);
  window.addEventListener("pointermove", onTimelineDrag); window.addEventListener("pointerup", endTimelineDrag, { once: true });
}
function snapTime(value) { return Math.max(0, Math.round(value * 10) / 10); }
function audioTimeAtPlayhead() {
  const m = state.media; if (!m) return 0;
  return Math.max(0, state.playhead - (m.projectStart || 0) + (m.offset || 0));
}
function onTimelineDrag(e) {
  if (!drag) return;
  if (drag.kind === "timeline-audio") {
    const delta = (e.clientX - drag.originX) / TIMELINE_PX_PER_SECOND, minDur = 0.1, m = state.media;
    if (drag.edge === "move") {
      m.projectStart = Math.max(0, snapTime(drag.originalProjectStart + delta));
    } else if (drag.edge === "resizeStart") {
      const d = clamp(delta, -drag.originalProjectStart, drag.originalDuration - minDur);
      m.projectStart = Math.max(0, snapTime(drag.originalProjectStart + d));
      m.offset = Math.max(0, snapTime(drag.originalOffset + d));
      m.duration = Math.max(minDur, snapTime(drag.originalDuration - d));
    } else if (drag.edge === "resizeEnd") {
      const maxDur = (m.fileDuration || Infinity) - (m.offset || 0);
      m.duration = Math.max(minDur, Math.min(maxDur, snapTime(drag.originalDuration + delta)));
    }
    renderTimeline(); return;
  }
  if (drag.kind !== "timeline") return;
  const delta = (e.clientX - drag.originX) / TIMELINE_PX_PER_SECOND, minDuration = 0.1;
  if (drag.edge === "move") { const adjusted = Math.max(delta, -drag.minStart); drag.items.forEach((value) => value.item.start = snapTime(value.start + adjusted)); }
  if (drag.edge === "resizeStart") {
    const end = drag.originalStart + drag.originalDuration;
    drag.item.start = snapTime(Math.min(end - minDuration, drag.originalStart + delta));
    drag.item.duration = Math.max(minDuration, end - drag.item.start);
  }
  if (drag.edge === "resizeEnd") drag.item.duration = Math.max(minDuration, snapTime(drag.originalDuration + delta));
  renderTimeline(); renderProperties(); renderCanvas();
}
function endTimelineDrag() { window.removeEventListener("pointermove", onTimelineDrag); drag = null; renderAll(); saveLocal(); }
function focusCanvasOnNode(nodeId) {
  const node = nodeById(nodeId); if (!node) return;
  requestAnimationFrame(() => { const viewport = $("canvasViewport"); viewport.scrollTo({ left: Math.max(0, (node.x + node.width / 2) * state.zoom - viewport.clientWidth / 2), top: Math.max(0, (node.y + node.height / 2) * state.zoom - viewport.clientHeight / 2), behavior: "smooth" }); });
}
function applyTemplate(name) {
  const t = templates[name]; state.selectedNodes.map(nodeById).filter(Boolean).forEach((n) => Object.assign(n, t, { template: name }));
}
function alignSelected(mode) {
  const nodes = state.selectedNodes.map(nodeById).filter(Boolean);
  if (nodes.length < 2) return showToast("請先多選至少兩個節點。");
  commit(() => {
    if (mode === "left") { const x = Math.min(...nodes.map((n) => n.x)); nodes.forEach((n) => n.x = x); }
    if (mode === "center") { const center = nodes.reduce((sum, n) => sum + n.x + n.width / 2, 0) / nodes.length; nodes.forEach((n) => n.x = center - n.width / 2); }
    if (mode === "right") { const right = Math.max(...nodes.map((n) => n.x + n.width)); nodes.forEach((n) => n.x = right - n.width); }
    if (mode === "top") { const y = Math.min(...nodes.map((n) => n.y)); nodes.forEach((n) => n.y = y); }
    if (mode === "middle") { const middle = nodes.reduce((sum, n) => sum + n.y + n.height / 2, 0) / nodes.length; nodes.forEach((n) => n.y = middle - n.height / 2); }
    if (mode === "bottom") { const bottom = Math.max(...nodes.map((n) => n.y + n.height)); nodes.forEach((n) => n.y = bottom - n.height); }
    if (mode === "distributeH") {
      const sorted = [...nodes].sort((a, b) => a.x - b.x), left = sorted[0].x, right = sorted[sorted.length - 1].x;
      sorted.forEach((n, i) => n.x = left + (right - left) * i / (sorted.length - 1));
    }
    if (mode === "distributeV") {
      const sorted = [...nodes].sort((a, b) => a.y - b.y), top = sorted[0].y, bottom = sorted[sorted.length - 1].y;
      sorted.forEach((n, i) => n.y = top + (bottom - top) * i / (sorted.length - 1));
    }
  });
}
function addNode() {
  commit(() => {
    const integers = state.nodes.filter((n) => !n.number.includes(".")).map((n) => Number(n.number));
    const number = String(Math.max(0, ...integers) + 1), node = makeNode({ number, text: "新節點" }, state.nodes.length);
    node.x = state.canvas.width / 2 - node.width / 2; node.y = state.canvas.height / 2 - node.height / 2; state.nodes.push(node); state.timelineOrder.push(node.id); state.selectedNodes = [node.id]; state.selectedLine = null;
  });
}
function addLine() {
  if (state.nodes.length < 2) return showToast("至少需要兩個節點。");
  linkMode = !linkMode;
  linkSourceId = null; linkPreview = null;
  $("addLineBtn").classList.toggle("primary", linkMode);
  document.body.classList.toggle("link-mode", linkMode);
  $("canvasHint").textContent = linkMode ? "連接線模式：點來源節點，再點目標節點；也可直接拖拉。按按鈕退出。" : "空白拖曳框選；中鍵拖曳平移；滾輪縮放；Shift 加選；Ctrl 減選。";
  renderCanvas();
}
function addControlPoint() {
  const line = lineById(state.selectedLine); if (!line) return showToast("請先選取連接線。");
  commit(() => {
    const from = nodeById(line.from), to = nodeById(line.to), a = edgePoint(from, line.startAnchor), b = edgePoint(to, line.endAnchor);
    line.type = "curve"; line.controlPoints.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); selectedControlPoint = line.controlPoints.length - 1;
  });
}
function deleteControlPoint() {
  const line = lineById(state.selectedLine); if (!line || selectedControlPoint === null) return showToast("請先點選要刪除的曲線控制點。");
  commit(() => { line.controlPoints.splice(selectedControlPoint, 1); selectedControlPoint = null; if (!line.controlPoints.length) line.type = "straight"; });
}
function deleteSelected() {
  if (!state.selectedNodes.length && !state.selectedLine) return;
  commit(() => {
    if (state.selectedLine) state.lines = state.lines.filter((l) => l.id !== state.selectedLine);
    if (state.selectedNodes.length) { const ids = new Set(state.selectedNodes); state.nodes = state.nodes.filter((n) => !ids.has(n.id)); state.lines = state.lines.filter((l) => !ids.has(l.from) && !ids.has(l.to)); }
    const currentIds = [...state.nodes, ...state.lines].map((item) => item.id);
    state.timelineOrder = state.timelineOrder.filter((itemId) => currentIds.includes(itemId)); state.selectedTimelineItems = state.selectedTimelineItems.filter((itemId) => currentIds.includes(itemId));
    state.selectedNodes = []; state.selectedLine = null; document.body.classList.remove("line-editing");
  });
}
function play() {
  if (state.playing) { state.playing = false; shuttleSpeed = 0; $("playBtn").textContent = "播放"; if (state.media?.element) state.media.element.pause(); return; }
  if (state.playhead >= totalDuration()) state.playhead = 0;
  state.playing = true; playStartedAt = performance.now(); playBase = state.playhead; shuttleSpeed = 0; $("playBtn").textContent = "暫停";
  if (state.media?.src) {
    if (!state.media.element || state.media.element.error) {
      if (state.media.type === "audio") state.media.element = new Audio(state.media.src);
      else { const v = document.createElement("video"); v.src = state.media.src; state.media.element = v; }
      state.media.element.load();
    }
    const el = state.media.element;
    el.currentTime = audioTimeAtPlayhead();
    el.play().catch(() => {});
  }
  requestAnimationFrame(tick);
}
function tick(now) {
  if (!state.playing) return;
  const dt = (now - playStartedAt) / 1000;
  if (shuttleSpeed !== 0) {
    state.playhead += shuttleSpeed * dt;
    if (state.media?.element && !state.media.element.paused) {
      if (shuttleSpeed > 0) state.media.element.playbackRate = shuttleSpeed;
      else state.media.element.pause();
    }
    if (state.playhead < 0 || state.playhead > totalDuration()) {
      state.playhead = clamp(state.playhead, 0, totalDuration());
      state.playing = false; shuttleSpeed = 0; $("playBtn").textContent = "播放";
      if (state.media?.element) try { state.media.element.pause(); } catch (_) {}
    }
  } else {
    state.playhead = playBase + dt;
    if (state.media?.element) state.media.element.playbackRate = 1;
    if (state.playhead >= totalDuration()) {
      state.playhead = totalDuration(); state.playing = false; $("playBtn").textContent = "播放";
      if (state.media?.element) try { state.media.element.pause(); } catch (_) {}
    }
  }
  playStartedAt = now;
  if (shuttleSpeed === 0) playBase = state.playhead;
  renderCanvas(); renderTimeline(); if (state.playing) requestAnimationFrame(tick);
}
function stop() { state.playing = false; shuttleSpeed = 0; state.playhead = 0; if (state.media?.element) try { state.media.element.pause(); state.media.element.currentTime = 0; } catch (_) {} $("playBtn").textContent = "播放"; renderAll(); }
async function extractWaveform(blob, samples = 2000) {
  try {
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, samples, 44100);
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const raw = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(raw.length / samples));
    const waveform = [];
    for (let i = 0; i < samples; i++) {
      const start = i * step;
      const end = Math.min(start + step, raw.length);
      let peak = 0;
      for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(raw[j]));
      waveform.push(peak);
    }
    const max = Math.max(...waveform, 0.01);
    return waveform.map((v) => v / max);
  } catch (_) { return []; }
}
function subtitleAtTime(time) { return state.subtitles.find((s) => time >= s.start && time < s.end); }
function download(name, blob) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function zipNumber(value, bytes) { const data = new Uint8Array(bytes); for (let i = 0; i < bytes; i++) data[i] = value >>> (i * 8) & 255; return data; }
function zipConcat(parts) { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; parts.forEach((part) => { result.set(part, offset); offset += part.length; }); return result; }
function crc32(data) {
  let crc = -1;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ -1) >>> 0;
}
function createZip(files) {
  const encoder = new TextEncoder(), localParts = [], centralParts = []; let offset = 0;
  files.forEach(({ name, data }) => {
    const filename = encoder.encode(name), checksum = crc32(data);
    const local = zipConcat([zipNumber(0x04034b50, 4), zipNumber(20, 2), zipNumber(0, 2), zipNumber(0, 2), zipNumber(0, 2), zipNumber(0, 2), zipNumber(checksum, 4), zipNumber(data.length, 4), zipNumber(data.length, 4), zipNumber(filename.length, 2), zipNumber(0, 2), filename, data]);
    const central = zipConcat([zipNumber(0x02014b50, 4), zipNumber(20, 2), zipNumber(20, 2), zipNumber(0, 2), zipNumber(0, 2), zipNumber(0, 2), zipNumber(0, 2), zipNumber(checksum, 4), zipNumber(data.length, 4), zipNumber(data.length, 4), zipNumber(filename.length, 2), zipNumber(0, 2), zipNumber(0, 2), zipNumber(0, 2), zipNumber(0, 2), zipNumber(0, 4), zipNumber(offset, 4), filename]);
    localParts.push(local); centralParts.push(central); offset += local.length;
  });
  const central = zipConcat(centralParts), end = zipConcat([zipNumber(0x06054b50, 4), zipNumber(0, 2), zipNumber(0, 2), zipNumber(files.length, 2), zipNumber(files.length, 2), zipNumber(central.length, 4), zipNumber(offset, 4), zipNumber(0, 2)]);
  return new Blob([...localParts, central, end], { type: "application/zip" });
}
function saveProject() { download("流程圖動畫專案.json", new Blob([JSON.stringify(state, null, 2)], { type: "application/json" })); }
function saveLayout() {
  const layout = { sourceText: state.sourceText, nodes: state.nodes, lines: state.lines, canvas: state.canvas, timelineOrder: state.timelineOrder, showNumbers: state.showNumbers };
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); showToast("已儲存目前版面。");
}
function loadLayout() {
  const raw = localStorage.getItem(LAYOUT_STORAGE_KEY); if (!raw) return showToast("尚未儲存版面。");
  commit(() => { const layout = JSON.parse(raw); Object.assign(state, clone(layout), { selectedNodes: [], selectedLine: null, selectedTimelineItems: [], playing: false }); upgradeState(); });
  document.body.classList.remove("line-editing"); showToast("已載入儲存版面。");
}
async function loadFile(file, asProject = false) {
  const content = await file.text();
  if (asProject) { pushUndo(); state = JSON.parse(content); upgradeState(); renderAll(); saveLocal(); showToast("專案已載入。"); }
  else { state.sourceText = content; buildGraph(); $("textFile").value = ""; }
}
function canvasFromSvg() {
  renderCanvas(false);
  const svg = $("canvasSvg"), cloneSvg = svg.cloneNode(true); cloneSvg.style.width = `${state.canvas.width}px`; cloneSvg.style.height = `${state.canvas.height}px`;
  const data = new XMLSerializer().serializeToString(cloneSvg), img = new Image(), canvas = document.createElement("canvas");
  canvas.width = state.canvas.width; canvas.height = state.canvas.height;
  renderCanvas(true);
  return new Promise((resolve, reject) => { img.onload = () => { canvas.getContext("2d").drawImage(img, 0, 0); resolve(canvas); }; img.onerror = reject; img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`; });
}
async function exportPngSequence() {
  const fps = clamp(Number($("fps").value) || 30, 1, 60), total = totalDuration(), previous = state.playhead, lastFrame = Math.ceil(total * fps), files = [];
  showToast(`正在建立 ${lastFrame + 1} 張透明 PNG，完成後會下載一個 ZIP。`);
  for (let i = 0; i <= lastFrame; i++) {
    state.playhead = i / fps; renderCanvas(); const canvas = await canvasFromSvg();
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG 編碼失敗")), "image/png"));
    files.push({ name: `frame-${String(i).padStart(5, "0")}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    if (i % 10 === 0) { showToast(`正在建立透明 PNG：${i + 1} / ${lastFrame + 1}`); await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  download("透明PNG序列.zip", createZip(files));
  state.playhead = previous; renderAll(); showToast(`PNG 序列輸出完成，共 ${files.length} 張。`);
}
async function downloadResolveMov(blob, fps) {
  const healthController = new AbortController(), healthTimer = setTimeout(() => healthController.abort(), 2500);
  try {
    const health = await fetch("/api/health", { cache: "no-store", signal: healthController.signal });
    if (!health.ok) throw new Error("Resolve 轉檔服務未啟動");
  } finally {
    clearTimeout(healthTimer);
  }
  showToast("正在使用 FFmpeg 轉換 Resolve 相容 MOV，請勿關閉頁面。");
  const response = await fetch(`/api/resolve-export?fps=${fps}`, { method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob });
  if (!response.ok) throw new Error(`Resolve MOV 轉換失敗：${response.status}`);
  download("流程圖動畫-Resolve相容.mov", await response.blob());
}
async function exportVideo() {
  if (exportingVideo) return showToast("影片仍在輸出中，請稍候。");
  if (!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return showToast("此瀏覽器不支援影片輸出，請改用 Edge 或 Chrome。");
  exportingVideo = true;
  const button = $("exportVideoBtn"), originalButtonText = button.textContent, fps = clamp(Number($("fps").value) || 30, 1, 60), previous = state.playhead, total = totalDuration(), canvas = document.createElement("canvas");
  let stream;
  button.disabled = true;
  try {
    canvas.width = state.canvas.width; canvas.height = state.canvas.height;
    const ctx = canvas.getContext("2d"); stream = canvas.captureStream(fps);
    const allowMp4 = state.canvas.backgroundType !== "transparent", mp4 = allowMp4 && MediaRecorder.isTypeSupported("video/mp4;codecs=avc1") ? "video/mp4;codecs=avc1" : allowMp4 && MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "";
    const mimeType = mp4 || "video/webm;codecs=vp9", chunks = [], recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = () => showToast("影片錄製器發生錯誤。");
    recorder.start(1000);
    await new Promise((resolve) => setTimeout(resolve, 120));
    showToast("正在輸出影片，請勿關閉頁面。");
    const frames = Math.ceil(total * fps);
    for (let i = 0; i <= frames; i++) {
      state.playhead = i / fps; renderCanvas(); const source = await canvasFromSvg(); ctx.save(); ctx.clearRect(0, 0, canvas.width, canvas.height); if (state.canvas.backgroundType !== "transparent") { ctx.fillStyle = state.canvas.color1; ctx.fillRect(0, 0, canvas.width, canvas.height); } ctx.drawImage(source, 0, 0); ctx.restore();
      if (i % Math.max(1, fps) === 0 || i === frames) { button.textContent = `輸出中 ${Math.round(i / Math.max(1, frames) * 100)}%`; showToast(`正在輸出影片：${i + 1} / ${frames + 1} 格`); }
      await new Promise((resolve) => setTimeout(resolve, 1000 / fps));
    }
    button.textContent = "正在完成輸出";
    showToast("正在完成影片尾端，請稍候。");
    await new Promise((resolve) => setTimeout(resolve, Math.max(500, 1000 / fps * 3)));
    recorder.requestData();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await new Promise((resolve, reject) => { recorder.onerror = () => reject(recorder.error || new Error("影片錄製失敗")); recorder.onstop = resolve; recorder.stop(); });
    const ext = mp4 ? "mp4" : "webm", blob = new Blob(chunks, { type: mimeType });
    try {
      await downloadResolveMov(blob, fps);
      showToast("Resolve 相容 MOV 輸出完成。");
    } catch (_) {
      download(`流程圖動畫-原始.${ext}`, blob);
      showToast(`無法自動轉換，已下載瀏覽器版 ${ext.toUpperCase()}。`);
    }
  } catch (error) {
    showToast(`影片輸出失敗：${error.message}`);
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    button.disabled = false; button.textContent = originalButtonText; exportingVideo = false;
    state.playhead = previous; renderAll();
  }
}

$("autoLayoutBtn").onclick = () => autoLayout(true); $("undoBtn").onclick = undo; $("redoBtn").onclick = redo;
$("addNodeBtn").onclick = addNode; $("addLineBtn").onclick = addLine; $("deleteBtn").onclick = deleteSelected; $("saveBtn").onclick = saveProject; $("saveLayoutBtn").onclick = saveLayout; $("loadLayoutBtn").onclick = loadLayout;
$("addControlPointBtn").onclick = addControlPoint; $("deleteControlPointBtn").onclick = deleteControlPoint;
$("alignLeftBtn").onclick = () => alignSelected("left"); $("alignCenterBtn").onclick = () => alignSelected("center"); $("alignRightBtn").onclick = () => alignSelected("right"); $("alignTopBtn").onclick = () => alignSelected("top"); $("alignMiddleBtn").onclick = () => alignSelected("middle"); $("alignBottomBtn").onclick = () => alignSelected("bottom");
$("distributeHBtn").onclick = () => alignSelected("distributeH"); $("distributeVBtn").onclick = () => alignSelected("distributeV");
$("textFile").onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]); $("projectFile").onchange = (e) => e.target.files[0] && loadFile(e.target.files[0], true);
$("newBtn").onclick = () => {
  const ui = clone(state.ui || defaultState().ui); pushUndo(); state = defaultState(); state.ui = ui; undoStack = []; redoStack = []; linkMode = false; linkSourceId = null; linkPreview = null; selectionRect = null; selectedControlPoint = null;
  document.body.classList.remove("line-editing", "link-mode"); $("parseErrors").textContent = ""; $("textFile").value = ""; $("projectFile").value = ""; renderAll(); saveLocal(); showToast("已建立乾淨的新專案，請匯入文字檔。");
};
$("playBtn").onclick = play; $("stopBtn").onclick = stop; $("playheadLeftBtn").onclick = () => nudgePlayhead(-0.1); $("playheadRightBtn").onclick = () => nudgePlayhead(0.1); $("exportPngBtn").onclick = exportPngSequence; $("exportVideoBtn").onclick = exportVideo;
$("playhead").oninput = (e) => { state.playhead = Number(e.target.value); if (state.media?.element) try { state.media.element.currentTime = audioTimeAtPlayhead(); } catch (_) {} renderCanvas(); renderTimeline(); };
$("timeline").addEventListener("pointerdown", (e) => { if (e.target === $("timeline") || e.target.classList.contains("track-lane")) startTimelineMarquee(e); });
$("timeline").addEventListener("scroll", renderTimelinePlayhead);
$("timeline").addEventListener("wheel", zoomTimelineAtWheel, { passive: false });
$("canvasViewport").addEventListener("wheel", zoomCanvasAtPointer, { passive: false });
$("canvasViewport").addEventListener("dblclick", (e) => {
  if (e.target !== $("canvasSvg")) return;
  state.ui.canvasPanX = 0; state.ui.canvasPanY = 0;
  fitCanvasToViewport(false); renderCanvas(); saveLocal();
});
$("leftSplitter").addEventListener("pointerdown", (e) => startPanelResize("left", e)); $("rightSplitter").addEventListener("pointerdown", (e) => startPanelResize("right", e)); $("timelineSplitter").addEventListener("pointerdown", (e) => startPanelResize("timeline", e));
$("showNumbers").onchange = (e) => commit(() => state.showNumbers = e.target.checked);
$("zoomRange").oninput = (e) => { state.zoom = Number(e.target.value) / 100; renderAll(); };
$("fitBtn").onclick = () => { fitCanvasToViewport(true); renderAll(); };
$("resetPanBtn").onclick = () => { state.ui.canvasPanX = 0; state.ui.canvasPanY = 0; fitCanvasToViewport(false); renderCanvas(); saveLocal(); };
$("canvasPreset").onchange = (e) => { if (e.target.value === "custom") return; const [width, height] = e.target.value.split("x").map(Number); commit(() => Object.assign(state.canvas, { width, height })); };
bindLive("canvasWidth", (v) => state.canvas.width = Number(v)); bindLive("canvasHeight", (v) => state.canvas.height = Number(v));
bindValue("backgroundType", (v) => state.canvas.backgroundType = v); bindValue("backgroundColor1", (v) => state.canvas.color1 = v); bindValue("backgroundColor2", (v) => state.canvas.color2 = v);
$("backgroundImage").onchange = (e) => { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => commit(() => { state.canvas.image = reader.result; state.canvas.backgroundType = "image"; }); reader.readAsDataURL(file); };
$("clearBackgroundImageBtn").onclick = () => commit(() => { state.canvas.image = ""; if (state.canvas.backgroundType === "image") state.canvas.backgroundType = "solid"; $("backgroundImage").value = ""; });
$("audioFile").onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    const audio = new Audio(dataUrl);
    audio.onloadedmetadata = async () => {
      const waveform = await extractWaveform(file);
      commit(() => { state.media = { type: "audio", src: dataUrl, duration: audio.duration, fileDuration: audio.duration, element: audio, blob: file, waveform }; });
      showToast(`已匯入音訊：${file.name}，長度 ${audio.duration.toFixed(2)} 秒`);
      $("audioFile").value = ""; renderAll();
    };
    audio.onerror = () => showToast("音訊載入失敗");
  };
  reader.readAsDataURL(file);
};
$("videoFile").onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const video = document.createElement("video");
    video.src = dataUrl;
    video.onloadedmetadata = () => {
      commit(() => { state.media = { type: "video", src: dataUrl, duration: video.duration, element: video }; });
      showToast(`已匯入影片：${file.name}，長度 ${video.duration.toFixed(2)} 秒`);
      $("videoFile").value = ""; renderAll();
    };
    video.onerror = () => showToast("影片載入失敗");
  };
  reader.readAsDataURL(file);
};
bindNodeValue("nodeText", "text"); bindValue("nodeShape", applyNodeShape); bindNodeValue("nodeFillMode", "fillMode"); bindNodeValue("nodeFill1", "fill1"); bindNodeValue("nodeFill2", "fill2");
bindNodeValue("nodeStrokeMode", "strokeMode"); bindNodeValue("nodeStroke", "stroke"); bindNodeValue("nodeStroke2", "stroke2"); bindNodeValue("nodeTextColor", "textColor"); bindNodeValue("nodeTextStroke", "textStroke"); bindNodeValue("nodeFont", "font");
bindNodeValue("nodeEffect", "effect"); bindNodeValue("nodeEasing", "easing"); bindValue("nodeTemplate", applyTemplate);
["nodeWidth", "nodeWidthRange"].forEach((key) => bindLive(key, (value) => state.selectedNodes.map(nodeById).filter(Boolean).forEach((node) => applyNodeGeometry(node, "width", value))));
["nodeHeight", "nodeHeightRange"].forEach((key) => bindLive(key, (value) => state.selectedNodes.map(nodeById).filter(Boolean).forEach((node) => applyNodeGeometry(node, "height", value))));
["nodeRadius", "nodeRadiusRange"].forEach((key) => bindLive(key, (value) => state.selectedNodes.map(nodeById).filter(Boolean).forEach((node) => { node.shape = "rounded"; node.radius = Math.min(Number(value), Math.max(0, Math.min(node.width, node.height) / 3)); })));
[["nodeStrokeWidth", "strokeWidth"], ["nodeFontSize", "fontSize"], ["nodeTextStrokeWidth", "textStrokeWidth"], ["nodeStart", "start"], ["nodeDuration", "duration"]].forEach(([control, key]) => bindLive(control, (value) => state.selectedNodes.map(nodeById).filter(Boolean).forEach((node) => node[key] = Number(value))));
bindLineValue("lineFrom", "from"); bindLineValue("lineTo", "to"); bindLineValue("lineColor", "color"); bindLineValue("lineDash", "dash");
["lineWidth", "lineWidthRange"].forEach((key) => bindLive(key, (value) => { const line = lineById(state.selectedLine); if (line) line.width = Number(value); }));
bindLive("lineMarkerSize", (value) => { const line = lineById(state.selectedLine); if (line) line.markerSize = Number(value); });
bindLineValue("lineType", "type"); bindValue("lineArrow", (value) => { const line = lineById(state.selectedLine); if (!line) return; line.arrow = value; if (value === "start" && line.startMarker === "none") line.startMarker = "arrow"; if (value === "end" && line.endMarker === "none") line.endMarker = "arrow"; if (value === "both") { if (line.startMarker === "none") line.startMarker = "arrow"; if (line.endMarker === "none") line.endMarker = "arrow"; } }); bindLineValue("lineStartMarker", "startMarker"); bindLineValue("lineEndMarker", "endMarker"); bindLineValue("lineEffect", "effect"); bindLineValue("lineEasing", "easing");
[["lineStart", "start"], ["lineDuration", "duration"]].forEach(([control, key]) => bindLive(control, (value) => { const line = lineById(state.selectedLine); if (line) line[key] = Number(value); }));
window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName || "";
  const inInput = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  if (e.key === "Delete" && !["INPUT", "TEXTAREA"].includes(tag)) deleteSelected();
  if (e.key === "Escape") { state.selectedNodes = []; state.selectedLine = null; linkMode = false; linkSourceId = null; linkPreview = null; $("addLineBtn").classList.remove("primary"); document.body.classList.remove("line-editing", "link-mode"); renderAll(); }
  // Space toggles play even when a range/non-text input has focus
  if (e.code === "Space" && !e.repeat) {
    const inTextEntry = tag === "TEXTAREA" || (tag === "INPUT" && !["range", "checkbox", "radio", "button"].includes(document.activeElement?.type));
    if (!inTextEntry) { e.preventDefault(); spacePressed = true; document.body.classList.add("space-pan"); play(); return; }
  }
  if (inInput) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); nudgePlayhead(-0.1); }
  if (e.key === "ArrowRight") { e.preventDefault(); nudgePlayhead(0.1); }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "ArrowUp") { e.preventDefault(); selectRelativeTimelineLayer(-1); }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "ArrowDown") { e.preventDefault(); selectRelativeTimelineLayer(1); }
  if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === "ArrowUp") { e.preventDefault(); moveTimelineLayer(-1); }
  if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === "ArrowDown") { e.preventDefault(); moveTimelineLayer(1); }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === "BracketLeft") { e.preventDefault(); alignSelectedTimelineStartToPlayhead(); }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === "BracketRight") { e.preventDefault(); alignSelectedTimelineEndToPlayhead(); }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === "KeyI") { e.preventDefault(); movePlayheadToSelectedTimelineEdge("start"); }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === "KeyO") { e.preventDefault(); movePlayheadToSelectedTimelineEdge("end"); }
  // JKL shuttle
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === "KeyJ") {
    e.preventDefault();
    shuttleSpeed = shuttleSpeed <= 0 ? shuttleSpeed - 1 : -1;
    state.playing = true; playStartedAt = performance.now();
    if (state.media?.src && state.media.element?.paused) { state.media.element.play().catch(() => {}); }
    if (shuttleSpeed < 0) $("playBtn").textContent = `⏪ ${Math.abs(shuttleSpeed)}x`;
    requestAnimationFrame(tick);
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === "KeyK") {
    e.preventDefault(); shuttleSpeed = 0;
    state.playing = false; $("playBtn").textContent = "播放";
    if (state.media?.element) { try { state.media.element.pause(); } catch (_) {} }
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === "KeyL") {
    e.preventDefault();
    shuttleSpeed = shuttleSpeed >= 0 ? shuttleSpeed + 1 : 1;
    state.playing = true; playStartedAt = performance.now();
    if (state.media?.src && state.media.element?.paused) { state.media.element.play().catch(() => {}); }
    if (shuttleSpeed > 0) $("playBtn").textContent = `⏩ ${shuttleSpeed}x`;
    requestAnimationFrame(tick);
  }
});
window.addEventListener("keyup", (e) => { if (e.code === "Space") { spacePressed = false; document.body.classList.remove("space-pan"); } });
window.addEventListener("blur", () => { spacePressed = false; document.body.classList.remove("space-pan"); });
window.addEventListener("resize", () => {
  cancelAnimationFrame(uiResizeFrame);
  uiResizeFrame = requestAnimationFrame(() => { applyUiSizes(); fitCanvasToViewport(); renderCanvas(); renderBackgroundInputs(); renderTimelinePlayhead(); });
});
try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) state = JSON.parse(saved); } catch (_) {}
populateFonts(); upgradeState();
renderAll();
requestAnimationFrame(() => { fitCanvasToViewport(); renderCanvas(); renderBackgroundInputs(); });

// ── Recording modal ──────────────────────────────────────────────────────────
let recStream = null, recMediaRecorder = null, recChunks = [], recBlob = null;
let recTimerInterval = null, recStartedAt = 0, recPausedMs = 0, recPauseTs = 0;
let recAudioCtx = null, recVolFrame = null, recPreviewAudio = null;

function openRecordModal() {
  $("recordModal").classList.remove("hidden");
  refreshMics();
}
function closeRecordModal() {
  stopRecordingNow();
  if (recPreviewAudio) { recPreviewAudio.pause(); URL.revokeObjectURL(recPreviewAudio.src); recPreviewAudio = null; }
  recBlob = null; recChunks = [];
  $("recordModal").classList.add("hidden");
  $("recStartBtn").classList.remove("hidden");
  ["recPauseBtn", "recResumeBtn", "recStopBtn"].forEach((btnId) => $(btnId).classList.add("hidden"));
  $("recPreview").classList.add("hidden");
  $("recDownloadBtn").disabled = true;
  $("recConfirmBtn").disabled = true;
  $("recTimer").textContent = "00:00.0";
  $("recSubtitlesList").innerHTML = "";
  $("recInterim").textContent = "";
  $("volumeFill").style.width = "0%";
  $("micStatus").textContent = "尚未偵測";
}
$("recordBtn").onclick = openRecordModal;
$("recCancelBtn").onclick = closeRecordModal;

// Draggable modal via title bar
(function () {
  const modal = $("recordModal"), content = modal.querySelector(".modal-content"), handle = modal.querySelector("h2");
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const rect = content.getBoundingClientRect();
    // Switch from transform centering to absolute positioning on first drag
    content.style.transform = "none";
    content.style.left = rect.left + "px";
    content.style.top = rect.top + "px";
    const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
    const move = (ev) => {
      content.style.left = clamp(ev.clientX - ox, 0, innerWidth - rect.width) + "px";
      content.style.top  = clamp(ev.clientY - oy, 0, innerHeight - rect.height) + "px";
    };
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", () => handle.removeEventListener("pointermove", move), { once: true });
  });
})();

async function refreshMics() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    $("micSelect").innerHTML = mics.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.label || "麥克風")}</option>`).join("");
    $("micStatus").textContent = `偵測到 ${mics.length} 個麥克風`;
  } catch (err) {
    $("micStatus").textContent = `無法存取麥克風：${err.message}`;
  }
}
$("micRefreshBtn").onclick = refreshMics;

function formatRecTime(ms) {
  const s = ms / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;
}
function startVolumeMeter(stream) {
  recAudioCtx = new AudioContext();
  const analyser = recAudioCtx.createAnalyser();
  analyser.fftSize = 256;
  recAudioCtx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  (function tick() {
    recVolFrame = requestAnimationFrame(tick);
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    $("volumeFill").style.width = `${Math.min(100, avg * 2.5)}%`;
  })();
}
function stopRecordingNow() {
  if (recMediaRecorder && recMediaRecorder.state !== "inactive") recMediaRecorder.stop();
  clearInterval(recTimerInterval);
  cancelAnimationFrame(recVolFrame);
  if (recAudioCtx) { recAudioCtx.close().catch(() => {}); recAudioCtx = null; }
  if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
  $("volumeFill").style.width = "0%";
}

$("recStartBtn").onclick = async () => {
  try {
    const deviceId = $("micSelect").value;
    recStream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    recChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    recMediaRecorder = new MediaRecorder(recStream, { mimeType });
    recMediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recMediaRecorder.onstop = onRecStop;
    recMediaRecorder.start(100);
    recStartedAt = Date.now(); recPausedMs = 0;
    recTimerInterval = setInterval(() => {
      $("recTimer").textContent = formatRecTime(Date.now() - recStartedAt - recPausedMs);
    }, 100);
    startVolumeMeter(recStream);
    $("recStartBtn").classList.add("hidden");
    $("recPauseBtn").classList.remove("hidden");
    $("recStopBtn").classList.remove("hidden");
    $("micStatus").textContent = "錄音中…";
  } catch (err) {
    $("micStatus").textContent = `錄音失敗：${err.message}`;
  }
};
$("recPauseBtn").onclick = () => {
  if (recMediaRecorder?.state === "recording") {
    recMediaRecorder.pause(); recPauseTs = Date.now();
    clearInterval(recTimerInterval);
    $("recPauseBtn").classList.add("hidden"); $("recResumeBtn").classList.remove("hidden");
    $("micStatus").textContent = "已暫停";
  }
};
$("recResumeBtn").onclick = () => {
  if (recMediaRecorder?.state === "paused") {
    recMediaRecorder.resume(); recPausedMs += Date.now() - recPauseTs;
    recTimerInterval = setInterval(() => {
      $("recTimer").textContent = formatRecTime(Date.now() - recStartedAt - recPausedMs);
    }, 100);
    $("recResumeBtn").classList.add("hidden"); $("recPauseBtn").classList.remove("hidden");
    $("micStatus").textContent = "錄音中…";
  }
};
$("recStopBtn").onclick = stopRecordingNow;

function onRecStop() {
  recBlob = new Blob(recChunks, { type: recMediaRecorder.mimeType });
  $("recPauseBtn").classList.add("hidden"); $("recResumeBtn").classList.add("hidden"); $("recStopBtn").classList.add("hidden");
  $("recStartBtn").classList.remove("hidden");
  $("recDownloadBtn").disabled = false; $("recConfirmBtn").disabled = false;
  $("micStatus").textContent = "錄音完成";
  if (recPreviewAudio) { recPreviewAudio.pause(); URL.revokeObjectURL(recPreviewAudio.src); }
  recPreviewAudio = new Audio(URL.createObjectURL(recBlob));
  recPreviewAudio.onloadedmetadata = () => { $("recTrimEnd").value = recPreviewAudio.duration.toFixed(2); $("recTrimStart").value = "0"; };
  recPreviewAudio.ontimeupdate = () => {
    const d = recPreviewAudio.duration || 0, t = recPreviewAudio.currentTime;
    $("previewTime").textContent = `${t.toFixed(2)} / ${d.toFixed(2)}`;
    if (d) $("previewSeek").value = (t / d) * 100;
  };
  recPreviewAudio.onended = () => { $("previewPlayBtn").classList.remove("hidden"); $("previewPauseBtn").classList.add("hidden"); };
  $("recPreview").classList.remove("hidden");
}

$("previewPlayBtn").onclick = () => { recPreviewAudio?.play(); $("previewPlayBtn").classList.add("hidden"); $("previewPauseBtn").classList.remove("hidden"); };
$("previewPauseBtn").onclick = () => { recPreviewAudio?.pause(); $("previewPauseBtn").classList.add("hidden"); $("previewPlayBtn").classList.remove("hidden"); };
$("previewSeek").oninput = () => { if (recPreviewAudio?.duration) recPreviewAudio.currentTime = (Number($("previewSeek").value) / 100) * recPreviewAudio.duration; };
$("trimToPreviewBtn").onclick = () => { if (recPreviewAudio) $("recTrimEnd").value = recPreviewAudio.currentTime.toFixed(2); };
$("recDownloadBtn").onclick = async () => {
  if (!recBlob) return;
  try {
    const form = new FormData();
    form.append("audio", recBlob, "recording.webm");
    const res = await fetch("http://127.0.0.1:8765/api/convert-audio?format=mp3", { method: "POST", body: form });
    if (!res.ok) throw new Error("server error");
    download(`錄音_${Date.now()}.mp3`, await res.blob());
  } catch {
    download(`錄音_${Date.now()}.webm`, recBlob);
    showToast("MP3 轉換需啟動 start.ps1，已改下載 WebM 格式。");
  }
};

$("recTranscribeBtn").onclick = async () => {
  if (!recBlob) return showToast("請先完成錄音。");
  $("recTranscribeBtn").disabled = true; $("recTranscribeBtn").textContent = "辨識中…";
  try {
    const form = new FormData();
    form.append("audio", recBlob, "recording.webm");
    const res = await fetch("http://127.0.0.1:8765/api/transcribe-audio?language=zh", { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    renderRecSubtitles(data.segments);
    showToast(`辨識完成，共 ${data.segments.length} 段。`);
  } catch (err) {
    showToast(`辨識失敗：${err.message}。（需啟動 start.ps1 並安裝 faster-whisper）`);
  } finally {
    $("recTranscribeBtn").disabled = false; $("recTranscribeBtn").textContent = "辨識錄音";
  }
};
$("recSplitSentencesBtn").onclick = () => {
  const items = [...$("recSubtitlesList").querySelectorAll(".sub-item")];
  if (!items.length) return showToast("請先辨識錄音。");
  const fullText = items.map((el) => el.querySelector(".sub-text").value).join("");
  const parts = fullText.match(/[^。！？!?\n]+[。！？!?\n]?/g)?.filter((s) => s.trim()) || [fullText];
  const dur = recPreviewAudio?.duration || 1;
  renderRecSubtitles(parts.map((text, i) => ({ start: (i / parts.length) * dur, end: ((i + 1) / parts.length) * dur, text: text.trim() })));
};
function renderRecSubtitles(segments) {
  $("recSubtitlesList").innerHTML = segments.map((seg, i) =>
    `<div class="sub-item" data-i="${i}"><span class="sub-time">${seg.start.toFixed(2)}–${seg.end.toFixed(2)}</span><input class="sub-text" value="${esc(seg.text)}" data-start="${seg.start}" data-end="${seg.end}"></div>`
  ).join("");
}

$("recConfirmBtn").onclick = async () => {
  if (!recBlob) return;
  const trimStart = Number($("recTrimStart").value) || 0;
  const trimEnd = Number($("recTrimEnd").value) || (recPreviewAudio?.duration || 0);
  const duration = Math.max(0.1, trimEnd - trimStart);
  const subtitles = [...$("recSubtitlesList").querySelectorAll(".sub-item")].map((el) => {
    const inp = el.querySelector(".sub-text");
    return { id: id("sub"), start: Number(inp.dataset.start) - trimStart, end: Number(inp.dataset.end) - trimStart, text: inp.value.trim() };
  }).filter((s) => s.text);
  const waveform = await extractWaveform(recBlob);
  const url = URL.createObjectURL(recBlob);
  const mediaEl = new Audio(url);
  pushUndo();
  const fileDuration = recPreviewAudio?.duration || (trimEnd || duration);
  state.media = { type: "audio", fileName: "錄音.webm", duration, fileDuration, offset: trimStart, volume: 1, muted: false, src: url, element: mediaEl, waveform };
  if (subtitles.length) state.subtitles = subtitles;
  renderAll(); saveLocal();
  closeRecordModal();
  showToast("已將錄音加入專案。");
};

// Dropdown menus
document.querySelectorAll(".dropdown-toggle").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const dropdown = btn.closest(".dropdown");
    const isOpen = dropdown.classList.contains("open");
    document.querySelectorAll(".dropdown").forEach((d) => d.classList.remove("open"));
    if (!isOpen) dropdown.classList.add("open");
  });
});
document.addEventListener("click", () => document.querySelectorAll(".dropdown").forEach((d) => d.classList.remove("open")));
document.querySelectorAll(".dropdown-menu button").forEach((btn) => {
  btn.addEventListener("click", () => btn.closest(".dropdown").classList.remove("open"));
});
