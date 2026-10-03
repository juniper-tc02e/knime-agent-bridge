import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function run(files,env=process.env) {
  // Native cases share KNIME's active-project state, so test files run serially.
  const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{cwd:root,env,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
// This test checks the live workspace before creating any synthetic nodes.
run(['tests/native-workflow.test.mjs']);
const fixture=JSON.parse(await fs.readFile(path.join(root,'runtime','native-fixture.json'),'utf8'));
if(!fixture.projectId||!fixture.nodeId)throw Error('Native workflow test did not publish a usable fixture.');
const tests=(await fs.readdir(path.join(root,'tests'))).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name);
run(tests,{...process.env,KNIME_CORE_TEST_PROJECT:fixture.projectId,KNIME_CORE_TEST_NODE:fixture.nodeId,KNIME_CORE_TABLE_FIXTURE:'1',KNIME_CANVAS_TEST_PROJECT:fixture.projectId,KNIME_VISUAL_ACCEPTANCE:'1',KNIME_RELIABILITY_TEST:'1',KNIME_V04_NATIVE:'1',KNIME_SETTINGS_JVM_TEST:'1'});
