import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createCanvasEvidence, LIMITS, sha256, validatePng, writeImmutableArtifact } from './evidence.mjs';
import { flattenPath, intersectRects, validRect } from '../layout/geometry.mjs';

/** Runs only our fixed measurement function, in a private page with source scripts disabled. */
function measureDocument() {
  const svg = document.querySelector('body > svg'), rootInverse = svg.getScreenCTM().inverse();
  const gaps = [], nodes = [], annotations = [], texts = [], connections = [];
  const matrix = m => [m.a, m.b, m.c, m.d, m.e, m.f];
  const convert = r => {
    const points = [[r.left ?? r.x, r.top ?? r.y], [(r.left ?? r.x) + r.width, r.top ?? r.y], [r.left ?? r.x, (r.top ?? r.y) + r.height], [(r.left ?? r.x) + r.width, (r.top ?? r.y) + r.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(rootInverse));
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
    return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
  };
  const bbox = e => convert(e.getBoundingClientRect());
  const union = rs => { const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y)); return { x, y, width: Math.max(...rs.map(r => r.x + r.width)) - x, height: Math.max(...rs.map(r => r.y + r.height)) - y }; };
  const intersect = (a, b) => { const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y); return { x, y, width, height }; };
  const owner = el => { const parent = el.closest('[data-node-id],[data-annotation-id],[data-connector-id]'); return parent?.getAttribute('data-node-id') || parent?.getAttribute('data-annotation-id') || parent?.getAttribute('data-connector-id') || null; };
  for (const el of svg.querySelectorAll('[data-node-id]')) {
    const id = el.getAttribute('data-node-id');
    if (el.parentElement.closest('[data-node-id]')) continue;
    const parts = [...el.querySelectorAll('circle,rect,path,polygon,image')].filter(e => !e.closest('defs') && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden').map((e, i) => ({ id: `${id}:part:${i}`, kind: e.localName, bounds: bbox(e) }));
    const portContacts = [...el.querySelectorAll('[data-port-index],[data-port-id],.port,polygon')].map(p => { const r = bbox(p); return { x: r.x + r.width / 2, y: r.y + r.height / 2, radius: Math.max(r.width, r.height) / 2, identityBasis: p.localName === 'polygon' ? 'rendered-polygon-endpoint-contact' : 'native-port-attribute' }; });
    nodes.push({ id, bounds: bbox(el), parts, portContacts, measurement: 'rendered-dom' });
  }
  for (const el of svg.querySelectorAll('[data-annotation-id]')) if (!el.parentElement.closest('[data-annotation-id]')) annotations.push({ id: el.getAttribute('data-annotation-id'), bounds: bbox(el), semantics: 'container' });
  for (const el of svg.querySelectorAll('[data-connector-id]')) {
    if (el.parentElement.closest('[data-connector-id]')) continue;
    const paths = el.localName === 'path' ? [el] : [...el.querySelectorAll('path')];
    const id = el.getAttribute('data-connector-id'), transforms = paths.map(p => matrix(rootInverse.multiply(p.getScreenCTM())));
    const sameTransform = transforms.every(t => JSON.stringify(t) === JSON.stringify(transforms[0]));
    const t = transforms[0] || [1, 0, 0, 1, 0, 0];
    connections.push({ id, paths: paths.map((p, i) => sameTransform ? p.getAttribute('d') : { d: p.getAttribute('d'), transform: transforms[i] }), transform: t, strokeWidth: paths.length ? Number.parseFloat(getComputedStyle(paths[0]).strokeWidth) || 1 : 1, strokeScale: Math.max(Math.hypot(t[0], t[1]), Math.hypot(t[2], t[3])), sourceNodeId: el.getAttribute('data-source-node-id') || undefined, targetNodeId: el.getAttribute('data-target-node-id') || undefined });
  }
  const walker = document.createTreeWalker(svg, NodeFilter.SHOW_TEXT); let textNode, index = 0;
  while ((textNode = walker.nextNode())) {
    const el = textNode.parentElement;
    if (!textNode.textContent.trim() || ['style', 'script', 'title', 'desc'].includes(el.localName) || el.closest('defs')) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const range = document.createRange(); range.selectNodeContents(textNode);
    const originalRects = [...range.getClientRects()];
    for (const raw of originalRects) {
      if (!raw.width || !raw.height) continue;
      const unclippedBounds = convert(raw); let bounds = { ...unclippedBounds }, clipped = false;
      for (let ancestor = el; ancestor && ancestor !== svg; ancestor = ancestor.parentElement) {
        const css = getComputedStyle(ancestor);
        if (/(hidden|clip|scroll|auto)/.test(`${css.overflowX} ${css.overflowY}`) || ancestor.localName === 'foreignObject') bounds = intersect(bounds, bbox(ancestor));
        if (css.clipPath && css.clipPath !== 'none') gaps.push({ kind: 'clip-path-geometry-unavailable', objectId: owner(el), requiredCrop: bbox(ancestor) });
      }
      const loss = Math.max(unclippedBounds.width - bounds.width, unclippedBounds.height - bounds.height);
      clipped = loss > 1.5;
      texts.push({ id: `${owner(el) || 'text'}:text:${index++}`, ownerId: owner(el), kind: el.closest('li') ? 'list-text' : 'text', text: textNode.textContent, bounds, unclippedBounds, clipped, clippingEdge: loss > 0.5 && !clipped, ...(clipped ? { hiddenText: textNode.textContent } : {}) });
    }
  }
  for (const node of nodes) {
    node.parts.push(...texts.filter(t => t.ownerId === node.id && t.bounds.width > 0 && t.bounds.height > 0).map(t => ({ id: t.id, kind: 'text', bounds: t.bounds })));
    if (node.parts.length) node.bounds = union(node.parts.map(p => p.bounds));
    else gaps.push({ kind: 'unresolved-node-footprint', objectId: node.id });
  }
  // Browser ranges exclude generated bullets/counters. Without native pixel equivalence,
  // claiming explicit-marker clones are exact would create false clean certificates.
  for (const el of svg.querySelectorAll('li')) {
    if (getComputedStyle(el).listStyleType !== 'none' || !['normal', 'none'].includes(getComputedStyle(el, '::marker').content)) gaps.push({ kind: 'marker-geometry-unavailable', objectId: owner(el), requiredCrop: bbox(el), reason: 'Generated marker/native-pixel correspondence is not validated; visual review required.' });
  }
  for (const el of svg.querySelectorAll('*')) for (const pseudo of ['::before', '::after']) {
    const content = getComputedStyle(el, pseudo).content;
    if (content && !['none', 'normal', '""'].includes(content)) gaps.push({ kind: 'pseudo-element-geometry-unavailable', objectId: owner(el), requiredCrop: bbox(el) });
  }
  for (const p of svg.querySelectorAll('path')) if (!p.closest('[data-node-id],[data-connector-id],[data-annotation-id],defs')) gaps.push({ kind: 'unidentified-path', requiredCrop: bbox(p) });
  const fonts = [...document.fonts].map(f => ({ family: f.family, status: f.status }));
  for (const font of fonts) if (font.status !== 'loaded') gaps.push({ kind: 'font-unavailable', family: font.family });
  return { nodes, annotations, texts, connections, fonts, coverage: { complete: !gaps.length, gaps } };
}

function tileManifest(bounds, scale, sourceFrameId) {
  const tiles = [], width = 1600 / scale, height = 1200 / scale, dx = (1600 - 96) / scale, dy = (1200 - 96) / scale;
  const columns = Math.max(1, Math.ceil(Math.max(0, bounds.width - width) / dx) + 1), rows = Math.max(1, Math.ceil(Math.max(0, bounds.height - height) / dy) + 1);
  if (columns * rows > LIMITS.maxTiles) return { tiles: [], gap: { kind: 'tile-manifest-budget-exceeded', requiredRegions: columns * rows, requiredCrop: bounds } };
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const x = bounds.x + column * dx, y = bounds.y + row * dy;
    tiles.push({ artifactId: `${sourceFrameId}-tile-${row}-${column}.png`, role: 'detail', crop: { x, y, width: Math.min(width, bounds.x + bounds.width - x), height: Math.min(height, bounds.y + bounds.height - y) }, scale });
  }
  return { tiles };
}

export async function renderSvg({ svg, context, sourceKind = 'native-preview', sourceFrameId = randomUUID(), freshness = 'model-stable-render-unconfirmed', outputDirectory, sourceArtifact, nativeLayout, omissions: initialOmissions = [], nativeCoverage, expectedFrameEvidence, options = {} }) {
  if (typeof svg !== 'string' || Buffer.byteLength(svg) > LIMITS.sourceBytes) throw new TypeError('SVG source exceeds the bounded source budget.');
  if (!context?.contextId) throw new TypeError('A bound canvas context is required.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(sourceFrameId)) throw new TypeError('A safe immutable source frame ID is required.');
  const { mode = 'overview', crop, scale, deviceScaleFactor = 1, maxImages = 4, tileOffset = 0 } = options;
  if (!['overview', 'tiles', 'crop', 'detail'].includes(mode)) throw new TypeError('Render mode must be overview, tiles, crop, or detail.');
  if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0 || scale > 8)) throw new TypeError('Scale must be in (0,8].');
  if (![1, 2, 3].includes(deviceScaleFactor) || !Number.isSafeInteger(maxImages) || maxImages < 1 || maxImages > LIMITS.maxImages || !Number.isSafeInteger(tileOffset) || tileOffset < 0) throw new TypeError('Invalid render image budget, tile offset or device scale.');
  if (crop && (!validRect(crop) || crop.width <= 0 || crop.height <= 0)) throw new TypeError('A positive workflow crop is required.');
  const omissions = structuredClone(initialOmissions), browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-first-run'] });
  try {
    if (expectedFrameEvidence && expectedFrameEvidence.renderer.version !== browser.version()) { const error = new Error('Source-frame replay requires the original renderer version.'); error.code = 'RENDER_MISMATCH'; throw error; }
    const isolated = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', deviceScaleFactor, viewport: { width: 1600, height: 1200 } });
    await isolated.route('**/*', route => { omissions.push({ kind: 'external-resource-blocked', resource: route.request().url().slice(0, 500) }); return route.abort(); });
    const page = await isolated.newPage();
    await page.setContent('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; base-uri \'none\'; form-action \'none\'"><style>html,body{margin:0;padding:0;background:white;overflow:hidden}body>svg{display:block}</style></head><body></body></html>');
    const prepared = await page.evaluate(source => {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw new Error('Invalid SVG document.');
      const svg = doc.documentElement, omissions = [];
      if (svg.querySelectorAll('*').length > 20000) throw new Error('SVG element count exceeds measurement budget.');
      for (const el of [...svg.querySelectorAll('*')]) if (['script', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'animateTransform', 'animateMotion', 'set', 'discard'].includes(el.localName)) { omissions.push({ kind: 'active-content-removed', element: el.localName }); el.remove(); }
      for (const el of [svg, ...svg.querySelectorAll('*')]) for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) { el.removeAttribute(attr.name); omissions.push({ kind: 'active-content-removed', attribute: attr.name }); }
        if (/^(href|xlink:href|src)$/i.test(attr.name) && !attr.value.startsWith('#') && !/^data:(image\/|font\/|application\/font|application\/x-font)/i.test(attr.value)) { omissions.push({ kind: 'external-resource-blocked', resource: attr.value.slice(0, 500) }); el.removeAttribute(attr.name); }
      }
      for (const el of [svg, ...svg.querySelectorAll('*')]) {
        const css = `${el.getAttribute('style') || ''} ${el.localName === 'style' ? el.textContent : ''}`;
        if (/@import/i.test(css) || /url\(\s*['"]?(?!data:|#)/i.test(css)) omissions.push({ kind: 'external-css-resource-unavailable' });
      }
      document.body.append(document.importNode(svg, true));
      const root = document.querySelector('body > svg');
      let b = root.viewBox.baseVal;
      if (!b.width || !b.height) {
        const width = Number.parseFloat(root.getAttribute('width')), height = Number.parseFloat(root.getAttribute('height'));
        if (!(width > 0 && height > 0)) throw new Error('SVG has no finite positive viewBox or dimensions.');
        root.setAttribute('viewBox', `0 0 ${width} ${height}`); b = root.viewBox.baseVal;
      }
      if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width > 1e7 || b.height > 1e7) throw new Error('SVG coordinate bounds exceed measurement budget.');
      root.setAttribute('width', b.width); root.setAttribute('height', b.height); root.setAttribute('preserveAspectRatio', 'none');
      return { bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, omissions };
    }, svg);
    omissions.push(...prepared.omissions);
    const fontsReady = await page.evaluate(async () => Promise.race([document.fonts.ready.then(() => document.fonts.status === 'loaded'), new Promise(resolve => setTimeout(() => resolve(false), 5000))]));
    if (!fontsReady) omissions.push({ kind: 'font-readiness-timeout' });
    const geometry = await page.evaluate(measureDocument);
    // The native preview does not label port polygons. Resolve only unique, measured
    // endpoint contact with a node's rendered port; no logical IDs are reconstructed.
    for (const connection of geometry.connections) {
      const segments = connection.paths.flatMap(p => flattenPath(typeof p === 'string' ? p : p.d, { transform: typeof p === 'string' ? connection.transform : p.transform }).segments);
      if (!segments.length) continue;
      for (const [field, endpoint] of [['sourceNodeId', segments[0].a], ['targetNodeId', segments.at(-1).b]]) {
        if (connection[field]) continue;
        const matches = geometry.nodes.filter(n => n.portContacts.some(p => Math.hypot(p.x - endpoint.x, p.y - endpoint.y) <= p.radius + 3));
        if (matches.length === 1) { connection[field] = matches[0].id; connection.endpointIdentityBasis = 'unique-rendered-port-contact'; }
      }
    }
    const fullBounds = prepared.bounds, bounds = crop ? intersectRects(fullBounds, crop) : fullBounds;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new TypeError('Crop does not intersect the native frame.');
    geometry.bounds = fullBounds; geometry.sourceFrameId = sourceFrameId;
    const minTextHeight = Math.min(...geometry.texts.filter(t => t.bounds.height > 0).map(t => t.bounds.height), 14);
    const overviewScale = Math.min(1600 / bounds.width, 1600 / bounds.height, scale || 1), detailScale = scale || Math.min(8, Math.max(1, 14 / minTextHeight));
    const renderParameters = { bounds, overviewScale, detailScale, deviceScaleFactor }, renderVariant = sha256(JSON.stringify(renderParameters)).slice(0, 12), imagePrefix = `${sourceFrameId}-${renderVariant}`;
    const overview = { artifactId: `${imagePrefix}-overview.png`, role: 'overview', crop: bounds, scale: overviewScale };
    const manifest = tileManifest(bounds, detailScale, imagePrefix);
    if (manifest.gap) omissions.push(manifest.gap);
    const overviewReadable = minTextHeight * overviewScale >= 14 && !crop;
    let required = overviewReadable ? [overview] : manifest.tiles;
    let planned = [overview];
    if (mode === 'tiles') planned = [overview, ...manifest.tiles.slice(tileOffset, tileOffset + maxImages - 1)];
    if (mode === 'crop' || mode === 'detail') {
      if (!crop) throw new TypeError('Detail capture requires workflow crop bounds.');
      planned = [{ artifactId: `${imagePrefix}-crop.png`, role: 'detail', crop: bounds, scale: detailScale }]; required = planned;
    }
    const images = [], artifacts = []; let encodedBytes = 0;
    for (const tile of planned.slice(0, maxImages)) {
      const width = Math.max(1, Math.ceil(tile.crop.width * tile.scale)), height = Math.max(1, Math.ceil(tile.crop.height * tile.scale));
      if (width * height > LIMITS.imagePixels || width > 8192 || height > 8192) { omissions.push({ kind: 'image-pixel-budget-exceeded', artifactId: tile.artifactId, requiredCrop: tile.crop }); continue; }
      await page.setViewportSize({ width: Math.ceil(width / deviceScaleFactor), height: Math.ceil(height / deviceScaleFactor) });
      await page.evaluate(({ crop, width, height, dsf }) => { const root = document.querySelector('body > svg'); root.setAttribute('viewBox', `${crop.x} ${crop.y} ${crop.width} ${crop.height}`); root.setAttribute('width', width / dsf); root.setAttribute('height', height / dsf); }, { crop: tile.crop, width, height, dsf: deviceScaleFactor });
      const data = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: width / deviceScaleFactor, height: height / deviceScaleFactor }, animations: 'disabled', timeout: 15000 });
      if (data.length > LIMITS.imageBytes || encodedBytes + Math.ceil(data.length / 3) * 4 > LIMITS.toolBytes - 256 * 1024) { omissions.push({ kind: 'image-byte-budget-exceeded', artifactId: tile.artifactId, requiredCrop: tile.crop }); continue; }
      const actual = validatePng(data), sx = actual.width / tile.crop.width, sy = actual.height / tile.crop.height;
      artifacts.push({ artifactId: tile.artifactId, sourceFrameId, mimeType: 'image/png', bytes: data.length, sha256: sha256(data), width: actual.width, height: actual.height, role: tile.role, cropWorkflowBounds: tile.crop, workflowToPixel: [sx, 0, 0, sy, -tile.crop.x * sx, -tile.crop.y * sy], hostDownsampling: 'unknown' });
      images.push({ artifactId: tile.artifactId, mimeType: 'image/png', data }); encodedBytes += Math.ceil(data.length / 3) * 4;
    }
    const requiredTileIds = required.map(t => t.artifactId), omittedTileIds = requiredTileIds.filter(id => !artifacts.some(a => a.artifactId === id));
    const coverageGaps = [...geometry.coverage.gaps, ...(nativeCoverage?.complete === false ? [{ kind: 'native-provider-coverage-incomplete', details: nativeCoverage }] : []), ...(crop ? [{ kind: 'partial-crop', fullWorkflowBounds: fullBounds }] : [])];
    const evidence = createCanvasEvidence({ contextId: context.contextId, sessionId: context.sessionId, scopeId: context.workflowId || context.scopeId || 'root', revisions: context.revisions, layoutRevision: context.revisions?.layout || context.layoutRevision || 'unknown', executionRevision: context.revisions?.execution || context.executionRevision || 'unknown', sourceFrameId, sourceKind, freshness: sourceKind === 'saved-preview' ? 'saved-only' : freshness, renderer: { name: 'Microsoft Edge / Playwright', version: browser.version(), fontsReady: fontsReady && geometry.fonts.every(f => f.status === 'loaded'), deviceScaleFactor, sourceScriptsEnabled: false, externalResourcesEnabled: false }, renderParameters, coverage: { bounds, fullWorkflowBounds: fullBounds, extent: crop ? 'crop' : 'full', requiredTileIds, requiredTiles: required.map(t => ({ artifactId: t.artifactId, cropWorkflowBounds: t.crop, scale: t.scale })), omittedTileIds, omittedObjectIds: [], gaps: coverageGaps, resourcesComplete: !omissions.length && fontsReady && geometry.fonts.every(f => f.status === 'loaded'), geometryComplete: !coverageGaps.length, complete: !omittedTileIds.length && !omissions.length && !coverageGaps.length && !manifest.gap }, artifacts, omissions, ...(sourceArtifact ? { sourceArtifact } : {}), ...(nativeLayout ? { nativeLayout } : {}), delivery: { serverEmittedArtifactIds: [], hostDelivery: 'unconfirmed', hostDownsampling: 'unknown' } });
    Object.assign(geometry, { evidenceId: evidence.evidenceId, contextId: evidence.contextId, scopeId: evidence.scopeId, layoutRevision: evidence.layoutRevision });
    if (outputDirectory) {
      await mkdir(outputDirectory, { recursive: true });
      for (const item of images) await writeImmutableArtifact(path.join(outputDirectory, item.artifactId), item.data);
      await writeFile(path.join(outputDirectory, `${evidence.evidenceId}.json`), JSON.stringify({ evidence, geometry }, null, 2), { flag: 'wx', mode: 0o600 });
    }
    return { evidence, images, geometry };
  } finally { await browser.close(); }
}
