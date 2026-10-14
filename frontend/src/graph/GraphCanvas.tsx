import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { GraphCanvasProps, GraphStats, ItemKind, KnowledgeItem } from '../model';
import { buildAdjacency, fitTransform, isDirectionalRelation, labelRank, labelTier, nearestNode, nodeRadiusForDegree, relationDisplayLabel, seedPositions, visibleNeighborhood, zoomAt, type Point, type ViewTransform } from './graphMath';
import { placeNodeLabel } from './labelPlacement';
import './GraphCanvas.css';

interface DrawNode extends Point { id: string; item: KnowledgeItem; degree: number }
interface PointerInfo { x: number; y: number }
interface Gesture {
  mode: 'pan' | 'node' | 'pinch';
  pointerId: number;
  start: Point;
  last: Point;
  transform: ViewTransform;
  nodeId?: string;
  moved: boolean;
  pinchDistance?: number;
  pinchCenter?: Point;
}

const COLORS: Record<ItemKind, string> = { document: '#aeb5bd', tool: '#42b7b1', ai_asset: '#927da7' };
const CACHE_KEY = 'kms-graph-layout-v1';
const EDGE_LABEL_LIMIT = 7;
const EDGE_LABEL_MIN_ZOOM = .88;
const MAX_EDGE_LABEL_CHARS = 18;

function shortenLabel(value: string, limit = MAX_EDGE_LABEL_CHARS): string {
  return value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}…` : value;
}

function drawArrow(ctx: CanvasRenderingContext2D, source: Point, target: Point, fromRadius: number, toRadius: number, scale: number): void {
  const dx = target.x - source.x; const dy = target.y - source.y; const distance = Math.hypot(dx, dy);
  if (distance < fromRadius + toRadius + 8 / scale) return;
  const ux = dx / distance; const uy = dy / distance;
  const tipX = target.x - ux * (toRadius + 2.5 / scale); const tipY = target.y - uy * (toRadius + 2.5 / scale);
  const length = 6.5 / scale; const wing = 3.2 / scale;
  ctx.beginPath(); ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ux * length - uy * wing, tipY - uy * length + ux * wing);
  ctx.lineTo(tipX - ux * length + uy * wing, tipY - uy * length - ux * wing);
  ctx.closePath(); ctx.fill();
}

function edgeMidpoint(a: Point, b: Point): Point { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

function loadCache(): Map<string, Point> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, Point> : {};
    return new Map(Object.entries(parsed).filter(([, p]) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  } catch { return new Map(); }
}

function saveCache(positions: ReadonlyMap<string, Point>): void {
  try {
    const entries = [...positions].slice(-2500);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* Storage can be unavailable in embedded/private contexts. */ }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function graphSignature(items: readonly KnowledgeItem[], relations: GraphCanvasProps['relations']): string {
  return `${items.map((item) => item.id).join('\u001f')}\u001e${relations.map((edge) => `${edge.source}>${edge.target}`).join('\u001f')}`;
}

export default function GraphCanvas({
  items, relations, selectedId, onSelect, visibleIds, localDepth = 0, focusRequest, onStats, relationTypes,
}: GraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const positionsRef = useRef<Map<string, Point>>(new Map());
  const stablePositionsRef = useRef<Map<string, Point> | null>(null);
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, k: 1 });
  const pointersRef = useRef(new Map<number, PointerInfo>());
  const draggedIdsRef = useRef(new Set<string>());
  const gestureRef = useRef<Gesture | null>(null);
  const frameRef = useRef<number | null>(null);
  const animationRef = useRef<number | null>(null);
  const animateTransformRef = useRef<(target: ViewTransform) => void>(() => {});
  const focusTargetRef = useRef<string | null>(focusRequest?.id ?? null);
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 });
  const initialFitRef = useRef(false);
  const finalFitRef = useRef(false);
  const userInteractedRef = useRef(false);
  // Unlike the initial fit, a jump can safely recenter after layout only if
  // the user has not taken control since that jump was requested.
  const interactionEpochRef = useRef(0);
  const focusInteractionEpochRef = useRef(0);
  const statsRef = useRef<GraphStats | null>(null);
  const [layoutState, setLayoutState] = useState(() => ({ signature: graphSignature(items, relations), running: items.length > 0 }));
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [positionVersion, setPositionVersion] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const signature = useMemo(() => graphSignature(items, relations), [items, relations]);
  // A changed dataset is considered running during render, before its effect starts
  // the new worker. This prevents a one-frame false "complete" report.
  const layoutRunning = items.length > 0 && (layoutState.signature !== signature || layoutState.running);
  const adjacency = useMemo(() => buildAdjacency(items, relations), [items, relations]);
  const shownIds = useMemo(
    () => visibleNeighborhood(items, relations, visibleIds, selectedId, localDepth),
    [items, relations, visibleIds, selectedId, localDepth],
  );
  const drawNodes = useMemo<DrawNode[]>(() => items.flatMap((item) => {
    if (!shownIds.has(item.id)) return [];
    const point = positionsRef.current.get(item.id);
    return point ? [{ ...point, id: item.id, item, degree: adjacency.get(item.id)?.size ?? 0 }] : [];
  }), [items, shownIds, adjacency, positionVersion]);
  const drawEdges = useMemo(() => relations.filter((edge) => (!relationTypes || relationTypes.has(edge.type)) && shownIds.has(edge.source) && shownIds.has(edge.target)), [relations, shownIds, relationTypes]);

  const requestDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; setPositionVersion((v) => v + 1); });
  }, []);

  useEffect(() => {
    finalFitRef.current = false;
    const degrees = new Map(items.map((item) => [item.id, 0]));
    for (const edge of relations) {
      if (degrees.has(edge.source) && degrees.has(edge.target)) {
        degrees.set(edge.source, degrees.get(edge.source)! + 1);
        degrees.set(edge.target, degrees.get(edge.target)! + 1);
      }
    }
    if (stablePositionsRef.current === null) stablePositionsRef.current = loadCache();
    const stablePositions = stablePositionsRef.current;
    const previous = new Map(stablePositions);
    for (const [id, point] of positionsRef.current) if (!previous.has(id)) previous.set(id, point);
    const itemIds = new Set(items.map((item) => item.id));
    const preservedIds = new Set([...stablePositions.keys()].filter((id) => itemIds.has(id)));
    positionsRef.current = seedPositions(items.map((item) => item.id), relations, previous);
    setPositionVersion((v) => v + 1);
    setLayoutError(null);
    workerRef.current?.terminate();
    if (!items.length) { setLayoutState({ signature, running: false }); return undefined; }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      setLayoutState({ signature, running: false });
      setLayoutError(`자동 배치를 시작하지 못했습니다. 임시 배치로 표시합니다. (${error instanceof Error ? error.message : String(error)})`);
      return undefined;
    }
    workerRef.current = worker;
    const generation = Date.now() + Math.random();
    setLayoutState({ signature, running: true });
    worker.onmessage = (event: MessageEvent<{ type: string; generation: number; positions?: Array<{ id: string; x: number; y: number }>; message?: string }>) => {
      if (event.data.generation !== generation) return;
      if (event.data.type === 'error') {
        setLayoutState({ signature, running: false });
        setLayoutError(`자동 배치 중 오류가 발생했습니다. 임시 배치로 계속 탐색할 수 있습니다. (${event.data.message ?? '알 수 없는 오류'})`);
        return;
      }
      if (!event.data.positions) return;
      for (const point of event.data.positions) {
        if (!draggedIdsRef.current.has(point.id) && Number.isFinite(point.x) && Number.isFinite(point.y)) positionsRef.current.set(point.id, { x: point.x, y: point.y });
      }
      requestDraw();
      if (event.data.type === 'done') {
        setLayoutState({ signature, running: false });
        stablePositionsRef.current = new Map(positionsRef.current);
        saveCache(positionsRef.current);
        const focusId = focusTargetRef.current;
        const canFinishFocus = focusId && focusInteractionEpochRef.current === interactionEpochRef.current;
        const focused = focusId ? positionsRef.current.get(focusId) : undefined;
        if (canFinishFocus && focused) {
          const { width, height } = sizeRef.current; const k = Math.max(1.15, transformRef.current.k);
          animateTransformRef.current({ x: width / 2 - focused.x * k, y: height / 2 - focused.y * k, k });
        } else if (!finalFitRef.current && !userInteractedRef.current) {
          finalFitRef.current = true;
          animateTransformRef.current(fitTransform([...positionsRef.current.values()], sizeRef.current.width, sizeRef.current.height));
        }
      }
    };
    worker.onerror = (event) => {
      setLayoutState({ signature, running: false });
      setLayoutError(`자동 배치 Worker가 중단되었습니다. 임시 배치로 계속 탐색할 수 있습니다. (${event.message || '알 수 없는 오류'})`);
    };
    worker.postMessage({
      type: 'layout', generation,
      nodes: items.map((item) => ({ id: item.id, degree: degrees.get(item.id) ?? 0, ...positionsRef.current.get(item.id)!, fixed: preservedIds.has(item.id) })),
      links: relations.filter((edge) => degrees.has(edge.source) && degrees.has(edge.target)).map((edge) => ({ source: edge.source, target: edge.target })),
    });
    return () => { worker.terminate(); if (workerRef.current === worker) workerRef.current = null; };
  }, [signature, requestDraw]); // Filtering and selection intentionally do not restart layout.

  useEffect(() => {
    const host = hostRef.current; const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const resize = () => {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const previousSize = sizeRef.current;
      const interruptedFocusAnimation = animationRef.current !== null;
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      sizeRef.current = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr };
      canvas.width = Math.round(sizeRef.current.width * dpr); canvas.height = Math.round(sizeRef.current.height * dpr);
      if (!initialFitRef.current && rect.width > 10 && rect.height > 10 && positionsRef.current.size) {
        initialFitRef.current = true;
        transformRef.current = fitTransform([...positionsRef.current.values()], sizeRef.current.width, sizeRef.current.height);
      } else if (previousSize.width > 10 && previousSize.height > 10 && rect.width > 10 && rect.height > 10) {
        const transform = transformRef.current;
        const centerWorldX = (previousSize.width / 2 - transform.x) / transform.k;
        const centerWorldY = (previousSize.height / 2 - transform.y) / transform.k;
        transformRef.current = {
          ...transform,
          x: sizeRef.current.width / 2 - centerWorldX * transform.k,
          y: sizeRef.current.height / 2 - centerWorldY * transform.k,
        };
      }
      if (interruptedFocusAnimation && focusTargetRef.current) {
        const focused = positionsRef.current.get(focusTargetRef.current);
        if (focused) {
          const transform = transformRef.current;
          transformRef.current = {
            ...transform,
            x: sizeRef.current.width / 2 - focused.x * transform.k,
            y: sizeRef.current.height / 2 - focused.y * transform.k,
          };
        }
      }
      requestDraw();
    };
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    return () => observer.disconnect();
  }, [requestDraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (animationRef.current !== null) { cancelAnimationFrame(animationRef.current); animationRef.current = null; }
      userInteractedRef.current = true; interactionEpochRef.current += 1;
      transformRef.current = zoomAt(transformRef.current, point, transformRef.current.k * Math.exp(-event.deltaY * .0015));
      requestDraw();
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [requestDraw]);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.attributeName === 'data-theme' || mutation.attributeName === 'class' || mutation.attributeName === 'style')) requestDraw();
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => observer.disconnect();
  }, [requestDraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height, dpr } = sizeRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const t = transformRef.current;
    const styles = getComputedStyle(hostRef.current!);
    const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const nodeColors: Record<ItemKind, string> = {
      document: color('--graph-node-document', COLORS.document), tool: color('--graph-node-tool', COLORS.tool), ai_asset: color('--graph-node-ai', COLORS.ai_asset),
    };
    const graphText = color('--graph-text', '#d8dde2');
    const graphSelected = color('--graph-selected', '#ffffff');
    const graphEdge = color('--graph-edge', 'rgba(151, 170, 158, .35)');
    const graphLabelBackground = color('--graph-label-bg', color('--graph-bg', '#111418'));
    ctx.save(); ctx.translate(t.x, t.y); ctx.scale(t.k, t.k);
    const focusId = hoveredId ?? selectedId;
    const neighbors = focusId ? adjacency.get(focusId) ?? new Set<string>() : new Set<string>();
    const activeEdges = focusId
      ? drawEdges.filter((edge) => edge.source === focusId || edge.target === focusId)
      : [];
    for (const edge of drawEdges) {
      const a = positionsRef.current.get(edge.source); const b = positionsRef.current.get(edge.target);
      if (!a || !b) continue;
      const related = Boolean(focusId && (edge.source === focusId || edge.target === focusId));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = related ? color('--graph-edge-active', '#7ac6a7') : focusId ? color('--graph-edge-muted', 'rgba(151, 170, 158, .14)') : graphEdge;
      ctx.lineWidth = (related ? 1.8 : .75) / t.k; ctx.stroke();
      if (related && isDirectionalRelation(edge.type)) {
        const sourceDegree = adjacency.get(edge.source)?.size ?? 0;
        const targetDegree = adjacency.get(edge.target)?.size ?? 0;
        ctx.fillStyle = color('--graph-edge-active', 'rgba(180, 216, 220, .72)');
        drawArrow(ctx, a, b, nodeRadiusForDegree(sourceDegree) / Math.sqrt(t.k), nodeRadiusForDegree(targetDegree) / Math.sqrt(t.k), t.k);
      }
    }
    for (const node of drawNodes) {
      const active = node.id === focusId; const related = active || neighbors.has(node.id);
      const radius = nodeRadiusForDegree(node.degree) / Math.sqrt(t.k);
      ctx.beginPath(); ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.globalAlpha = focusId && !related ? .28 : 1;
      ctx.fillStyle = nodeColors[node.item.kind]; ctx.fill();
      if (active || node.id === selectedId) { ctx.strokeStyle = graphSelected; ctx.lineWidth = 1.35 / t.k; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    const ranked = [...drawNodes].sort((a, b) => labelRank(b.id, b.degree, selectedId, hoveredId, adjacency) - labelRank(a.id, a.degree, selectedId, hoveredId, adjacency));
    const maxLabels = t.k < .45 ? 5 : t.k < .8 ? 12 : t.k < 1.35 ? 28 : 70;
    const boxes: Array<{ l: number; r: number; t: number; b: number }> = [];
    ctx.font = `${11 / t.k}px system-ui, sans-serif`; ctx.textBaseline = 'middle';
    let labels = 0;
    for (const node of ranked) {
      const tier = labelTier(node.id, selectedId, hoveredId, adjacency);
      if (labels >= maxLabels && tier !== 'focus') continue;
      const sx = node.x * t.k + t.x; const sy = node.y * t.k + t.y;
      if (sx < -20 || sy < -20 || sx > width + 20 || sy > height + 20) continue;
      let text = shortenLabel(node.item.title, 30);
      let w = ctx.measureText(text).width * t.k;
      if (tier === 'focus') {
        while (text.length > 1 && w > width - 8) { text = shortenLabel(node.item.title, text.length - 1); w = ctx.measureText(text).width * t.k; }
      }
      const labelPoint = placeNodeLabel({ x: sx, y: sy }, w, width, height, tier === 'focus');
      if (!labelPoint) continue;
      const box = { l: labelPoint.x, r: labelPoint.x + w, t: labelPoint.y - 7, b: labelPoint.y + 7 };
      if (tier !== 'focus' && boxes.some((b) => box.l < b.r && box.r > b.l && box.t < b.b && box.b > b.t)) continue;
      boxes.push(box); labels += 1;
      ctx.globalAlpha = focusId && node.id !== focusId && !neighbors.has(node.id) ? .26 : .88;
      ctx.fillStyle = node.id === selectedId ? graphSelected : graphText; ctx.fillText(text, (labelPoint.x - t.x) / t.k, (labelPoint.y - t.y) / t.k);
    }
    if (focusId && t.k >= EDGE_LABEL_MIN_ZOOM) {
      const labeledEdges = activeEdges
        .filter((edge) => isDirectionalRelation(edge.type))
        .sort((a, b) => Number(Boolean(b.label.trim())) - Number(Boolean(a.label.trim())) || a.id.localeCompare(b.id))
        .slice(0, EDGE_LABEL_LIMIT);
      ctx.font = `${10 / t.k}px system-ui, sans-serif`; ctx.textBaseline = 'middle';
      for (const edge of labeledEdges) {
        const a = positionsRef.current.get(edge.source); const b = positionsRef.current.get(edge.target);
        if (!a || !b) continue;
        const center = edgeMidpoint(a, b); const sx = center.x * t.k + t.x; const sy = center.y * t.k + t.y;
        const text = shortenLabel(relationDisplayLabel(edge)); const measured = ctx.measureText(text).width * t.k;
        const box = { l: sx - measured / 2 - 4, r: sx + measured / 2 + 4, t: sy - 8, b: sy + 8 };
        if (box.l < 4 || box.r > width - 4 || box.t < 4 || box.b > height - 4 || boxes.some((existing) => box.l < existing.r && box.r > existing.l && box.t < existing.b && box.b > existing.t)) continue;
        boxes.push(box);
        ctx.globalAlpha = .96; ctx.fillStyle = graphLabelBackground;
        ctx.fillRect(center.x - (measured / t.k) / 2 - 4 / t.k, center.y - 7 / t.k, measured / t.k + 8 / t.k, 14 / t.k);
        ctx.fillStyle = color('--graph-edge-label', graphText); ctx.fillText(text, center.x - (measured / t.k) / 2, center.y);
      }
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }, [drawNodes, drawEdges, adjacency, selectedId, hoveredId, positionVersion]);

  useEffect(() => {
    const stats = { visibleNodes: drawNodes.length, visibleEdges: drawEdges.length, layoutRunning };
    if (statsRef.current && stats.visibleNodes === statsRef.current.visibleNodes && stats.visibleEdges === statsRef.current.visibleEdges && stats.layoutRunning === statsRef.current.layoutRunning) return;
    statsRef.current = stats; onStats?.(stats);
  }, [drawNodes.length, drawEdges.length, layoutRunning, onStats]);

  const animateTransform = useCallback((target: ViewTransform) => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = transformRef.current; const started = performance.now(); const duration = reduced ? 0 : 220;
    const step = (now: number) => {
      const p = duration ? Math.min(1, (now - started) / duration) : 1; const e = 1 - (1 - p) ** 3;
      transformRef.current = { x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e, k: start.k + (target.k - start.k) * e };
      requestDraw();
      if (p < 1) animationRef.current = requestAnimationFrame(step);
      else animationRef.current = null;
    };
    animationRef.current = requestAnimationFrame(step);
  }, [requestDraw]);
  animateTransformRef.current = animateTransform;

  useEffect(() => {
    if (!focusRequest) { focusTargetRef.current = null; return; }
    focusTargetRef.current = focusRequest.id;
    focusInteractionEpochRef.current = interactionEpochRef.current;
    const point = positionsRef.current.get(focusRequest.id); if (!point) return;
    const { width, height } = sizeRef.current; const k = Math.max(1.15, transformRef.current.k);
    animateTransform({ x: width / 2 - point.x * k, y: height / 2 - point.y * k, k });
  }, [focusRequest?.id, focusRequest?.nonce, animateTransform]);

  useEffect(() => () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    workerRef.current?.terminate();
  }, []);

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const worldPoint = (screen: Point): Point => ({ x: (screen.x - transformRef.current.x) / transformRef.current.k, y: (screen.y - transformRef.current.y) / transformRef.current.k });
  const hitAt = (screen: Point) => nearestNode(drawNodes, worldPoint(screen), transformRef.current.k);

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    userInteractedRef.current = true; interactionEpochRef.current += 1;
    if (animationRef.current !== null) { cancelAnimationFrame(animationRef.current); animationRef.current = null; }
    event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    const point = localPoint(event); pointersRef.current.set(event.pointerId, point);
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      gestureRef.current = { mode: 'pinch', pointerId: event.pointerId, start: point, last: point, transform: { ...transformRef.current }, moved: true, pinchDistance: Math.hypot(a.x - b.x, a.y - b.y), pinchCenter: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    } else {
      const hit = hitAt(point);
      gestureRef.current = { mode: hit ? 'node' : 'pan', pointerId: event.pointerId, start: point, last: point, transform: { ...transformRef.current }, nodeId: hit?.id, moved: false };
    }
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event); const gesture = gestureRef.current;
    if (!pointersRef.current.has(event.pointerId) || !gesture) {
      const hit = hitAt(point); setHoveredId(hit?.id ?? null); return;
    }
    pointersRef.current.set(event.pointerId, point);
    const distance = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y); if (distance > 3) gesture.moved = true;
    if (pointersRef.current.size >= 2 && gesture.mode === 'pinch') {
      const [a, b] = [...pointersRef.current.values()]; const currentDistance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const anchored = zoomAt(gesture.transform, gesture.pinchCenter!, gesture.transform.k * currentDistance / Math.max(1, gesture.pinchDistance!));
      transformRef.current = { ...anchored, x: anchored.x + center.x - gesture.pinchCenter!.x, y: anchored.y + center.y - gesture.pinchCenter!.y };
    } else if (gesture.mode === 'node' && gesture.nodeId) {
      draggedIdsRef.current.add(gesture.nodeId);
      positionsRef.current.set(gesture.nodeId, worldPoint(point));
    } else if (gesture.mode === 'pan') {
      transformRef.current = { ...gesture.transform, x: gesture.transform.x + point.x - gesture.start.x, y: gesture.transform.y + point.y - gesture.start.y };
    }
    gesture.last = point; requestDraw();
  };
  const endPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current; const point = localPoint(event);
    pointersRef.current.delete(event.pointerId);
    if (gesture && pointersRef.current.size === 0) {
      if (!gesture.moved && gesture.mode === 'node' && gesture.nodeId) onSelect(gesture.nodeId);
      else if (!gesture.moved && gesture.mode === 'pan') onSelect(null);
      if (gesture.mode === 'node') saveCache(positionsRef.current);
      gestureRef.current = null; setDragging(false);
    }
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    setHoveredId(hitAt(point)?.id ?? null); requestDraw();
  };
  const cancelPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) { gestureRef.current = null; setDragging(false); }
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    requestDraw();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (isEditableTarget(event.target)) return;
    userInteractedRef.current = true; interactionEpochRef.current += 1;
    const t = transformRef.current; const { width, height } = sizeRef.current;
    if (event.key === '+' || event.key === '=') transformRef.current = zoomAt(t, { x: width / 2, y: height / 2 }, t.k * 1.2);
    else if (event.key === '-' || event.key === '_') transformRef.current = zoomAt(t, { x: width / 2, y: height / 2 }, t.k / 1.2);
    else if (event.key === 'ArrowLeft') transformRef.current = { ...t, x: t.x + 36 };
    else if (event.key === 'ArrowRight') transformRef.current = { ...t, x: t.x - 36 };
    else if (event.key === 'ArrowUp') transformRef.current = { ...t, y: t.y + 36 };
    else if (event.key === 'ArrowDown') transformRef.current = { ...t, y: t.y - 36 };
    else if (event.key === 'Escape') { onSelect(null); setHoveredId(null); }
    else if (event.key.toLowerCase() === 'f') { focusTargetRef.current = null; animateTransform(fitTransform(drawNodes, width, height)); }
    else return;
    event.preventDefault(); requestDraw();
  };

  return <div className="kmsGraph" ref={hostRef}>
    <canvas
      ref={canvasRef} tabIndex={0} role="img" aria-describedby="graph-keyboard-help"
      aria-label={`지식 연결 그래프, 노드 ${drawNodes.length}개, 연결 ${drawEdges.length}개`}
      data-dragging={dragging}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={cancelPointer}
      onPointerLeave={() => { if (!gestureRef.current) setHoveredId(null); }} onKeyDown={onKeyDown}
    />
    <div className="kmsGraph__controls" aria-label="지도 조작"><button type="button" aria-label="지도 확대" onClick={() => { const { width, height } = sizeRef.current; focusTargetRef.current = null; userInteractedRef.current = true; interactionEpochRef.current += 1; animateTransform(zoomAt(transformRef.current, { x: width / 2, y: height / 2 }, transformRef.current.k * 1.3)); }}>+</button><button type="button" aria-label="지도 축소" onClick={() => { const { width, height } = sizeRef.current; focusTargetRef.current = null; userInteractedRef.current = true; interactionEpochRef.current += 1; animateTransform(zoomAt(transformRef.current, { x: width / 2, y: height / 2 }, transformRef.current.k / 1.3)); }}>−</button><button
      type="button" className="kmsGraph__fit"
      onClick={() => { focusTargetRef.current = null; animateTransform(fitTransform(drawNodes, sizeRef.current.width, sizeRef.current.height)); }}
      aria-label="표시된 지도 범위 맞춤"
    >범위 맞춤</button></div>
    {layoutError && <div className="kmsGraph__error" role="status">{layoutError}</div>}
    <div id="graph-keyboard-help" className="kmsGraph__hint">드래그 이동 · +/− 확대 · 방향키 이동 · F 맞춤</div>
  </div>;
}
