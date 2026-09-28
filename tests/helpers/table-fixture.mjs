// Literal synthetic data; expectations must remain independent of bridge output.
export const tableCreatorFixtureRows = [['alpha', 1], ['', 2], [null, 3]];

export function tableCreatorFixturePatches() {
  return [
    {path:['model','numRows'],type:'xlong',value:'3'},
    {path:['model','columns','0','name'],type:'xstring',value:'label'},
    {path:['model','columns','0','values'],type:'stringArray',value:['alpha','',null]},
    {path:['model','columns','1','name'],type:'xstring',value:'value',createParents:true},
    {path:['model','columns','1','type','cell_class'],type:'xstring',value:'org.knime.core.data.def.IntCell',createParents:true},
    {path:['model','columns','1','type','is_null'],type:'xboolean',value:false,createParents:true},
    {path:['model','columns','1','values'],type:'stringArray',value:['1','2','3'],createParents:true},
  ];
}

export async function configureTableCreatorFixture(call, {projectId, nodeId}) {
  return call('core.settings.patch',{projectId,nodeId,patches:tableCreatorFixturePatches()});
}

export async function executeAndWaitForNode(call,{projectId,nodeId},{timeoutMs=30000}={}) {
  await call('core.execute',{projectId,nodeId});
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const snapshot=await call('core.snapshot',{projectId,nodeId});
    if(snapshot.state==='EXECUTED')return snapshot;
    if(snapshot.message?.type==='ERROR')throw new Error('Native node execution failed: '+snapshot.message.text);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Timed out waiting for native node to reach EXECUTED state');
}
