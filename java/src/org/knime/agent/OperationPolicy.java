package org.knime.agent;

import java.util.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Exact native guards. Unknown expert gateway actions remain visibly unverified. */
final class OperationPolicy {
    private static final Set<String> READS=Set.of("health","context.bind","context.inspect","context.usage","context.release","context.prune","dependency.inspect","operation.get","canvas.preview","canvas.viewport","canvas.capabilities",
        "gateway.describe","core.describe","core.snapshot","core.settings.get","core.settings.preview","core.table.read","core.port.inspect","core.nodes.search","core.nodes.details",
        "desktop.describe","desktop.functions","desktop.uiState");
    private static final Set<String> GATEWAY_READS=Set.of("ApplicationService.getState","WorkflowService.getWorkflow","WorkflowService.getWorkflowMonitorState",
        "WorkflowService.getNode","WorkflowService.getWorkflowInfo","WorkflowService.getWorkflowPortInfo","WorkflowService.getWorkflowBounds",
        "SpaceService.listWorkflowGroup","SpaceService.getSpaceItem","SpaceService.getSpaces","SpaceService.getSpaceProviders",
        "NodeRepositoryService.getNodeRepository","NodeRepositoryService.searchNodes","NodeRepositoryService.getNodeDescription");
    record Guard(ContextAccess contexts,JsonNode precondition,String operation,JsonNode args){}
    private static final ThreadLocal<Guard> CURRENT=new ThreadLocal<>();
    static boolean mutation(String op,JsonNode args){return !READS.contains(op)&&!(op.equals("gateway.call")&&GATEWAY_READS.contains(args.path("method").asText()));}
    static String guardCoverage(String op,JsonNode args) {
        if(Set.of("core.settings.patch","core.execute","core.reset","layout.apply","core.port.export").contains(op))return "apply-time";
        if(op.startsWith("desktop.")||op.equals("core.cancel"))return "dispatch-only";
        if(op.equals("gateway.call")&&Set.of("WorkflowService.executeWorkflowCommand","WorkflowService.undoWorkflowCommand","WorkflowService.redoWorkflowCommand","SpaceService.createWorkflow").contains(args.path("method").asText()))return "dispatch-only";
        return "unverified";
    }
    static List<String> dimensions(String op,JsonNode args) {
        if(op.equals("layout.apply"))return List.of("structure","configuration","layout");
        if(op.equals("core.cancel"))return List.of("structure","configuration","execution");
        if(op.startsWith("core."))return List.of("structure","configuration");
        if(op.equals("desktop.saveProject")||op.equals("desktop.closeProject"))return List.of("structure","configuration","layout");
        if(op.equals("gateway.call")&&args.path("params").hasNonNull("projectId"))return List.of("structure","configuration","layout");
        return List.of();
    }
    static void enter(ContextAccess contexts,JsonNode precondition,String operation,JsonNode args)throws Exception {
        if(!mutation(operation,args))return;
        ContextAccess.Bound bound=contexts.require(NativeTarget.required(precondition,"contextId"));
        if(bound.root()==null)contexts.validate(precondition,operation,args,dimensions(operation,args),false);
        else try(var lock=bound.root().lock()){contexts.validate(precondition,operation,args,dimensions(operation,args),true);}
        CURRENT.set(new Guard(contexts,precondition,operation,args));
    }
    static void apply()throws Exception {
        Guard g=CURRENT.get();if(g==null)throw new ContextAccess.Conflict("PRECONDITION_REQUIRED","No guarded mutation request on this execution path");
        g.contexts().validate(g.precondition(),g.operation(),g.args(),dimensions(g.operation(),g.args()),true);
    }
    static void leave(){CURRENT.remove();}
    static ObjectNode coverage() {
        ObjectNode out=BridgeActivator.JSON.createObjectNode();
        out.put("layout.apply","apply-time").put("core.settings.patch","apply-time").put("core.execute","apply-time").put("core.reset","apply-time")
            .put("core.cancel","dispatch-only").put("desktop.lifecycle","dispatch-only").put("gateway.commands","dispatch-only").put("gateway.unknown","unverified");
        return out;
    }
}
