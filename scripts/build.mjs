import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const knime=process.env.KNIME_HOME || path.join(process.env.LOCALAPPDATA,'Programs','KNIME');
const jdk=process.env.KNIME_AGENT_JDK || 'C:/Program Files/Java/jdk-24';
async function walk(dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else out.push(p);}return out;}
const plugins=path.join(knime,'plugins');
const cp=(await walk(plugins)).filter(p=>p.endsWith('.jar'));
const sources=(await walk(path.join(root,'java','src'))).filter(p=>p.endsWith('.java'));
const classes=path.join(root,'build','classes');await fs.mkdir(classes,{recursive:true});
const quote=s=>'"'+s.replaceAll('\\','/')+'"';
const argfile=path.join(root,'build','javac.args');
await fs.writeFile(argfile,['--release','21','-encoding','UTF-8','-classpath',quote(cp.join(path.delimiter)),'-d',quote(classes),...sources.map(quote)].join('\n'));
let result=spawnSync(path.join(jdk,'bin','javac.exe'),['@'+argfile],{stdio:'inherit',windowsHide:true});
if(result.status!==0)process.exit(result.status||1);
const signature=createHash('sha256');
signature.update(await fs.readFile(path.join(root,'java','META-INF','MANIFEST.MF')));
for(const source of sources.sort()){signature.update(path.relative(root,source));signature.update(await fs.readFile(source));}
const revision=signature.digest('hex').slice(0,12);
const artifact=path.join(root,'artifacts','org.knime.agent.bridge_0.1.0.beta1-'+revision+'.jar');await fs.mkdir(path.dirname(artifact),{recursive:true});
const temporary=artifact+'.'+randomUUID()+'.tmp';
result=spawnSync(path.join(jdk,'bin','jar.exe'),['--create','--file',temporary,'--manifest',path.join(root,'java','META-INF','MANIFEST.MF'),'-C',classes,'.'],{stdio:'inherit',windowsHide:true});
if(result.status!==0)process.exit(result.status||1);
try{await fs.access(artifact);await fs.unlink(temporary);}catch(error){if(error.code!=='ENOENT')throw error;await fs.rename(temporary,artifact);}
await fs.writeFile(path.join(root,'artifacts','latest.json'),JSON.stringify({bundle:path.basename(artifact),revision,targetJava:21},null,2)+'\n');
console.log(JSON.stringify({artifact,sources:sources.length,targetJava:21}));
