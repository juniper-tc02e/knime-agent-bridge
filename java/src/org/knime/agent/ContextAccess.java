package org.knime.agent;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.knime.core.node.workflow.WorkflowManager;
import org.knime.gateway.impl.project.ProjectManager;

/** Context identity never follows a replacement model, process or active tab. */
final class ContextAccess {
    static final class Conflict extends IllegalArgumentException {
        final String code;final JsonNode details;
        Conflict(String code,String message){this(code,message,BridgeActivator.JSON.createObjectNode());}
        Conflict(String code,String message,JsonNode details){super(message);this.code=code;this.details=details;}
    }
    record Bound(String id,String projectId,WorkflowManager root,WorkflowManager scope,ObjectNode identity){}
    private final Map<String,Bound> contexts=new ConcurrentHashMap<>();
    private final ObjectNode process;
    ContextAccess(ObjectNode process){this.process=process.deepCopy();}
    Object bind(JsonNode args)throws Exception {
        if(!process.path("bundleFingerprint").asText().matches("[0-9a-f]{64}"))throw new Conflict("CONTEXT_CHANGED","Running bundle fingerprint is unavailable; context binding is disabled");
        for(Iterator<String> it=args.fieldNames();it.hasNext();)if(!Set.of("projectId","workflowId","sessionId").contains(it.next()))throw new IllegalArgumentException("Unknown context.bind argument");
        if(args.has("sessionId")&&!process.path("id").asText().equals(args.path("sessionId").asText()))throw new Conflict("CONTEXT_CHANGED","Session does not match running native process");
        if(contexts.size()>=1024)throw new IllegalStateException("Context limit reached (1024 per session)");
        String id=UUID.randomUUID().toString();ObjectNode identity=BridgeActivator.JSON.createObjectNode().put("contextId",id)
            .put("sessionId",process.path("id").asText()).put("workspace",process.path("workspace").asText())
            .put("pid",process.path("pid").asLong()).put("startedAt",process.path("startedAt").asText())
            .put("bundleFingerprint",process.path("bundleFingerprint").asText())
            .put("capabilityFingerprint",process.path("capabilityFingerprint").asText());
        if(!args.has("projectId")) {
            if(args.has("workflowId"))throw new IllegalArgumentException("workflowId requires projectId");
            identity.putNull("projectId").putNull("workflowId").putNull("nativeWorkflowId").putNull("origin");
            contexts.put(id,new Bound(id,null,null,null,identity));return inspect(id);
        }
        WorkflowManager root=NativeTarget.root(args);
        try(var lock=root.lock()) {
            WorkflowManager scope=NativeTarget.workflow(root,args);String projectId=NativeTarget.required(args,"projectId");
            identity.put("projectId",projectId).put("workflowId",NativeTarget.relative(root,scope.getID())).put("nativeWorkflowId",scope.getID().toString());
            var origin=ProjectManager.getInstance().getProject(projectId).orElseThrow().getOrigin();
            if(origin.isPresent()){var o=origin.get();identity.putObject("origin").put("providerId",o.providerId()).put("spaceId",o.spaceId()).put("itemId",o.itemId());}else identity.putNull("origin");
            contexts.put(id,new Bound(id,projectId,root,scope,identity));return inspect(id);
        }
    }
    Bound require(String id) {
        Bound bound=contexts.get(id);if(bound==null)throw new Conflict("CONTEXT_CHANGED","Unknown context in this native session: "+id);
        if(bound.root()!=null) {
            var project=ProjectManager.getInstance().getProject(bound.projectId());
            if(project.isEmpty()||project.get().getWorkflowManagerIfLoaded().orElse(null)!=bound.root())throw new Conflict("CONTEXT_CHANGED","Bound project closed or its loaded model changed");
            if(NativeTarget.findExact(bound.root(),bound.scope().getID().toString(),0)!=bound.scope())throw new Conflict("CONTEXT_CHANGED","Bound workflow scope was removed or replaced");
        }
        return bound;
    }
    ObjectNode inspect(String id)throws Exception {
        Bound b=require(id);ObjectNode result=b.identity().deepCopy();
        result.set("guardCoverage",OperationPolicy.coverage());result.set("revisionCoverage",RevisionTracker.coverage());
        if(b.root()==null){result.putNull("revisions");return result;}
        try(var lock=b.root().lock()) {
            require(id);result.set("revisions",RevisionTracker.read(b.scope()));result.put("dirty",b.root().isDirty());
            result.put("activeProject",ProjectManager.getInstance().isActiveProject(b.projectId()));return result;
        }
    }
    Bound validate(JsonNode precondition,String operation,JsonNode args,List<String> dimensions,boolean active)throws Exception {
        if(!precondition.isObject())throw new Conflict("PRECONDITION_REQUIRED","Mutation requires a bound context and expected revisions");
        precondition.fieldNames().forEachRemaining(key->{if(!Set.of("contextId","expected","sessionId","bundleFingerprint","capabilityFingerprint","workspace").contains(key))throw new IllegalArgumentException("Unknown precondition field: "+key);});
        if(!precondition.path("expected").isObject())throw new Conflict("PRECONDITION_REQUIRED","Expected revisions must be an object");
        precondition.path("expected").fieldNames().forEachRemaining(key->{if(!Set.of("structure","configuration","layout","execution").contains(key))throw new IllegalArgumentException("Unknown revision dimension: "+key);});
        String id=NativeTarget.required(precondition,"contextId");Bound b=require(id);
        for(String key:List.of("sessionId","bundleFingerprint","capabilityFingerprint","workspace"))if(precondition.has(key)&&!precondition.path(key).equals(b.identity().path(key)))throw new Conflict("CONTEXT_CHANGED","Precondition "+key+" does not match bound identity");
        if(args.has("contextId")&&!id.equals(args.path("contextId").asText()))throw new Conflict("CONTEXT_CHANGED","Argument context differs from precondition context");
        JsonNode target=operation.equals("gateway.call")?args.path("params"):args;
        if(operation.equals("gateway.call")&&!target.isObject())throw new IllegalArgumentException("Guarded gateway mutations require named parameter objects");
        if(target.has("projectId")) {
            if(b.projectId()==null||!b.projectId().equals(NativeTarget.required(target,"projectId")))throw new Conflict("CONTEXT_CHANGED","Mutation project differs from bound project");
            WorkflowManager scope=NativeTarget.workflow(b.root(),target);
            if(scope!=b.scope())throw new Conflict("CONTEXT_CHANGED","Mutation workflow scope differs from bound scope");
            NativeTarget.node(b.root(),target);
        } else if((operation.startsWith("core.")||operation.equals("layout.apply"))&&b.projectId()==null)throw new Conflict("CONTEXT_CHANGED","Graph mutation requires a project context");
        else if(operation.equals("gateway.call")&&args.path("method").asText().startsWith("WorkflowService."))throw new Conflict("CONTEXT_CHANGED","WorkflowService mutation requires an explicit projectId and workflowId target");
        if(b.root()!=null) {
            if(active&&!ProjectManager.getInstance().isActiveProject(b.projectId()))throw new Conflict("CONTEXT_CHANGED","Bound project is no longer the active project");
            JsonNode expected=precondition.path("expected");
            ObjectNode actual=RevisionTracker.read(b.scope());
            for(String dimension:dimensions) {
                if(!expected.path(dimension).isTextual()||expected.path(dimension).asText().isBlank())throw new Conflict("PRECONDITION_REQUIRED","Missing expected "+dimension+" revision");
                if(!expected.path(dimension).equals(actual.path(dimension)))throw new Conflict("REVISION_CONFLICT","Expected "+dimension+" revision changed",BridgeActivator.JSON.createObjectNode().put("dimension",dimension).set("actual",actual));
            }
        } else if(!dimensions.isEmpty())throw new Conflict("CONTEXT_CHANGED","This action requires a loaded project context");
        return b;
    }
}
