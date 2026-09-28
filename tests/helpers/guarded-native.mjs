// Ordinary legacy acceptance cases observe fresh revisions before each edit.
// Conflict/missing-precondition tests deliberately use the raw transport instead.
export function needsGuard(operation,args) {
 if(operation==='gateway.call')return !/\.(?:get|list|search|find|has|is|describe)/.test(args.method??'');
 return /^(?:core\.(?:settings\.patch|execute|reset|cancel|port\.export)|desktop\.(?:openProject|saveProject|closeProject)|layout\.apply)$/.test(operation);
}
export function targetArgs(operation,args) {
 const value=operation==='gateway.call'?args.params:args;
 if(value?.projectId)return {projectId:value.projectId,...(typeof value.workflowId==='string'?{workflowId:value.workflowId}:{})};
 return {};
}
export function guardedMcp(raw) {
 return async(name,args={})=>{
  const op=name==='knime_gateway_call'?'gateway.call':args.operation;
  const payload=name==='knime_gateway_call'?args:args.args;
  if(op&&payload&&needsGuard(op,payload)&&!args.precondition) {
   const context=await raw('knime_context',{action:'bind',...targetArgs(op,payload)});
   args={...args,precondition:{contextId:context.contextId,expected:context.revisions??{}}};
  }
  return raw(name,args);
 };
}
