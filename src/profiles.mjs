import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {BridgeError} from './client.mjs';

export function resolveProfile({profile,profiles,profilesFile,runtime,session}={}) {
 if(profile===undefined) {
  if(profilesFile!==undefined||profiles!==undefined)throw new BridgeError('INVALID_ARGUMENT','Select --profile when supplying profiles.');
  return null;
 }
 if(typeof profile!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile))throw new BridgeError('INVALID_ARGUMENT','Profile name must be a short readable identifier.');
 let entries=profiles,source='constructor',base=process.cwd();
 if(profilesFile!==undefined) {
  if(profiles!==undefined)throw new BridgeError('INVALID_ARGUMENT','Supply profiles or profilesFile, not both.');
  source=path.resolve(profilesFile);base=path.dirname(source);
  try {if(statSync(source).size>65536)throw new Error('Profile file exceeds 64 KiB.');const config=JSON.parse(readFileSync(source,'utf8').replace(/^\uFEFF/,''));if(config.schemaVersion!==1)throw new Error('Unsupported profile schemaVersion.');entries=config.profiles;}
  catch(error){throw new BridgeError('INVALID_ARGUMENT',`Cannot read profile configuration: ${error.message}`);}
 }
 const selected=entries?.[profile];
 if(!selected||typeof selected!=='object'||Array.isArray(selected)||Object.keys(selected).some(k=>!['runtime','session','bridgeVersion','bundleFingerprint'].includes(k))||!['runtime','session','bridgeVersion','bundleFingerprint'].every(k=>typeof selected[k]==='string'&&selected[k].trim()))throw new BridgeError('INVALID_ARGUMENT','Named profile requires runtime, session, bridgeVersion and bundleFingerprint.');
 const resolved=path.resolve(base,selected.runtime);
 if((runtime!==undefined&&path.resolve(runtime)!==resolved)||(session!==undefined&&session!==selected.session))throw new BridgeError('PROFILE_CONFLICT','Explicit runtime/session conflicts with the selected profile.',{profile,outcome:'not_submitted'});
 return {name:profile,source,runtime:resolved,session:selected.session,expected:{bridgeVersion:selected.bridgeVersion,bundleFingerprint:selected.bundleFingerprint}};
}

export function profileCompatibility(profile,metadata) {
 if(!profile)return {status:'unconstrained',compatible:null,reason:'No named profile expectations configured.'};
 const mismatches=Object.entries(profile.expected).filter(([key,value])=>metadata?.[key]!==value).map(([field,expected])=>({field,expected,actual:metadata?.[field]??null}));
 return {status:!metadata?'unavailable':mismatches.length?'incompatible':'compatible',compatible:!!metadata&&!mismatches.length,expected:profile.expected,mismatches};
}
