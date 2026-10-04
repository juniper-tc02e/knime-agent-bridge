import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function sources(directory) {
  const out=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())out.push(...await sources(file));else if(file.endsWith('.java'))out.push(file);
  }
  return out;
}
test('production dispatch/journal harness bounds diagnostics and preserves serialized effects and primary failures',async()=>{
  const plugins=path.join(process.env.KNIME_HOME||path.join(process.env.LOCALAPPDATA,'Programs','KNIME'),'plugins');
  const jars=(await fs.readdir(plugins)).filter(name=>/^com\.fasterxml\.jackson\.core\.jackson-(core|databind|annotations)_.*\.jar$/.test(name)).map(name=>path.join(plugins,name));
  assert.equal(jars.length,3);
  const scratch=path.join(root,'build','native-stage-harness-'+randomUUID());
  await fs.mkdir(scratch,{recursive:true});
  const jdk=process.env.KNIME_AGENT_JDK||'C:/Program Files/Java/jdk-24';
  const owned=['BridgeActivator','OperationAccess','AtomicFiles','RequestTelemetry'].map(name=>path.join(root,'java/src/org/knime/agent/'+name+'.java'));
  // Before telemetry exists, compile the real baseline without the absent source.
  const available=[];for(const file of owned)try{await fs.access(file);available.push(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  const compilation=spawnSync(path.join(jdk,'bin','javac.exe'),['--release','21','-encoding','UTF-8','-cp',jars.join(path.delimiter),'-d',scratch,...available,...await sources(path.join(root,'tests/java/stage-stubs')),path.join(root,'tests/java/StageTelemetryHarness.java')],{encoding:'utf8',windowsHide:true});
  assert.equal(compilation.status,0,compilation.stdout+compilation.stderr);
  const execution=spawnSync(path.join(jdk,'bin','java.exe'),['-ea','-cp',[scratch,...jars].join(path.delimiter),'org.knime.agent.StageTelemetryHarness',scratch],{encoding:'utf8',windowsHide:true,timeout:30000});
  await fs.writeFile(path.join(scratch,'execution.txt'),execution.stdout+execution.stderr);
  assert.equal(execution.status,0,execution.stdout+execution.stderr+'\nEvidence: '+scratch);
  assert.match(execution.stdout,/production dispatch telemetry verified/);
  // Evidence is intentionally retained; this harness never starts KNIME.
});
