import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
test('SWT warning text is visible and only a freshly inspected load warning can be acknowledged',{timeout:90000},async()=>{
 const jdk=process.env.KNIME_AGENT_JDK||'C:/Program Files/Java/jdk-24';
 const args=(await fs.readFile('build/javac.args','utf8')).split(/\r?\n/);const cp=args[args.indexOf('-classpath')+1].replace(/^"|"$/g,'');
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'knime-dialog-')),quote=s=>'"'+s.replaceAll('\\','/')+'"';const classpath=[path.resolve('build/classes'),scratch,cp].join(path.delimiter);
 await fs.writeFile(path.join(scratch,'compile.args'),['--release','21','-classpath',quote(classpath),'-d',quote(scratch),quote(path.resolve('java/test/org/knime/agent/DialogProbe.java'))].join('\n'));
 const compilation=spawnSync(path.join(jdk,'bin','javac.exe'),['@'+path.join(scratch,'compile.args')],{encoding:'utf8',windowsHide:true});assert.equal(compilation.status,0,compilation.stderr);
 await fs.writeFile(path.join(scratch,'run.args'),['--enable-native-access=ALL-UNNAMED','-classpath',quote(classpath),'org.knime.agent.DialogProbe'].join('\n'));
 const result=spawnSync(path.join(jdk,'bin','javaw.exe'),['@'+path.join(scratch,'run.args')],{encoding:'utf8',windowsHide:false,timeout:30000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/dialog-probe passed/);
});
