// Opt-in fixture instrumentation only. Observe the unchanged OS identity query,
// including failure evidence discarded by the production unknown fallback.
import childProcess from 'node:child_process';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
import {appendFile} from 'node:fs/promises';
const output=process.env.KNIME_LIFECYCLE_PROVIDER_DIAGNOSTICS;
if(output) {
 const original=childProcess.execFile,execute=promisify(original);
 const wrapped=(...args)=>original(...args);
 wrapped[promisify.custom]=async(file,args,options)=>{
  const script=args?.[3];
  if(file!=='powershell.exe'||args?.[0]!=='-NoProfile'||args?.[1]!=='-NonInteractive'||args?.[2]!=='-Command'||typeof script!=='string'||!script.startsWith("$ErrorActionPreference='Stop'; @(")||!script.includes("creationIdentitySource='windows_process_start_filetime'"))return execute(file,args,options);
  const start=performance.now();let result,primary;
  try{return result=await execute(file,args,options);}
  catch(error){primary=error;throw error;}
  finally {
   const stdout=String(result?.stdout??primary?.stdout??''),stderr=String(result?.stderr??primary?.stderr??'');let parsed;
   try{const value=JSON.parse(stdout);parsed={shape:Array.isArray(value)?'array':typeof value,count:Array.isArray(value)?value.length:null,identitiesPresent:Array.isArray(value)&&value.every(p=>!!p.creationIdentity)};}
   catch(error){parsed={shape:'invalid_json',parseError:error.message.slice(0,200)};}
   const observation={observedAt:new Date().toISOString(),elapsedMs:performance.now()-start,timeoutMs:options?.timeout,success:!primary,
    name:primary?.name??null,code:primary?.code??null,signal:primary?.signal??null,killed:primary?.killed??false,
    stdoutBytes:Buffer.byteLength(stdout),stdoutPrefix:stdout.trim().slice(0,512),stderrBytes:Buffer.byteLength(stderr),stderrPrefix:stderr.trim().slice(0,512),parsed};
   await appendFile(output,JSON.stringify(observation)+'\n').catch(()=>{});
  }
 };
 childProcess.execFile=wrapped;syncBuiltinESMExports();
}
