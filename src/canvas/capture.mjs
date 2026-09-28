import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from '../client.mjs';
import { createCanvasEvidence, readVerifiedArtifact, sha256, validatePng } from './evidence.mjs';
import { renderSvg } from './render.mjs';

const revisionsEqual = (a, b) => !!a && !!b && ['structure','configuration','layout', 'execution'].every(k => typeof a[k] === 'string' && a[k] === b[k]);
function sameTarget(expected, actual) {
  if (!actual || ['contextId', 'sessionId', 'projectId', 'workflowId'].some(k => expected[k] !== actual[k])) throw new BridgeError('CONTEXT_CHANGED', 'Capture target changed; bind the intended session, project and scope again.');
}

/** Captures only the bound native target. Saved artifacts retain saved-only provenance. */
export async function captureCanvas({ client, context, artifactDirectory, mode = 'overview', crop, scale, reuseEvidence, options = {} }) {
  if (!client?.call || !context?.contextId || !context.sessionId || !artifactDirectory) throw new BridgeError('INVALID_ARGUMENT', 'Capture requires client, bound session context and its artifact directory.');
  const retries = options.retries ?? 1;
  if (![0, 1].includes(retries)) throw new BridgeError('INVALID_ARGUMENT', 'At most one capture retry is permitted.');
  for (let attempt = 0; attempt <= retries; attempt++) {
    const before = await client.call('context.inspect', { contextId: context.contextId }, { session: context.sessionId });
    sameTarget(context, before);
    let native;
    if (reuseEvidence) {
      if (mode === 'viewport' || reuseEvidence.sourceKind === 'live-viewport' || !reuseEvidence.sourceArtifact) throw new BridgeError('UNSUPPORTED_CAPTURE_SOURCE', 'Only immutable SVG source frames support paging.');
      if (reuseEvidence.contextId !== context.contextId || reuseEvidence.sessionId !== context.sessionId || reuseEvidence.scopeId !== context.workflowId) throw new BridgeError('CONTEXT_CHANGED', 'Source frame belongs to another bound target.');
      if (!revisionsEqual(before.revisions, reuseEvidence.revisions)) throw new BridgeError('REVISION_CONFLICT', 'Source frame is stale; capture a fresh native frame before review.');
      native = { artifact: reuseEvidence.sourceArtifact, sourceKind: reuseEvidence.sourceKind, freshness: reuseEvidence.freshness, nativeLayout: reuseEvidence.nativeLayout, omissions: reuseEvidence.omissions.filter(o => !['image-byte-budget-exceeded', 'image-pixel-budget-exceeded', 'tile-manifest-budget-exceeded'].includes(o.kind)), coverage: reuseEvidence.coverage.gaps?.some(g => g.kind === 'native-provider-coverage-incomplete') ? { complete: false } : undefined };
    }
    try { native ??= await client.call(mode === 'viewport' ? 'canvas.viewport' : 'canvas.preview', { contextId: context.contextId }, { session: context.sessionId }); }
    catch (error) { if (error.code === 'CHANGED_DURING_CAPTURE' && attempt < retries) continue; throw error; }
    if (native.context) sameTarget(context, native.context);
    if (!['native-preview', 'saved-preview', 'live-viewport'].includes(native.sourceKind)) throw new BridgeError('UNSUPPORTED_CAPTURE_SOURCE', 'Native provider did not establish the capture source kind.');
    const artifact = native.artifact || { artifactId: native.artifactId, relativePath: native.relativePath, mimeType: native.mimeType, sha256: native.sha256, bytes: native.bytes };
    const data = await readVerifiedArtifact(artifactDirectory, artifact);
    const after = await client.call('context.inspect', { contextId: context.contextId }, { session: context.sessionId });
    sameTarget(context, after);
    const stable = revisionsEqual(before.revisions, after.revisions) && (!native.beforeRevisions || revisionsEqual(before.revisions, native.beforeRevisions)) && (!native.afterRevisions || revisionsEqual(after.revisions, native.afterRevisions));
    if (!stable) {
      if (attempt < retries) continue;
      throw new BridgeError('CHANGED_DURING_CAPTURE', 'Relevant workflow revisions changed during capture; this frame cannot certify the requested state.', { before: before.revisions, after: after.revisions, attempts: attempt + 1 });
    }
    const sourceFrameId = reuseEvidence?.sourceFrameId || randomUUID();
    if (artifact.mimeType === 'image/svg+xml') {
      const result = await renderSvg({ svg: data.toString('utf8'), context: after, sourceKind: native.sourceKind, sourceFrameId, freshness: native.sourceKind === 'saved-preview' ? 'saved-only' : native.freshness || 'model-stable-render-unconfirmed', outputDirectory: artifactDirectory, sourceArtifact: artifact, nativeLayout: native.nativeLayout, omissions: native.omissions || [], nativeCoverage: native.coverage, expectedFrameEvidence: reuseEvidence, options: { ...options, mode: mode === 'viewport' ? 'overview' : mode, crop, scale, deviceScaleFactor: reuseEvidence?.renderer.deviceScaleFactor ?? options.deviceScaleFactor ?? 1, maxImages: options.maxImages ?? (mode === 'tiles' ? Math.min(8, (options.tileLimit ?? 1) + 1) : 1) } });
      const finalContext = await client.call('context.inspect', { contextId: context.contextId }, { session: context.sessionId });
      sameTarget(context, finalContext);
      if (!revisionsEqual(after.revisions, finalContext.revisions)) {
        if (attempt < retries) continue;
        throw new BridgeError('CHANGED_DURING_CAPTURE', 'Workflow changed while rasterizing the immutable native frame.', { before: after.revisions, after: finalContext.revisions, attempts: attempt + 1 });
      }
      if (native.nativeLayout) {
        result.geometry.nativeLayout = structuredClone(native.nativeLayout);
        for (const node of result.geometry.nodes) {
          const exact = native.nativeLayout.nodes?.find(n => n.id === node.id);
          if (exact?.position) node.position = structuredClone(exact.position);
        }
        for (const annotation of result.geometry.annotations) {
          const exact = native.nativeLayout.annotations?.find(a => a.id === annotation.id);
          if (exact?.bounds) annotation.nativeBounds = structuredClone(exact.bounds);
        }
        for (const connection of result.geometry.connections) {
          const exact = native.nativeLayout.connections?.find(c => c.id === connection.id);
          if (exact?.bendpoints) connection.bendpoints = structuredClone(exact.bendpoints);
        }
      }
      return { ...result, context: finalContext };
    }
    if (artifact.mimeType !== 'image/png' || native.sourceKind !== 'live-viewport') throw new BridgeError('UNSUPPORTED_CAPTURE_FORMAT', 'Expected native SVG preview or live viewport PNG.');
    const { width, height } = validatePng(data), artifactId = `${sourceFrameId}-viewport.png`;
    const viewportArtifact = { artifactId, sourceFrameId, mimeType: 'image/png', sha256: sha256(data), bytes: data.length, width, height, role: 'viewport', cropWorkflowBounds: null, workflowToPixel: null, hostDownsampling: 'unknown' };
    const evidence = createCanvasEvidence({ contextId: after.contextId, sessionId: after.sessionId, scopeId: after.workflowId, layoutRevision: after.revisions.layout, executionRevision: after.revisions.execution, sourceFrameId, sourceKind: 'live-viewport', freshness: 'model-stable-render-unconfirmed', renderer: { name: native.renderer?.name || 'KNIME embedded browser', version: native.renderer?.version || 'unknown', fontsReady: false }, coverage: { bounds: null, requiredTileIds: [artifactId], omittedTileIds: [], omittedObjectIds: [], complete: false, gaps: [{ kind: 'viewport-workflow-transform-unproved' }, { kind: 'frontend-synchronization-unproved' }] }, sourceArtifact: artifact, artifacts: [viewportArtifact], omissions: native.omissions || [], delivery: { serverEmittedArtifactIds: [], hostDelivery: 'unconfirmed', hostDownsampling: 'unknown' } });
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(path.join(artifactDirectory, artifactId), data, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(artifactDirectory, `${evidence.evidenceId}.json`), JSON.stringify({ evidence }, null, 2), { flag: 'wx', mode: 0o600 });
    return { evidence, images: [{ artifactId, mimeType: 'image/png', data }], geometry: null, context: after };
  }
}
