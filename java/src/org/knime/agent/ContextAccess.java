package org.knime.agent;

import java.util.*;
import java.util.concurrent.locks.ReentrantLock;
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
    private final ContextRegistry<Bound> contexts=new ContextRegistry<>();
    private static final long PRUNE_BUDGET_NANOS=250_000_000L;
    private static final int MODEL_SCAN_LIMIT=10000;
    private final ObjectNode process;
    ContextAccess(ObjectNode process){this.process=process.deepCopy();}
    Object bind(JsonNode args)throws Exception {
        if(!process.path("bundleFingerprint").asText().matches("[0-9a-f]{64}"))throw new Conflict("CONTEXT_CHANGED","Running bundle fingerprint is unavailable; context binding is disabled");
        arguments(args,Set.of("projectId","workflowId","sessionId"),"bind");
        if(args.has("sessionId")&&!process.path("id").asText().equals(NativeTarget.required(args,"sessionId")))throw new Conflict("CONTEXT_CHANGED","Session does not match running native process");
        ObjectNode identity=BridgeActivator.JSON.createObjectNode()
            .put("sessionId",process.path("id").asText()).put("workspace",process.path("workspace").asText())
            .put("pid",process.path("pid").asLong()).put("startedAt",process.path("startedAt").asText())
            .put("bundleFingerprint",process.path("bundleFingerprint").asText())
            .put("capabilityFingerprint",process.path("capabilityFingerprint").asText());
        if(!args.has("projectId")) {
            if(args.has("workflowId"))throw new IllegalArgumentException("workflowId requires projectId");
            identity.putNull("projectId").putNull("workflowId").putNull("nativeWorkflowId").putNull("origin");
            return publish(null,null,null,identity);
        }
        WorkflowManager root=NativeTarget.root(args);
        ReentrantLock gate=tryRootLock(root);
        try(var lock=root.lock()) {
            WorkflowManager scope=NativeTarget.workflow(root,args);String projectId=NativeTarget.required(args,"projectId");
            identity.put("projectId",projectId).put("workflowId",NativeTarget.relative(root,scope.getID())).put("nativeWorkflowId",scope.getID().toString());
            var origin=ProjectManager.getInstance().getProject(projectId).orElseThrow().getOrigin();
            if(origin.isPresent()){var o=origin.get();identity.putObject("origin").put("providerId",o.providerId()).put("spaceId",o.spaceId()).put("itemId",o.itemId());}else identity.putNull("origin");
            return publish(projectId,root,scope,identity);
        }finally{gate.unlock();}
    }
    private ObjectNode publish(String projectId,WorkflowManager root,WorkflowManager scope,ObjectNode identity)throws Exception {
        ContextRegistry.Entry<Bound> entry;
        try{entry=contexts.bind(id->new Bound(id,projectId,root,scope,identity.deepCopy().put("contextId",id)));}
        catch(ContextRegistry.Capacity full){throw new Conflict("CONTEXT_LIMIT",full.getMessage(),usageNode(full.usage()));}
        try{return inspect(entry.id());}catch(Exception failed){contexts.release(entry.id());throw failed;}
    }
    private static void arguments(JsonNode args,Set<String> allowed,String action) {
        if(!args.isObject())throw new IllegalArgumentException("context."+action+" arguments must be an object");
        args.fieldNames().forEachRemaining(key->{if(!allowed.contains(key))throw new IllegalArgumentException("Unknown context."+action+" argument: "+key);});
    }
    private ObjectNode usageNode(ContextRegistry.Usage usage) {
        ObjectNode out=BridgeActivator.JSON.createObjectNode().put("sessionId",process.path("id").asText())
            .put("active",usage.active()).put("cap",usage.cap()).put("remaining",usage.remaining())
            .put("warningAt",usage.warningAt()).put("warning",usage.warning())
            .put("status",usage.remaining()==0?"full":usage.warning()?"warning":"ok");
        if(usage.warning())out.put("guidance","Reuse context.inspect for refresh; explicitly release finished contexts or prune proven invalid models. Live contexts are never evicted automatically.");
        return out;
    }
    ObjectNode usage(JsonNode args) {
        arguments(args,Set.of(),"usage");return usageNode(contexts.usage());
    }
    ObjectNode release(JsonNode args) {
        arguments(args,Set.of("contextId"),"release");String id=NativeTarget.required(args,"contextId");
        if(contexts.release(id)==null)throw unknown(id);
        return BridgeActivator.JSON.createObjectNode().put("contextId",id).put("released",true).set("usage",usageNode(contexts.usage()));
    }
    ObjectNode prune(JsonNode args) {
        arguments(args,Set.of(),"prune");long deadline=System.nanoTime()+PRUNE_BUDGET_NANOS;
        var pruned=contexts.prune(bound->modelValidity(bound,new ScanBudget(deadline)));
        ObjectNode result=BridgeActivator.JSON.createObjectNode().put("checked",pruned.checked()).put("removed",pruned.removedIds().size())
            .put("retained",pruned.retained()).put("skipped",pruned.skipped()).put("complete",pruned.skipped()==0)
            .put("lockWaitMs",0).put("budgetMs",PRUNE_BUDGET_NANOS/1_000_000L);
        var ids=result.putArray("removedContextIds");pruned.removedIds().forEach(ids::add);
        result.set("usage",usageNode(contexts.usage()));return result;
    }
    private static Conflict unknown(String id){return new Conflict("CONTEXT_CHANGED","Unknown or released context in this native session: "+id);}
    private static ReentrantLock tryRootLock(WorkflowManager root) {
        var lock=root.getReentrantLockInstance();
        if(!lock.tryLock())throw new Conflict("CONTEXT_BUSY","Bound workflow lock is busy; context was retained and no workflow action started");
        return lock;
    }
    private static final class ScanBudget {
        final long deadline;int remaining=MODEL_SCAN_LIMIT;
        ScanBudget(long deadline){this.deadline=deadline;}
        boolean exhausted(){return remaining--<=0||System.nanoTime()-deadline>=0;}
    }
    private static ContextRegistry.Validity scopeValidity(WorkflowManager workflow,WorkflowManager scope,ScanBudget budget,int depth) {
        if(budget.exhausted()||depth>128)return ContextRegistry.Validity.UNKNOWN;
        if(workflow==scope)return ContextRegistry.Validity.VALID;
        for(var node:workflow.getNodeContainers()) {
            if(budget.exhausted())return ContextRegistry.Validity.UNKNOWN;
            WorkflowManager child=NativeTarget.nested(node);
            if(child!=null) {
                if(child==scope)return ContextRegistry.Validity.VALID;
                var found=scopeValidity(child,scope,budget,depth+1);
                if(found!=ContextRegistry.Validity.INVALID)return found;
            }
        }
        return ContextRegistry.Validity.INVALID;
    }
    private ContextRegistry.Validity modelValidity(Bound bound,ScanBudget budget) {
        if(bound.root()==null)return ContextRegistry.Validity.VALID;
        if(budget.exhausted())return ContextRegistry.Validity.UNKNOWN;
        var project=ProjectManager.getInstance().getProject(bound.projectId());
        if(project.isEmpty()||project.get().getWorkflowManagerIfLoaded().orElse(null)!=bound.root())return ContextRegistry.Validity.INVALID;
        var gate=bound.root().getReentrantLockInstance();
        if(!gate.tryLock())return ContextRegistry.Validity.UNKNOWN;
        try(var lock=bound.root().lock()) {
            project=ProjectManager.getInstance().getProject(bound.projectId());
            if(project.isEmpty()||project.get().getWorkflowManagerIfLoaded().orElse(null)!=bound.root())return ContextRegistry.Validity.INVALID;
            return scopeValidity(bound.root(),bound.scope(),budget,0);
        }catch(Exception unavailable){return ContextRegistry.Validity.UNKNOWN;}
        finally{gate.unlock();}
    }
    Bound require(String id) {
        Bound bound=contexts.get(id);if(bound==null)throw unknown(id);
        if(bound.root()!=null) {
            var project=ProjectManager.getInstance().getProject(bound.projectId());
            if(project.isEmpty()||project.get().getWorkflowManagerIfLoaded().orElse(null)!=bound.root())throw new Conflict("CONTEXT_CHANGED","Bound project closed or its loaded model changed");
            ReentrantLock gate=tryRootLock(bound.root());
            try(var lock=bound.root().lock()) {
                project=ProjectManager.getInstance().getProject(bound.projectId());
                if(project.isEmpty()||project.get().getWorkflowManagerIfLoaded().orElse(null)!=bound.root())throw new Conflict("CONTEXT_CHANGED","Bound project closed or its loaded model changed");
                var valid=scopeValidity(bound.root(),bound.scope(),new ScanBudget(System.nanoTime()+PRUNE_BUDGET_NANOS),0);
                if(valid==ContextRegistry.Validity.INVALID)throw new Conflict("CONTEXT_CHANGED","Bound workflow scope was removed or replaced");
                if(valid==ContextRegistry.Validity.UNKNOWN)throw new Conflict("CONTEXT_BUSY","Workflow scope could not be verified within the bounded scan; context was retained");
            }catch(Conflict conflict){throw conflict;}catch(Exception unavailable){throw new Conflict("CONTEXT_CHANGED","Bound model could not be verified");}
            finally{gate.unlock();}
        }
        if(contexts.get(id)!=bound)throw unknown(id);
        return bound;
    }
    ObjectNode inspect(String id)throws Exception {
        Bound b=require(id);ObjectNode result=b.identity().deepCopy();
        result.set("guardCoverage",OperationPolicy.coverage());result.set("revisionCoverage",RevisionTracker.coverage());
        result.set("usage",usageNode(contexts.usage()));
        if(b.root()==null){if(contexts.get(id)!=b)throw unknown(id);result.putNull("revisions");return result;}
        ReentrantLock gate=tryRootLock(b.root());
        try(var lock=b.root().lock()) {
            require(id);result.set("revisions",RevisionTracker.read(b.scope()));result.put("dirty",b.root().isDirty());
            result.put("activeProject",ProjectManager.getInstance().isActiveProject(b.projectId()));
            if(contexts.get(id)!=b)throw unknown(id);return result;
        }finally{gate.unlock();}
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
        if(contexts.get(id)!=b)throw unknown(id);
        return b;
    }
}
