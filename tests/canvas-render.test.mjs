import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const renderer = await import('../src/canvas/render.mjs').catch(() => ({}));
const evidenceApi = await import('../src/canvas/evidence.mjs').catch(() => ({}));
const context = { contextId: 'ctx', sessionId: 'session', projectId: 'project', workflowId: 'root', revisions: { layout: 'r1', execution: 'x1' } };
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" viewBox="-100 -50 2400 1800"><g data-annotation-id="a"><rect x="0" y="0" width="800" height="500" fill="#eee"/><foreignObject x="20" y="10" width="300" height="40"><xhtml:div style="font:16px Arial;height:20px;overflow:hidden"><xhtml:div>Unicode heading αβ 中文</xhtml:div><xhtml:div>Hidden second line</xhtml:div></xhtml:div></foreignObject></g><g data-node-id="n"><rect x="100" y="100" width="40" height="40"/><text x="90" y="165">Node label</text></g><g data-connector-id="c"><path d="M10,580 C217,580 -187,1390 20,1390" stroke="black" fill="none"/></g><foreignObject x="500" y="100" width="200" height="100"><xhtml:ul><xhtml:li>List text</xhtml:li></xhtml:ul></foreignObject></svg>`;

test('Chromium renders bounded overview and tiles with independent negative-origin transforms', async () => {
  assert.equal(typeof renderer.renderSvg, 'function', 'private Chromium renderer must exist');
  const result = await renderer.renderSvg({ svg, context, options: { mode: 'tiles', maxImages: 3, deviceScaleFactor: 2 } });
  assert.equal(result.images.length, 3);
  assert.ok(result.images.every(i => i.data.subarray(0, 8).equals(evidenceApi.PNG_SIGNATURE)));
  const [overview, tile] = result.evidence.artifacts;
  assert.notDeepEqual(overview.workflowToPixel, tile.workflowToPixel);
  assert.equal(overview.width, 1600);
  assert.equal(overview.workflowToPixel[4], 100 * overview.workflowToPixel[0]);
  assert.equal(result.evidence.sourceKind, 'native-preview');
  assert.ok(result.evidence.coverage.omittedTileIds.length > 0);
  assert.equal(result.evidence.coverage.complete, false);
  assert.equal(result.geometry.connections[0].id, 'c');
  assert.equal(result.geometry.connections[0].paths[0], 'M10,580 C217,580 -187,1390 20,1390');
  assert.ok(result.geometry.texts.some(t => t.clipped));
  assert.ok(result.geometry.coverage.gaps.some(g => g.kind === 'marker-geometry-unavailable'));
  assert.ok(result.geometry.nodes[0].bounds.height > 40, 'node label is in measured footprint');
  assert.equal(JSON.stringify(result.evidence).includes('iVBOR'), false);
  assert.equal(Object.isFrozen(result.evidence), true);
});

test('source scripts and remote resources never execute and become explicit omissions', async () => {
  assert.equal(typeof renderer.renderSvg, 'function');
  const result = await renderer.renderSvg({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="throw new Error(1)"><script>document.body.innerHTML="bad"</script><image href="https://example.invalid/image.png" width="50" height="50"/><rect width="20" height="20"/></svg>', context });
  assert.ok(result.images[0].data.subarray(0, 8).equals(evidenceApi.PNG_SIGNATURE));
  assert.ok(result.evidence.omissions.some(o => o.kind === 'active-content-removed'));
  assert.ok(result.evidence.omissions.some(o => o.kind === 'external-resource-blocked'));
  assert.equal(result.evidence.coverage.complete, false);
});

test('artifact resolution validates basename, confinement, size and hash', async () => {
  assert.equal(typeof evidenceApi.readVerifiedArtifact, 'function');
  const dir = await mkdtemp(path.join(tmpdir(), 'knime-artifact-test-'));
  try {
    const data = Buffer.from('<svg/>'), sha256 = createHash('sha256').update(data).digest('hex');
    await writeFile(path.join(dir, 'frame.svg'), data);
    assert.deepEqual(await evidenceApi.readVerifiedArtifact(dir, { artifactId: 'frame.svg', sha256, bytes: data.length }), data);
    await assert.rejects(evidenceApi.readVerifiedArtifact(dir, { artifactId: '../outside.svg', sha256, bytes: data.length }), /artifact/i);
    await assert.rejects(evidenceApi.readVerifiedArtifact(dir, { artifactId: 'frame.svg', sha256: '0'.repeat(64), bytes: data.length }), /hash/i);
    await assert.rejects(evidenceApi.readVerifiedArtifact(dir, { artifactId: 'frame.svg', sha256, bytes: 100 }), /size/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('image evidence rejects invalid transforms, payload dimensions and lying complete coverage', async () => {
  assert.equal(typeof evidenceApi.validateCanvasEvidence, 'function');
  const valid = await renderer.renderSvg({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="5" y="20">Readable</text></svg>', context });
  const bad = structuredClone(valid.evidence);
  bad.artifacts[0].workflowToPixel = [1, 2];
  assert.throws(() => evidenceApi.validateCanvasEvidence(bad), /transform/i);
  assert.throws(() => evidenceApi.validatePng(Buffer.from('wrong'), { width: 10, height: 10 }), /PNG/i);
  assert.throws(() => evidenceApi.validatePng(valid.images[0].data.subarray(0, 33), valid.evidence.artifacts[0]), /PNG/i);
  const corrupted = Buffer.from(valid.images[0].data); corrupted[40] ^= 0xff;
  assert.throws(() => evidenceApi.validatePng(corrupted), /PNG/i);
  const dimensions = structuredClone(valid.evidence.artifacts[0]); dimensions.width++;
  assert.throws(() => evidenceApi.validatePng(valid.images[0].data, dimensions), /dimensions/i);
  const incomplete = structuredClone(valid.evidence); incomplete.coverage.requiredTileIds.push('missing'); incomplete.coverage.complete = true;
  assert.throws(() => evidenceApi.validateCanvasEvidence(incomplete), /coverage/i);
});
