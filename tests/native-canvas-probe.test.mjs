import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

test('narrow native capture adapters are present (source contract, not runtime proof)',async()=>{
 const preview=await fs.readFile('java/src/org/knime/agent/NativePreviewCapture.java','utf8');
 assert.match(preview,/getDeclaredMethod\("renderPreviewSVG",WorkflowManager\.class,Path\.class\)/);
 assert.doesNotMatch(preview,/\.onSave\(/);
 const viewport=await fs.readFile('java/src/org/knime/agent/EditorViewportCapture.java','utf8');
 assert.match(viewport,/model-stable-render-unconfirmed/);
 assert.match(viewport,/getAllBrowsers/);
});

test('JVM behavioral probes reject malformed screenshots, path escapes and UUID payload reuse',{timeout:60000},async()=>{
 const jdk=process.env.KNIME_AGENT_JDK||'C:/Program Files/Java/jdk-24';
 const sourceArgs=await fs.readFile('build/javac.args','utf8');
 const cp=sourceArgs.split(/\r?\n/)[sourceArgs.split(/\r?\n/).indexOf('-classpath')+1].replace(/^"|"$/g,'');
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'knime-native-utility-'));
 const quote=s=>'"'+s.replaceAll('\\','/')+'"';
 const classpath=[path.resolve('build/classes'),scratch,cp].join(path.delimiter);
 const javacArgs=path.join(scratch,'compile.args'),javaArgs=path.join(scratch,'run.args');
 await fs.writeFile(javacArgs,['--release','21','-classpath',quote(classpath),'-d',quote(scratch),quote(path.resolve('java/test/org/knime/agent/NativeUtilityProbe.java'))].join('\n'));
 const compilation=spawnSync(path.join(jdk,'bin','javac.exe'),['@'+javacArgs],{encoding:'utf8',windowsHide:true});
 assert.equal(compilation.status,0,compilation.stderr);
 await fs.writeFile(javaArgs,['-classpath',quote(classpath),'org.knime.agent.NativeUtilityProbe',quote(scratch)].join('\n'));
 const result=spawnSync(path.join(jdk,'bin','java.exe'),['@'+javaArgs],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/assertions=17; runtime-model-proof=false/);
});

test('native loaded-model preview preserves dirty/settings/revisions and publishes confined SVG',
 {skip:!process.env.KNIME_CANVAS_TEST_PROJECT,timeout:120000},async()=>{
 const {BridgeClient}=await import('../src/client.mjs');
 const client=new BridgeClient({session:process.env.KNIME_AGENT_SESSION});
 const projectId=process.env.KNIME_CANVAS_TEST_PROJECT;
 const health=await client.call('health',{});
 assert.match(health.workspace,/knime-agent-bridge.*runtime.*workspace/i);
 const context=await client.call('context.bind',{projectId,workflowId:'root'});
 const before=await client.call('core.snapshot',{projectId,includeSettings:true,depth:8});
 const capture=await client.call('canvas.preview',{contextId:context.contextId});
 const after=await client.call('core.snapshot',{projectId,includeSettings:true,depth:8});
 assert.deepEqual(after,before);
 assert.deepEqual(capture.beforeRevisions,capture.afterRevisions);
 assert.equal(capture.sourceKind,'native-preview');
 assert.equal(capture.relativePath,path.basename(capture.relativePath));
 assert.equal(capture.contextId,context.contextId);
 assert.equal(capture.artifact.mimeType,'image/svg+xml');
 const file=path.join(client.runtime,'sessions',context.sessionId,'artifacts',capture.relativePath);
 const bytes=await fs.readFile(file);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),capture.sha256);
 const svg=bytes.toString('utf8');
 assert.match(svg,/<svg/);
 for(const node of before.nodes) assert.ok(svg.includes(`data-node-id="${node.gatewayId}"`)||svg.includes(`data-node-id="${node.id}"`),`preview missing node ${node.id}`);
});
