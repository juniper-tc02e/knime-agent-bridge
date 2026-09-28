import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const { captureCanvas } = await import('../src/canvas/capture.mjs').catch(() => ({}));
const ctx = { contextId: 'ctx', sessionId: 's', projectId: 'p', workflowId: 'root', revisions: { structure:'s1',configuration:'c1',layout: 'r', execution: 'e' } };
async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'knime-capture-test-'));
  const data = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="5" y="20">Frame</text></svg>');
  await writeFile(path.join(dir, 'source.svg'), data);
  const native = { artifactId: 'source', relativePath: 'source.svg', mimeType: 'image/svg+xml', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), context: ctx, beforeRevisions: ctx.revisions, afterRevisions: ctx.revisions, sourceKind: 'native-preview', freshness: 'model-stable-render-unconfirmed' };
  try { await run(dir, native); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('capture pins the original session and preserves stable-but-unconfirmed render freshness', async () => {
  assert.equal(typeof captureCanvas, 'function');
  await fixture(async (dir, native) => {
    const calls = [], client = { async call(op, args, options) { calls.push({ op, args, options }); return op === 'context.inspect' ? ctx : native; } };
    const result = await captureCanvas({ client, context: ctx, artifactDirectory: dir });
    assert.ok(calls.every(c => c.options.session === 's'));
    assert.equal(calls.filter(c => c.op === 'context.inspect').length, 3);
    assert.equal(result.evidence.freshness, 'model-stable-render-unconfirmed');
    assert.equal(result.evidence.sourceArtifact.sha256, native.sha256);
    assert.equal(result.images.length, 1);
  });
});
test('changing revisions during capture cannot produce a stale certified frame', async () => {
  assert.equal(typeof captureCanvas, 'function');
  await fixture(async (dir, native) => {
    let counter = 0;
    const client = { async call(op) { if (op === 'context.inspect') return { ...ctx, revisions: { ...ctx.revisions, layout: `r${counter++}` } }; return { ...native, beforeRevisions: undefined, afterRevisions: undefined }; } };
    await assert.rejects(captureCanvas({ client, context: ctx, artifactDirectory: dir, options: { retries: 0 } }), error => error.code === 'CHANGED_DURING_CAPTURE');
  });
});
test('saved preview stays saved-only and wrong project response rejects', async () => {
  assert.equal(typeof captureCanvas, 'function');
  await fixture(async (dir, native) => {
    const client = { async call(op) { return op === 'context.inspect' ? ctx : { ...native, sourceKind: 'saved-preview', freshness: 'verified' }; } };
    const result = await captureCanvas({ client, context: ctx, artifactDirectory: dir });
    assert.equal(result.evidence.sourceKind, 'saved-preview');
    assert.equal(result.evidence.freshness, 'saved-only');
    const wrong = { async call(op) { return op === 'context.inspect' ? ctx : { ...native, context: { ...ctx, projectId: 'other' } }; } };
    await assert.rejects(captureCanvas({ client: wrong, context: ctx, artifactDirectory: dir }), error => error.code === 'CONTEXT_CHANGED');
  });
});

test('configuration changes after native capture cannot be relabelled as current evidence',async()=>{
 await fixture(async(dir,native)=>{
  let reads=0;
  const client={async call(op){if(op==='context.inspect')return {...ctx,revisions:{...ctx.revisions,configuration:reads++===0?'c1':'c2'}};return {...native,freshness:'verified'};}};
  await assert.rejects(captureCanvas({client,context:ctx,artifactDirectory:dir,options:{retries:0}}),{code:'CHANGED_DURING_CAPTURE'});
 });
});

test('immutable source paging reuses sourceFrame and stable required tile IDs without new native capture', async () => {
  await fixture(async (dir, native) => {
    const big = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4000 2400"><text x="5" y="20">Paged frame</text></svg>');
    await writeFile(path.join(dir, 'source.svg'), big);
    native.bytes = big.length; native.sha256 = createHash('sha256').update(big).digest('hex');
    let captures = 0;
    const client = { async call(op) { if (op === 'context.inspect') return ctx; captures++; return native; } };
    const first = await captureCanvas({ client, context: ctx, artifactDirectory: dir, mode: 'tiles', options: { tileLimit: 1 } });
    const second = await captureCanvas({ client, context: ctx, artifactDirectory: dir, mode: 'tiles', reuseEvidence: first.evidence, options: { tileOffset: 1, tileLimit: 1 } });
    assert.equal(captures, 1);
    assert.equal(second.evidence.sourceFrameId, first.evidence.sourceFrameId);
    assert.deepEqual(second.evidence.coverage.requiredTileIds, first.evidence.coverage.requiredTileIds);
    assert.notEqual(second.evidence.evidenceId, first.evidence.evidenceId);
    assert.equal(second.evidence.artifacts[0].sha256, first.evidence.artifacts[0].sha256);
    assert.notEqual(second.evidence.artifacts[1].artifactId, first.evidence.artifacts[1].artifactId);
    const staleClient = { async call() { return { ...ctx, revisions: { ...ctx.revisions, layout: 'later' } }; } };
    await assert.rejects(captureCanvas({ client: staleClient, context: ctx, artifactDirectory: dir, mode: 'tiles', reuseEvidence: first.evidence }), error => error.code === 'REVISION_CONFLICT');
  });
});
