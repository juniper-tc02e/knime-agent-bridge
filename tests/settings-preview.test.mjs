import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

test('settings preview and apply share detached preparation with validation before native load (source boundary, not runtime proof)',async()=>{
 const source=await fs.readFile('java/src/org/knime/agent/CoreAccess.java','utf8');
 assert.match(source,/case "core\.settings\.preview"/);
 const settings=source.slice(source.indexOf('private static Object settings('),source.indexOf('private static Object execution('));
 assert.match(settings,/SettingsPreview\.prepare/);
 assert.match(settings,/SettingsHealth\.validate/);
 assert.ok(settings.indexOf('SettingsHealth.validate')<settings.indexOf('.loadNodeSettings('));
 assert.ok(settings.indexOf('if(preview)')<settings.indexOf('OperationPolicy.apply()'));
 assert.ok(settings.indexOf('return result;',settings.indexOf('if(preview)'))<settings.indexOf('.loadNodeSettings('));
});

test('detached settings helper has no native workflow load or reset entry point (source boundary, not runtime proof)',async()=>{
 const helper=await fs.readFile('java/src/org/knime/agent/SettingsPreview.java','utf8');
 assert.doesNotMatch(helper,/loadNodeSettings|resetAndConfigure|OperationPolicy\.apply/);
 assert.match(helper,/SettingsCodec\.detachedCopy/);
});

test('detached native settings retain typed values and reject malformed edits',{timeout:120000,skip:!process.env.KNIME_SETTINGS_JVM_TEST},async(t)=>{
 const jdk=process.env.KNIME_AGENT_JDK||'C:/Program Files/Java/jdk-24';
 const sourceArgs=await fs.readFile('build/javac.args','utf8');const lines=sourceArgs.split(/\r?\n/);
 const cp=lines[lines.indexOf('-classpath')+1].replace(/^"|"$/g,'');
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'knime-settings-preview-'));
 const quote=s=>'"'+s.replaceAll('\\','/')+'"';
 // KNIME's OSGi runtime keeps signed split packages in separate classloaders. A plain JVM
 // cannot mix core's unsigned NodeSettings with core.util's signed InvalidSettingsException.
 // Extract these two installed libraries into a private, disposable class directory instead.
 const nativeClasses=path.join(scratch,'native-classes');await fs.mkdir(nativeClasses);
 const nativeJars=cp.split(path.delimiter).filter(p=>/[/\\]knime-core\.jar$|[/\\]org\.knime\.core\.util_[^/\\]+\.jar$/.test(p));
 assert.equal(nativeJars.length,2,'Pinned native settings libraries unavailable');
 for(const jar of nativeJars) {
   const unpack=spawnSync(path.join(jdk,'bin','jar.exe'),['xf',jar],{cwd:nativeClasses,encoding:'utf8',windowsHide:true});
   assert.equal(unpack.status,0,unpack.stderr);
 }
 const classpath=[scratch,nativeClasses,path.resolve('build/classes'),cp].join(path.delimiter);
 const compile=path.join(scratch,'compile.args'),run=path.join(scratch,'run.args');
 await fs.writeFile(compile,['--release','21','-classpath',quote(classpath),'-d',quote(scratch),quote(path.resolve('tests/java/settings-stubs/org/knime/core/node/NodeLogger.java')),quote(path.resolve('java/test/org/knime/agent/SettingsPreviewProbe.java'))].join('\n'));
 const compilation=spawnSync(path.join(jdk,'bin','javac.exe'),['@'+compile],{encoding:'utf8',windowsHide:true});
 assert.equal(compilation.status,0,compilation.stderr);
 await fs.writeFile(run,['-classpath',quote(classpath),'org.knime.agent.SettingsPreviewProbe'].join('\n'));
 const result=spawnSync(path.join(jdk,'bin','java.exe'),['@'+run],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/settings-preview-probe assertions=\d+; runtime-model-proof=false/);
 t.diagnostic(result.stdout.trim());
});
