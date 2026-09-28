import test from 'node:test';
import assert from 'node:assert/strict';
const { checkLayout } = await import('../src/layout/check.mjs').catch(() => ({}));
const frame = overrides => ({ evidenceId: 'e', sourceFrameId: 'f', layoutRevision: 'r', bounds: { x: -300, y: 0, width: 1200, height: 1500 }, nodes: [], annotations: [], texts: [], connections: [], coverage: { complete: true, gaps: [] }, ...overrides });

test('checker reports real title collision with revision-scoped geometric crop', () => {
  assert.equal(typeof checkLayout, 'function', 'layout checker must exist');
  const result = checkLayout(frame({ texts: [{ id: 'title', ownerId: 'group', bounds: { x: 48.5, y: 714.5, width: 600, height: 18.4 } }], connections: [{ id: 'csv-store', paths: ['M10,580 C217,580 -187,1390 20,1390'], strokeWidth: 1 }] }));
  assert.ok(result.findings.some(f => f.kind === 'connection-text-overlap' && f.severity === 'high' && f.cropWorkflowBounds));
  assert.equal(result.coverage.complete, true);
});

test('intentional annotation containment and wire through empty group body are allowed', () => {
  assert.equal(typeof checkLayout, 'function');
  const result = checkLayout(frame({ annotations: [{ id: 'group', bounds: { x: 0, y: 0, width: 700, height: 500 } }], texts: [{ id: 'title', ownerId: 'group', bounds: { x: 20, y: 20, width: 200, height: 20 } }], nodes: [{ id: 'n', bounds: { x: 100, y: 100, width: 40, height: 60 } }], connections: [{ id: 'c', paths: ['M-50 300 C50 300 650 300 750 300'] }] }));
  assert.equal(result.findings.filter(f => f.severity === 'high').length, 0);
});

test('only legitimate own port contact is exempt; looping through the source body is caught', () => {
  assert.equal(typeof checkLayout, 'function');
  const n = { id: 'n', bounds: { x: 0, y: 0, width: 40, height: 40 }, portContacts: [{ x: 40, y: 20, radius: 5 }] };
  const clean = checkLayout(frame({ nodes: [n], connections: [{ id: 'c', sourceNodeId: 'n', paths: ['M40 20 L100 20'] }] }));
  assert.equal(clean.findings.filter(f => f.severity === 'high').length, 0);
  const bad = checkLayout(frame({ nodes: [n], connections: [{ id: 'c', sourceNodeId: 'n', paths: ['M40 20 C-40 20 -40 30 100 30'] }] }));
  assert.ok(bad.findings.some(f => f.kind === 'connection-node-overlap'));
});

test('clipping is high priority and marker, unresolved bounds, subdivision gaps prevent clear coverage', () => {
  assert.equal(typeof checkLayout, 'function');
  const result = checkLayout(frame({ nodes: [{ id: 'auto', bounds: { x: 0, y: 0, width: -1, height: -1 } }], texts: [{ id: 'clipped', bounds: { x: 0, y: 0, width: 20, height: 10 }, clipped: true }], coverage: { complete: false, gaps: [{ kind: 'marker-geometry-unavailable', objectId: 'list' }] } }));
  assert.ok(result.findings.some(f => f.kind === 'text-clipped'));
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.gaps.some(g => g.kind === 'unresolved-node-bounds'));
});

test('empty node-name/label container area is not an occupied node footprint', () => {
  const n = { id: 'n', bounds: { x: 0, y: 0, width: 100, height: 200 }, parts: [{ kind: 'rect', bounds: { x: 30, y: 50, width: 40, height: 40 } }, { kind: 'text', bounds: { x: 5, y: 20, width: 90, height: 14 } }] };
  const result = checkLayout(frame({ nodes: [n], connections: [{ id: 'c', paths: ['M-10 150 L120 150'] }] }));
  assert.equal(result.findings.filter(f => f.severity === 'high').length, 0);
});
