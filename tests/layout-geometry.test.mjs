import test from 'node:test';
import assert from 'node:assert/strict';

const geometry = await import('../src/layout/geometry.mjs').catch(() => ({}));

test('actual cubic catches heading obstruction missed by the port chord', () => {
  assert.equal(typeof geometry.curveIntersectsRect, 'function', 'curve measurement must exist');
  const heading = { x: 48.5, y: 714.5, width: 600, height: 18.4 };
  assert.equal(geometry.chordIntersectsRect({ x: 10, y: 580 }, { x: 20, y: 1390 }, heading), false);
  assert.equal(geometry.curveIntersectsRect('M10,580 C217,580 -187,1390 20,1390', heading, { tolerance: 0.25, clearance: 4 }), true);
  assert.equal(geometry.curveIntersectsRect('M10,580 C10,700 10,1270 20,1390', heading, { tolerance: 0.25, clearance: 4 }), false);
});

test('cubic subdivision is bounded and unsupported paths remain incomplete', () => {
  assert.equal(typeof geometry.flattenPath, 'function');
  const flat = geometry.flattenPath('M10,580 C217,580 -187,1390 20,1390', { tolerance: 0.25 });
  assert.equal(flat.complete, true);
  assert.ok(flat.segments.length > 10);
  assert.equal(geometry.flattenPath('M0 0 A10 10 0 0 1 20 20').complete, false);
  assert.equal(geometry.flattenPath('M0 0 C1000 1000 -1000 1000 10 0', { maxSegments: 2 }).complete, false);
});

test('transforms preserve negative workflow coordinates and reject unresolved model bounds', () => {
  assert.equal(typeof geometry.transformRect, 'function');
  assert.deepEqual(geometry.transformRect({ x: -100, y: -50, width: 20, height: 10 }, [2, 0, 0, 2, 200, 100]), { x: 0, y: 0, width: 40, height: 20 });
  assert.equal(geometry.validRect({ x: 1, y: 2, width: -1, height: -1 }), false);
});
