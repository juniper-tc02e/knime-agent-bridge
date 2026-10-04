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
// Eclipse bundles may be JARs or unpacked directories (including installed JNA).
const cp=[...(await walk(plugins)).filter(p=>p.endsWith('.jar')),...(await fs.readdir(plugins,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>path.join(plugins,e.name))];
const sources=(await walk(path.join(root,'java','src'))).filter(p=>p.endsWith('.java'));
const classes=path.join(root,'build','classes');
// Do not package stale classes or label a compilation with source edited midway.
const inputsDigest=async()=>{const currentSources=(await walk(path.join(root,'java','src'))).filter(p=>p.endsWith('.java')).sort();const hash=createHash('sha256');hash.update(await fs.readFile(path.join(root,'java','META-INF','MANIFEST.MF')));for(const source of currentSources){hash.update(path.relative(root,source));hash.update(await fs.readFile(source));}return hash.digest('hex');};
const frozenInputs=await inputsDigest(),version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
await fs.mkdir(path.join(root,'build'),{recursive:true});if(path.relative(path.join(root,'build'),await fs.realpath(path.join(root,'build')))!=='')throw Error('Build directory resolves outside its exact location.');
try{const actual=await fs.realpath(classes);if(path.relative(classes,actual)!=='')throw Error('Refusing to clean a redirected build/classes directory.');}catch(error){if(error.code!=='ENOENT')throw error;}
if(path.dirname(classes)!==path.join(root,'build'))throw Error('Class output escaped the build directory.');
await fs.rm(classes,{recursive:true,force:true});await fs.mkdir(classes,{recursive:true});
const quote=s=>'"'+s.replaceAll('\\','/')+'"';
const argfile=path.join(root,'build','javac.args');
await fs.writeFile(argfile,['--release','21','-encoding','UTF-8','-classpath',quote(cp.join(path.delimiter)),'-d',quote(classes),...sources.map(quote)].join('\n'));
let result=spawnSync(path.join(jdk,'bin','javac.exe'),['@'+argfile],{stdio:'inherit',windowsHide:true});
if(result.status!==0)process.exit(result.status||1);
if(await inputsDigest()!==frozenInputs||JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version!==version)throw Error('Build inputs changed during compilation. Freeze source and rebuild; no artifact was published.');
const revision=frozenInputs.slice(0,12);
const artifact=path.join(root,'artifacts','org.knime.agent.bridge_'+version+'-'+revision+'.jar');await fs.mkdir(path.dirname(artifact),{recursive:true});
const temporary=artifact+'.'+randomUUID()+'.tmp';
result=spawnSync(path.join(jdk,'bin','jar.exe'),['--create','--file',temporary,'--manifest',path.join(root,'java','META-INF','MANIFEST.MF'),'-C',classes,'.'],{stdio:'inherit',windowsHide:true});
if(result.status!==0)process.exit(result.status||1);
if(await inputsDigest()!==frozenInputs||JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version!==version){await fs.unlink(temporary);throw Error('Build inputs changed during archive assembly. No artifact was published; freeze source and rebuild.');}
try{await fs.access(artifact);await fs.unlink(temporary);}catch(error){if(error.code!=='ENOENT')throw error;await fs.rename(temporary,artifact);}
await fs.writeFile(path.join(root,'artifacts','latest.json'),JSON.stringify({bundle:path.basename(artifact),revision,targetJava:21},null,2)+'\n');
console.log(JSON.stringify({artifact,sources:sources.length,targetJava:21}));
