import { createHash } from 'node:crypto';
import { flattenPath, inflateRect, intersectRects, segmentRectIntersection, unionRects, validRect } from './geometry.mjs';

const issueId = (revision, kind, participants) => createHash('sha256').update(JSON.stringify([revision, kind, participants])).digest('hex').slice(0, 24);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rectFromPoints = points => unionRects(points.map(p => ({ ...p, width: 0, height: 0 })));
const occupied = node => node.parts?.length ? node.parts.map(p => p.bounds).filter(validRect) : [node.bounds];
export function checkLayout(geometry, { textClearance = 4, nodeClearance = 8, maxSegments = 16384, maxComparisons = 2_000_000, dispositions = [] } = {}) {
  if (!geometry || !Array.isArray(geometry.nodes) || !Array.isArray(geometry.texts) || !Array.isArray(geometry.connections)) throw new TypeError('FrameGeometry with rendered nodes, texts, and connections is required.');
  if (![textClearance, nodeClearance].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) throw new TypeError('Clearances must be in 0..100 workflow units.');
  const gaps = structuredClone(geometry.coverage?.gaps || []), findings = [];
  let comparisons = 0, exhausted = false;
  const budget = () => { if (++comparisons <= maxComparisons) return true; if (!exhausted) gaps.push({ kind: 'comparison-budget-exceeded' }); exhausted = true; return false; };
  const add = (kind, participants, intersection, severity = 'high', details = {}) => {
    const id = issueId(geometry.layoutRevision, kind, participants);
    if (findings.some(f => f.id === id)) return;
    const disposition = dispositions.find(d => d.findingId === id && d.layoutRevision === geometry.layoutRevision && typeof d.reason === 'string' && d.reason.trim());
    findings.push({ id, kind, severity, participants, intersection, confidence: 'geometric-candidate', uncertainty: ['Line boxes may include whitespace; review the source image.'], cropWorkflowBounds: inflateRect(intersection, 24), evidenceId: geometry.evidenceId, sourceFrameId: geometry.sourceFrameId, ...(disposition ? { disposition: { reason: disposition.reason, layoutRevision: geometry.layoutRevision } } : {}), ...details });
  };
  const nodes = geometry.nodes.filter(n => { if (validRect(n.bounds)) return true; gaps.push({ kind: 'unresolved-node-bounds', objectId: n.id }); return false; });
  const texts = geometry.texts.filter(t => { if (validRect(t.bounds)) return true; gaps.push({ kind: 'unresolved-text-bounds', objectId: t.id }); return false; });
  for (const t of texts) {
    if (t.clipped) add('text-clipped', [t.id], t.unclippedBounds || t.bounds, 'high', { visibleBounds: t.bounds, hiddenText: t.hiddenText || null });
    else if (t.clippingEdge) add('text-clipping-edge', [t.id], t.unclippedBounds || t.bounds, 'warning', { visibleBounds: t.bounds, uncertainty: ['Font line boxes exceed the clip by at most 1.5 units; glyph ink may remain fully visible.'] });
    for (const n of nodes) {
      if (!budget()) break;
      if (t.ownerId === n.id) continue;
      const overlap = occupied(n).map(r => intersectRects(inflateRect(t.bounds, textClearance), r)).find(Boolean);
      if (overlap) add('node-text-overlap', [n.id, t.id], overlap);
    }
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (!budget()) break;
    const overlap = occupied(nodes[i]).flatMap(a => occupied(nodes[j]).map(b => intersectRects(inflateRect(a, nodeClearance / 2), inflateRect(b, nodeClearance / 2)))).find(Boolean);
    if (overlap) add('node-node-overlap', [nodes[i].id, nodes[j].id], overlap);
  }
  const wires = geometry.connections.map(c => {
    const paths = Array.isArray(c.paths) ? c.paths : c.path ? [c.path] : [];
    if (!paths.length) gaps.push({ kind: 'connection-path-unavailable', objectId: c.id });
    const flat = paths.map(p => flattenPath(typeof p === 'string' ? p : p.d, { tolerance: 0.25, maxSegments, transform: typeof p === 'string' ? c.transform : p.transform || c.transform }));
    for (const f of flat) if (!f.complete) gaps.push(...f.gaps.map(g => ({ ...g, objectId: c.id })));
    return { ...c, segments: flat.flatMap(f => f.segments), bounds: unionRects(flat.map(f => f.bounds)), strokeRadius: (c.strokeWidth || 1) * (c.strokeScale || 1) / 2 };
  });
  for (const wire of wires) {
    if (!wire.bounds) continue;
    for (const obstacle of [...texts.map(t => ({ ...t, kind: 'text' })), ...nodes.flatMap(n => occupied(n).map(bounds => ({ ...n, bounds, kind: 'node' })))]) {
      const clearance = obstacle.kind === 'text' ? textClearance : nodeClearance;
      const expanded = inflateRect(obstacle.bounds, clearance + wire.strokeRadius + 0.25);
      if (!intersectRects(wire.bounds, expanded)) continue;
      for (let index = 0; index < wire.segments.length; index++) {
        if (!budget()) break;
        const s = wire.segments[index], intersection = segmentRectIntersection(s.a, s.b, expanded);
        if (!intersection) continue;
        if (obstacle.kind === 'node' && [wire.sourceNodeId, wire.targetNodeId].includes(obstacle.id)) {
          const endpoint = wire.sourceNodeId === obstacle.id ? wire.segments[0].a : wire.segments.at(-1).b;
          const port = (obstacle.portContacts || []).find(p => distance(p, endpoint) <= (p.radius || 3) + Math.max(3, wire.strokeRadius));
          // Exempt only the short contact vicinity. A returning curve through its own body is still a finding.
          if (port && intersection.every(p => distance(p, port) <= (port.radius || 3) + clearance + wire.strokeRadius + 0.5)) continue;
        }
        add(`connection-${obstacle.kind}-overlap`, [wire.id, obstacle.id], rectFromPoints(intersection), 'high', { curveSegment: s, clearance, strokeRadius: wire.strokeRadius });
        break;
      }
    }
  }
  // Crossing wires are a separate readability warning, never a text obstruction.
  for (let i = 0; i < wires.length; i++) for (let j = i + 1; j < wires.length; j++) {
    if (!wires[i].bounds || !wires[j].bounds || !intersectRects(wires[i].bounds, wires[j].bounds)) continue;
    let found = false;
    for (const a of wires[i].segments) {
      for (const b of wires[j].segments) {
        if (!budget()) break;
        const rx = a.b.x - a.a.x, ry = a.b.y - a.a.y, sx = b.b.x - b.a.x, sy = b.b.y - b.a.y, cross = rx * sy - ry * sx;
        if (Math.abs(cross) < 1e-10) continue;
        const qx = b.a.x - a.a.x, qy = b.a.y - a.a.y, t = (qx * sy - qy * sx) / cross, u = (qx * ry - qy * rx) / cross;
        if (t > 0 && t < 1 && u > 0 && u < 1) { add('connection-crossing', [wires[i].id, wires[j].id], { x: a.a.x + t * rx, y: a.a.y + t * ry, width: 0, height: 0 }, 'warning'); found = true; break; }
      }
      if (found || exhausted) break;
    }
  }
  if (validRect(geometry.bounds)) for (const item of [...nodes, ...texts, ...wires]) {
    if (!validRect(item.bounds)) continue;
    const inside = intersectRects(item.bounds, geometry.bounds);
    if (!inside || inside.width + 0.5 < item.bounds.width || inside.height + 0.5 < item.bounds.height) gaps.push({ kind: 'object-outside-frame', objectId: item.id, requiredCrop: item.bounds });
  }
  return { evidenceId: geometry.evidenceId, sourceFrameId: geometry.sourceFrameId, layoutRevision: geometry.layoutRevision, findings, coverage: { complete: geometry.coverage?.complete === true && gaps.length === 0, gaps, comparisons, curveTolerance: 0.25 } };
}
