import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const jdk=process.env.KNIME_AGENT_JDK||'C:/Program Files/Java/jdk-24';

test('native journal retention preserves authoritative status and expired UUID redelivery never repeats dispatch',async()=>{
  const plugins=path.join(process.env.KNIME_HOME||path.join(process.env.LOCALAPPDATA,'Programs','KNIME'),'plugins');
  const jars=(await fs.readdir(plugins)).filter(name=>/^com\.fasterxml\.jackson\.core\.jackson-(core|databind|annotations)_.*\.jar$/.test(name)).map(name=>path.join(plugins,name));
  assert.equal(jars.length,3,'installed KNIME Jackson jars are required for the OperationAccess harness');
  const scratch=path.join(root,'build','native-operation-retention-'+randomUUID());
  await fs.mkdir(scratch,{recursive:true});
  try {
    const fixtures=path.join(root,'tests/java/operation-retention-stubs');
    const sources=[path.join(root,'java/src/org/knime/agent/OperationAccess.java'),path.join(root,'tests/java/OperationRetentionHarness.java'),...(await fs.readdir(fixtures)).filter(name=>name.endsWith('.java')).map(name=>path.join(fixtures,name))];
    const compilation=spawnSync(path.join(jdk,'bin','javac.exe'),['--release','21','-encoding','UTF-8','-cp',jars.join(path.delimiter),'-d',scratch,...sources],{encoding:'utf8',windowsHide:true});
    assert.equal(compilation.status,0,compilation.stdout+compilation.stderr);
    const execution=spawnSync(path.join(jdk,'bin','java.exe'),['-ea','-cp',[scratch,...jars].join(path.delimiter),'org.knime.agent.OperationRetentionHarness',scratch],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(execution.status,0,execution.stdout+execution.stderr);
    assert.match(execution.stdout,/native operation retention behavior verified/);
  }finally {
    assert.equal(path.dirname(scratch),path.join(root,'build'));
    await fs.rm(scratch,{recursive:true,force:true});
  }
});
