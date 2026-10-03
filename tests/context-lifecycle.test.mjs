import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const jdk=process.env.KNIME_AGENT_JDK||'C:/Program Files/Java/jdk-24';
async function javaFiles(directory) {
  const entries=await fs.readdir(directory,{withFileTypes:true});
  return (await Promise.all(entries.map(e=>e.isDirectory()?javaFiles(path.join(directory,e.name)):e.name.endsWith('.java')?[path.join(directory,e.name)]:[]))).flat();
}

test('native context registry enforces capacity, immutable IDs and conservative concurrent cleanup',async()=>{
  const source=path.join(root,'java/src/org/knime/agent/ContextRegistry.java');
  assert.equal(await fs.access(source).then(()=>true,()=>false),true,'bounded context registry is not implemented');
  const classes=path.join(root,'build','context-lifecycle-'+randomUUID());
  await fs.mkdir(classes,{recursive:true});
  try {
    const compilation=spawnSync(path.join(jdk,'bin','javac.exe'),['--release','21','-encoding','UTF-8','-d',classes,source,path.join(root,'tests/java/ContextRegistryHarness.java')],{encoding:'utf8',windowsHide:true});
    assert.equal(compilation.status,0,compilation.stdout+compilation.stderr);
    const execution=spawnSync(path.join(jdk,'bin','java.exe'),['-ea','-cp',classes,'org.knime.agent.ContextRegistryHarness'],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(execution.status,0,execution.stdout+execution.stderr);
    assert.match(execution.stdout,/context lifecycle behavior verified/);
  } finally {
    assert.equal(path.dirname(classes),path.join(root,'build'));
    await fs.rm(classes,{recursive:true,force:true});
  }
});

test('real ContextAccess releases fail closed and only proven invalid models are pruned',async()=>{
  const plugins=path.join(process.env.KNIME_HOME||path.join(process.env.LOCALAPPDATA,'Programs','KNIME'),'plugins');
  const jars=(await fs.readdir(plugins)).filter(name=>/^com\.fasterxml\.jackson\.core\.jackson-(core|databind|annotations)_.*\.jar$/.test(name)).map(name=>path.join(plugins,name));
  assert.equal(jars.length,3,'installed KNIME Jackson jars are required for the ContextAccess harness');
  const classes=path.join(root,'build','context-access-'+randomUUID());
  await fs.mkdir(classes,{recursive:true});
  const evidence=path.join(classes,'historical-quality.json');
  const historical='{"contextId":"historical","passed":true}\n';
  await fs.writeFile(evidence,historical);
  try {
    const sources=[path.join(root,'java/src/org/knime/agent/ContextAccess.java'),path.join(root,'java/src/org/knime/agent/ContextRegistry.java'),path.join(root,'tests/java/ContextAccessHarness.java'),...await javaFiles(path.join(root,'tests/java/context-stubs'))];
    const compilation=spawnSync(path.join(jdk,'bin','javac.exe'),['--release','21','-encoding','UTF-8','-cp',jars.join(path.delimiter),'-d',classes,...sources],{encoding:'utf8',windowsHide:true});
    assert.equal(compilation.status,0,compilation.stdout+compilation.stderr);
    const execution=spawnSync(path.join(jdk,'bin','java.exe'),['-ea','-cp',[classes,...jars].join(path.delimiter),'org.knime.agent.ContextAccessHarness'],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(execution.status,0,execution.stdout+execution.stderr);
    assert.match(execution.stdout,/context access behavior verified/);
    assert.equal(await fs.readFile(evidence,'utf8'),historical,'native lifecycle cleanup deleted historical client evidence');
  }finally {
    assert.equal(path.dirname(classes),path.join(root,'build'));
    await fs.rm(classes,{recursive:true,force:true});
  }
});
