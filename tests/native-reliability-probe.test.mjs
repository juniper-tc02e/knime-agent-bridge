import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
test('Windows native metadata writes tolerate a transient sharing lock without partial JSON',{timeout:90000},async()=>{
 const jdk=process.env.KNIME_AGENT_JDK||'C:/Program Files/Java/jdk-24';
 const args=(await fs.readFile('build/javac.args','utf8')).split(/\r?\n/);const cp=args[args.indexOf('-classpath')+1].replace(/^"|"$/g,'');
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'knime-reliability-'));
 const quote=s=>'"'+s.replaceAll('\\','/')+'"';const classpath=[path.resolve('build/classes'),scratch,cp].join(path.delimiter);
 await fs.writeFile(path.join(scratch,'compile.args'),['--release','21','-classpath',quote(classpath),'-d',quote(scratch),quote(path.resolve('java/test/org/knime/agent/ReliabilityProbe.java'))].join('\n'));
 const compilation=spawnSync(path.join(jdk,'bin','javac.exe'),['@'+path.join(scratch,'compile.args')],{encoding:'utf8',windowsHide:true});assert.equal(compilation.status,0,compilation.stderr);
 await fs.writeFile(path.join(scratch,'run.args'),['-classpath',quote(classpath),'org.knime.agent.ReliabilityProbe',quote(scratch)].join('\n'));
 const result=spawnSync(path.join(jdk,'bin','java.exe'),['@'+path.join(scratch,'run.args')],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/reliability-probe passed/);
});
