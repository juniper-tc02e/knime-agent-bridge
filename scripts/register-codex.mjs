import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const command=process.execPath;
const server=path.join(root,'src','server.mjs');
const codex=process.env.CODEX_BIN || 'codex';
const get=spawnSync(codex,['mcp','get','knime-agent','--json'],{encoding:'utf8',windowsHide:true});
if(get.error)throw get.error;
if(get.status===0) {
 const existing=JSON.parse(get.stdout);
 const transport=existing.transport || existing;
 if(transport.command?.toLowerCase()===command.toLowerCase() && transport.args?.[0]===server) {
  console.log(JSON.stringify({registered:true,alreadyConfigured:true,name:'knime-agent',command,args:[server]}));
  process.exit(0);
 }
 throw new Error('An existing knime-agent configuration points elsewhere. Inspect it before replacing it.');
}
if(!/No MCP server named/i.test(get.stderr+get.stdout))throw new Error(get.stderr || get.stdout || 'Could not inspect Codex MCP configuration.');
const add=spawnSync(codex,['mcp','add','knime-agent','--',command,server],{encoding:'utf8',windowsHide:true});
if(add.error)throw add.error;
if(add.status!==0)throw new Error(add.stderr || add.stdout || 'MCP registration failed.');
console.log(JSON.stringify({registered:true,name:'knime-agent',command,args:[server],note:'A fresh chat or MCP reload may be needed to discover new tools.'}));
