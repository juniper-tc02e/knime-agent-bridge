import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { validRect } from '../layout/geometry.mjs';

export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const LIMITS = Object.freeze({ imageBytes: 4 * 1024 * 1024, imagePixels: 16_000_000, toolBytes: 6 * 1024 * 1024, sourceBytes: 32 * 1024 * 1024, maxImages: 8, maxTiles: 4096 });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function deepFreeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
function invalid(message) { const error = new Error(message); error.code = 'INVALID_CANVAS_EVIDENCE'; throw error; }
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function validatePng(data, metadata = {}) {
  if (!Buffer.isBuffer(data) || data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('ascii', 12, 16) !== 'IHDR') invalid('Image payload is not a PNG.');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width * height > LIMITS.imagePixels || data.length > LIMITS.imageBytes) invalid('PNG exceeds image dimensions or byte budget.');
  let offset = 8, ended = false; const compressed = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset), end = offset + 12 + length;
    if (end > data.length || end < offset) invalid('PNG chunk is truncated.');
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) invalid('PNG chunk checksum mismatch.');
    if (type === 'IHDR' && (offset !== 8 || length !== 13)) invalid('PNG header is invalid.');
    if (type === 'IDAT') compressed.push(data.subarray(offset + 8, offset + 8 + length));
    offset = end;
    if (type === 'IEND') { if (length !== 0 || offset !== data.length) invalid('PNG ending is invalid.'); ended = true; break; }
  }
  if (!ended || !compressed.length) invalid('PNG pixel payload or ending is missing.');
  try { if (!inflateSync(Buffer.concat(compressed), { maxOutputLength: LIMITS.imagePixels * 8 + height * 8 }).length) invalid('PNG pixel payload is empty.'); }
  catch { invalid('PNG pixel payload cannot be decoded within budget.'); }
  if ((metadata.width !== undefined && metadata.width !== width) || (metadata.height !== undefined && metadata.height !== height)) invalid('PNG dimensions do not match artifact metadata.');
  if (metadata.bytes !== undefined && metadata.bytes !== data.length) invalid('PNG size does not match artifact metadata.');
  if (metadata.sha256 !== undefined && metadata.sha256 !== sha256(data)) invalid('PNG hash does not match artifact metadata.');
  return { width, height };
}
export function validateCanvasEvidence(evidence) {
  for (const field of ['evidenceId', 'contextId', 'scopeId', 'sourceFrameId', 'layoutRevision', 'executionRevision', 'capturedAt']) if (typeof evidence?.[field] !== 'string' || !evidence[field]) invalid(`Missing canvas evidence ${field}.`);
  if (!['native-preview', 'live-viewport', 'saved-preview', 'synthetic-proposal'].includes(evidence.sourceKind)) invalid('Invalid canvas source kind.');
  if (!['verified', 'model-stable-render-unconfirmed', 'saved-only', 'unknown'].includes(evidence.freshness)) invalid('Invalid canvas freshness.');
  if (evidence.sourceKind === 'saved-preview' && evidence.freshness !== 'saved-only') invalid('Saved preview cannot claim live freshness.');
  if (!evidence.renderer || typeof evidence.renderer.fontsReady !== 'boolean') invalid('Renderer font coverage is required.');
  if (!evidence.coverage || !Array.isArray(evidence.coverage.requiredTileIds) || !Array.isArray(evidence.coverage.omittedObjectIds) || typeof evidence.coverage.complete !== 'boolean') invalid('Invalid canvas coverage manifest.');
  if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length > LIMITS.maxImages) invalid('Invalid image artifact budget.');
  const ids = new Set(); let encodedBytes = 0;
  for (const artifact of evidence.artifacts) {
    if (typeof artifact.artifactId !== 'string' || ids.has(artifact.artifactId) || artifact.sourceFrameId !== evidence.sourceFrameId || artifact.mimeType !== 'image/png' || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) invalid('Invalid image artifact identity, type, hash or source frame.');
    ids.add(artifact.artifactId);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > LIMITS.imageBytes || !Number.isSafeInteger(artifact.width) || !Number.isSafeInteger(artifact.height) || artifact.width <= 0 || artifact.height <= 0 || artifact.width * artifact.height > LIMITS.imagePixels) invalid('Invalid artifact dimensions or byte budget.');
    const t = artifact.workflowToPixel;
    if (t !== null && (!Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite) || Math.abs(t[0] * t[3] - t[1] * t[2]) < 1e-15)) invalid('Invalid workflow-to-pixel transform.');
    if (t !== null && !validRect(artifact.cropWorkflowBounds)) invalid('A mapped image requires workflow crop bounds.');
    if (t === null && evidence.coverage.complete) invalid('Unproved transform cannot have complete coverage.');
    encodedBytes += 4 * Math.ceil(artifact.bytes / 3);
  }
  if (encodedBytes + Buffer.byteLength(JSON.stringify(evidence)) > LIMITS.toolBytes) invalid('Canvas evidence exceeds total tool content budget.');
  if (evidence.coverage.complete && (evidence.coverage.requiredTileIds.some(id => !ids.has(id)) || evidence.coverage.omittedObjectIds.length || evidence.coverage.omittedTileIds?.length || evidence.coverage.gaps?.length || evidence.omissions?.length || !evidence.renderer.fontsReady)) invalid('Complete coverage contradicts missing tiles, resources, measurements or fonts.');
  return evidence;
}
export function createCanvasEvidence(metadata) {
  return deepFreeze(validateCanvasEvidence(structuredClone({ evidenceId: randomUUID(), capturedAt: new Date().toISOString(), ...metadata })));
}

export async function writeImmutableArtifact(file, data) {
  try { await writeFile(file, data, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(file);
    if (sha256(existing) !== sha256(data)) { const mismatch = new Error('Immutable image artifact changed during source-frame replay.'); mismatch.code = 'RENDER_MISMATCH'; throw mismatch; }
  }
}

/** Native references are names under one selected session, never caller-selected paths. */
export async function readVerifiedArtifact(directory, artifact) {
  const name = artifact?.relativePath ?? artifact?.artifactId;
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(name) || name.includes('..') || path.basename(name) !== name) invalid('Invalid native artifact ID/path.');
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256 || '') || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > LIMITS.sourceBytes) invalid('Invalid native artifact size or hash.');
  const root = await realpath(directory), target = await realpath(path.join(root, name)), relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') invalid('Native artifact escapes session artifact directory.');
  const info = await stat(target);
  if (!info.isFile() || info.size !== artifact.bytes || info.size > LIMITS.sourceBytes) invalid('Native artifact size mismatch.');
  const data = await readFile(target);
  if (data.length !== artifact.bytes) invalid('Native artifact size changed while reading.');
  if (sha256(data) !== artifact.sha256) invalid('Native artifact hash mismatch.');
  return data;
}
