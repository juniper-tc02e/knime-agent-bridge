/** Geometry is measured from a rendered frame; negative model sizes are never guesses. */
export function validRect(r) { return r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.width >= 0 && r.height >= 0; }
export function inflateRect(r, amount = 0) { return { x: r.x - amount, y: r.y - amount, width: r.width + amount * 2, height: r.height + amount * 2 }; }
export function intersectRects(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right >= x && bottom >= y ? { x, y, width: right - x, height: bottom - y } : null;
}
export function unionRects(rects) {
  const rs = rects.filter(validRect);
  if (!rs.length) return null;
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
  return { x, y, width: Math.max(...rs.map(r => r.x + r.width)) - x, height: Math.max(...rs.map(r => r.y + r.height)) - y };
}
export function transformPoint(p, t = [1, 0, 0, 1, 0, 0]) { return { x: t[0] * p.x + t[2] * p.y + t[4], y: t[1] * p.x + t[3] * p.y + t[5] }; }
export function transformRect(r, t) {
  const ps = [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]].map(([x, y]) => transformPoint({ x, y }, t));
  return unionRects(ps.map(p => ({ ...p, width: 0, height: 0 })));
}

/** Liang–Barsky returns the actual segment inside a rectangle, including edge contact. */
export function segmentRectIntersection(a, b, r) {
  if (!validRect(r)) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  let start = 0, end = 1;
  for (const [p, q] of [[-dx, a.x - r.x], [dx, r.x + r.width - a.x], [-dy, a.y - r.y], [dy, r.y + r.height - a.y]]) {
    if (Math.abs(p) < 1e-15) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) start = Math.max(start, t); else end = Math.min(end, t);
    if (start > end) return null;
  }
  return [{ x: a.x + dx * start, y: a.y + dy * start }, { x: a.x + dx * end, y: a.y + dy * end }];
}
export function chordIntersectsRect(a, b, rect) { return !!segmentRectIntersection(a, b, rect); }
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Parse native cubic paths; unsupported/invalid syntax is an explicit coverage gap. */
export function flattenPath(path, { tolerance = 0.25, maxSegments = 16384, transform = [1, 0, 0, 1, 0, 0] } = {}) {
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 0.25) throw new TypeError('Curve tolerance must be > 0 and <= 0.25 workflow units.');
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 1 || maxSegments > 100000) throw new TypeError('Invalid curve segment budget.');
  const segments = [], gaps = [];
  if (typeof path !== 'string' || path.length > 1_000_000 || !Array.isArray(transform) || transform.length !== 6 || !transform.every(Number.isFinite)) return { segments, complete: false, gaps: [{ kind: 'invalid-path' }] };
  const tokens = path.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || [];
  if (path.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g, '').replace(/[\s,]/g, '')) return { segments, complete: false, gaps: [{ kind: 'invalid-path' }] };
  let i = 0, current = { x: 0, y: 0 }, start = current, command, previousControl = null, previousKind = '';
  const line = (a, b) => { if (segments.length >= maxSegments) throw new Error('subdivision-limit'); segments.push({ a, b }); };
  const cubic = (p0, p1, p2, p3, depth = 0) => {
    if (Math.max(pointSegmentDistance(p1, p0, p3), pointSegmentDistance(p2, p0, p3)) <= tolerance) return line(p0, p3);
    if (depth >= 24) throw new Error('subdivision-limit');
    const a = midpoint(p0, p1), b = midpoint(p1, p2), c = midpoint(p2, p3), d = midpoint(a, b), e = midpoint(b, c), f = midpoint(d, e);
    cubic(p0, a, d, f, depth + 1); cubic(f, e, c, p3, depth + 1);
  };
  const number = () => { if (i >= tokens.length || /^[a-z]$/i.test(tokens[i])) throw new Error('invalid-path'); const n = Number(tokens[i++]); if (!Number.isFinite(n)) throw new Error('invalid-path'); return n; };
  const point = relative => { const x = number(), y = number(); return { x: x + (relative ? current.x : 0), y: y + (relative ? current.y : 0) }; };
  const convert = p => transformPoint(p, transform);
  try {
    while (i < tokens.length) {
      if (/^[a-z]$/i.test(tokens[i])) command = tokens[i++];
      if (!command) throw new Error('invalid-path');
      const kind = command.toUpperCase(), relative = command !== kind;
      let next;
      if (kind === 'M') { current = point(relative); start = current; command = relative ? 'l' : 'L'; }
      else if (kind === 'Z') { line(convert(current), convert(start)); current = start; command = undefined; }
      else if (kind === 'L') { next = point(relative); line(convert(current), convert(next)); current = next; }
      else if (kind === 'H' || kind === 'V') { const n = number(); next = { ...current, [kind === 'H' ? 'x' : 'y']: n + (relative ? current[kind === 'H' ? 'x' : 'y'] : 0) }; line(convert(current), convert(next)); current = next; }
      else if (kind === 'C' || kind === 'S') {
        const c1 = kind === 'C' ? point(relative) : ((previousKind === 'C' || previousKind === 'S') && previousControl ? { x: 2 * current.x - previousControl.x, y: 2 * current.y - previousControl.y } : current);
        const c2 = point(relative); next = point(relative);
        cubic(...[current, c1, c2, next].map(convert)); current = next; previousControl = c2;
      } else if (kind === 'Q' || kind === 'T') {
        const c = kind === 'Q' ? point(relative) : ((previousKind === 'Q' || previousKind === 'T') && previousControl ? { x: 2 * current.x - previousControl.x, y: 2 * current.y - previousControl.y } : current);
        next = point(relative);
        cubic(...[current, { x: current.x + 2 / 3 * (c.x - current.x), y: current.y + 2 / 3 * (c.y - current.y) }, { x: next.x + 2 / 3 * (c.x - next.x), y: next.y + 2 / 3 * (c.y - next.y) }, next].map(convert)); current = next; previousControl = c;
      } else throw new Error(`unsupported-path-command:${kind}`);
      if (!['C', 'S', 'Q', 'T'].includes(kind)) previousControl = null;
      previousKind = kind;
    }
  } catch (error) { gaps.push({ kind: error.message }); }
  return { segments, complete: gaps.length === 0, gaps, tolerance, bounds: unionRects(segments.flatMap(s => [s.a, s.b]).map(p => ({ ...p, width: 0, height: 0 }))) };
}

export function curveIntersections(path, rect, options = {}) {
  const flat = flattenPath(path, options), obstacle = inflateRect(rect, (options.clearance || 0) + (options.strokeWidth || 0) / 2 + flat.tolerance);
  const intersections = flat.segments.map(s => segmentRectIntersection(s.a, s.b, obstacle)).filter(Boolean);
  return { ...flat, intersections, intersects: intersections.length > 0 };
}
export function curveIntersectsRect(path, rect, options = {}) { return curveIntersections(path, rect, options).intersects; }

/** Renderer measurement is the only accepted input; model-only bounds cannot become evidence. */
export function measureGeometry(evidence, renderedGeometry = evidence?.geometry) {
  if (!evidence?.evidenceId || !renderedGeometry || renderedGeometry.sourceFrameId !== evidence.sourceFrameId) throw new TypeError('A matching rendered geometry frame is required.');
  return structuredClone({ ...renderedGeometry, evidenceId: evidence.evidenceId, contextId: evidence.contextId, scopeId: evidence.scopeId, layoutRevision: evidence.layoutRevision });
}
