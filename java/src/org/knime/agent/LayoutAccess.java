package org.knime.agent;

import java.util.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.knime.core.node.workflow.*;
import org.knime.gateway.api.entity.AnnotationIDEnt;
import org.knime.gateway.api.entity.ConnectionIDEnt;

/** Bounded native UI-only setters under one model lock. No gateway undo entry. */
final class LayoutAccess {
    record Edit(String key,Runnable forward,Runnable reverse){}
    static Object apply(ContextAccess contexts,JsonNode args)throws Exception {
        for(Iterator<String> it=args.fieldNames();it.hasNext();)if(!Set.of("contextId","changes").contains(it.next()))throw new IllegalArgumentException("Unknown layout.apply argument");
        String id=NativeTarget.required(args,"contextId");var bound=contexts.require(id);
        if(bound.root()==null)throw new IllegalArgumentException("layout.apply needs a project context");
        JsonNode changes=args.path("changes");if(!changes.isArray()||changes.isEmpty()||changes.size()>500)throw new IllegalArgumentException("changes must contain 1..500 edits");
        try(var lock=bound.root().lock()) {
            OperationPolicy.apply();ObjectNode before=RevisionTracker.read(bound.scope());List<Edit> edits=new ArrayList<>();Set<String> targets=new HashSet<>();
            for(JsonNode change:changes) {
                String kind=NativeTarget.required(change,"kind");JsonNode from=change.path("before"),to=change.path("after");
                switch(kind) {
                    case "node-position" -> {
                        strict(change,Set.of("kind","nodeId","objectId","before","after"));String nodeId=objectId(change,"nodeId");
                        ObjectNode target=BridgeActivator.JSON.createObjectNode().put("workflowId",bound.identity().path("workflowId").asText()).put("nodeId",nodeId);
                        NodeContainer node=NativeTarget.node(bound.root(),target);
                        if(node==bound.scope()||node.getParent()!=bound.scope())throw new IllegalArgumentException("Layout node must be a direct member of the bound scope");
                        NodeUIInformation original=node.getUIInformation();if(original==null)throw new IllegalArgumentException("Node has no native UI information");
                        int[] bounds=original.getBounds();int[] old=position(from),next=position(to);
                        if(bounds[0]!=old[0]||bounds[1]!=old[1])throw new ContextAccess.Conflict("REVISION_CONFLICT","Node position differs from plan: "+nodeId);
                        NodeUIInformation updated=NodeUIInformation.builder(original).setNodeLocation(next[0],next[1],bounds[2],bounds[3]).build();
                        edits.add(new Edit("node:"+node.getID(),()->node.setUIInformation(updated),()->node.setUIInformation(original)));
                    }
                    case "annotation-bounds" -> {
                        strict(change,Set.of("kind","annotationId","objectId","before","after"));String annotationId=objectId(change,"annotationId");WorkflowAnnotation found=null;
                        for(WorkflowAnnotation a:bound.scope().getWorkflowAnnotations())if(new AnnotationIDEnt(a.getID(),bound.scope()).toString().equals(annotationId)||a.getID().toString().equals(annotationId)) {
                            if(found!=null&&found!=a)throw new IllegalArgumentException("Ambiguous annotation ID in bound scope: "+annotationId);
                            found=a;
                        }
                        if(found==null)throw new IllegalArgumentException("Annotation not found in bound scope: "+annotationId);
                        final WorkflowAnnotation annotation=found;int[] old=rectangle(from),next=rectangle(to);
                        if(!Arrays.equals(old,new int[]{annotation.getX(),annotation.getY(),annotation.getWidth(),annotation.getHeight()}))throw new ContextAccess.Conflict("REVISION_CONFLICT","Annotation bounds differ from plan");
                        edits.add(new Edit("annotation:"+annotationId,()->annotation.setDimension(next[0],next[1],next[2],next[3]),()->annotation.setDimension(old[0],old[1],old[2],old[3])));
                    }
                    case "connection-bendpoints" -> {
                        strict(change,Set.of("kind","connectionId","objectId","before","after"));String connectionId=objectId(change,"connectionId");ConnectionContainer found=null;
                        for(ConnectionContainer c:bound.scope().getConnectionContainers())if(new ConnectionIDEnt(c.getID(),bound.scope()).toString().equals(connectionId)||c.getID().toString().equals(connectionId)) {
                            if(found!=null&&found!=c)throw new IllegalArgumentException("Ambiguous connection ID in bound scope: "+connectionId);
                            found=c;
                        }
                        if(found==null)throw new IllegalArgumentException("Connection not found in bound scope: "+connectionId);
                        final ConnectionContainer connection=found;ConnectionUIInformation original=connection.getUIInfo();
                        int[][] old=points(from),next=points(to),actual=original==null?new int[0][]:original.getAllBendpoints();
                        if(!Arrays.deepEquals(old,actual))throw new ContextAccess.Conflict("REVISION_CONFLICT","Connection bendpoints differ from plan");
                        ConnectionUIInformation updated=ConnectionUIInformation.builder().setBendpoints(next).build();
                        edits.add(new Edit("connection:"+connectionId,()->connection.setUIInfo(updated),()->connection.setUIInfo(original)));
                    }
                    default -> throw new IllegalArgumentException("Unsupported layout edit kind: "+kind);
                }
                if(!targets.add(edits.get(edits.size()-1).key()))throw new IllegalArgumentException("Duplicate layout target");
            }
            int applied=0;Throwable failure=null;boolean rollbackComplete=true;
            try {
                for(Edit edit:edits){applied++;edit.forward().run();}
                ObjectNode after=RevisionTracker.read(bound.scope());
                for(String dimension:List.of("structure","configuration","execution"))if(!before.get(dimension).equals(after.get(dimension)))throw new IllegalStateException("UI layout setters changed "+dimension+" evidence");
                ObjectNode result=BridgeActivator.JSON.createObjectNode().put("status","applied").put("applied",true).put("changedObjects",applied)
                    .put("guardCoverage","apply-time").put("undoEntry",false).put("scopeId",bound.identity().path("workflowId").asText());
                result.set("beforeRevisions",before);result.set("afterRevisions",after);result.set("context",contexts.inspect(id));
                result.putObject("integrity").put("structure","matched").put("configuration","matched-redacted-settings").put("execution","matched-states-and-output-availability")
                    .put("fullDataFingerprint","not-checked").put("protectedSettings","not-observable");return result;
            }catch(Throwable e){failure=e;}
            for(int n=applied-1;n>=0;n--)try{edits.get(n).reverse().run();}catch(Throwable ignored){rollbackComplete=false;}
            ObjectNode after=RevisionTracker.read(bound.scope());rollbackComplete=rollbackComplete&&before.equals(after);
            ObjectNode result=BridgeActivator.JSON.createObjectNode().put("status",rollbackComplete?"failed":"partially_applied").put("applied",false)
                .put("guardCoverage","apply-time").put("rollbackComplete",rollbackComplete).put("error",failure.toString());
            result.set("beforeRevisions",before);result.set("afterRevisions",after);return result;
        }
    }
    private static String objectId(JsonNode change,String kind) {
        if(change.has(kind)&&change.has("objectId")&&!change.path(kind).equals(change.path("objectId")))throw new IllegalArgumentException("Conflicting layout object identifiers");
        return NativeTarget.required(change,change.has(kind)?kind:"objectId");
    }
    private static void strict(JsonNode n,Set<String> fields){if(!n.isObject())throw new IllegalArgumentException("Layout edit must be an object");n.fieldNames().forEachRemaining(k->{if(!fields.contains(k))throw new IllegalArgumentException("Unknown layout edit field: "+k);});}
    private static int number(JsonNode n,String name) {
        JsonNode value=n.path(name);if(!value.isIntegralNumber()||!value.canConvertToInt()||Math.abs((long)value.asInt())>1000000)throw new IllegalArgumentException("Layout "+name+" must be an integer within +/-1000000");return value.asInt();
    }
    private static int[] position(JsonNode n){strict(n,Set.of("x","y"));return new int[]{number(n,"x"),number(n,"y")};}
    private static int[] rectangle(JsonNode n){strict(n,Set.of("x","y","width","height"));int[] r={number(n,"x"),number(n,"y"),number(n,"width"),number(n,"height")};if(r[2]<1||r[3]<1)throw new IllegalArgumentException("Annotation dimensions must be positive");return r;}
    private static int[][] points(JsonNode n){if(!n.isArray()||n.size()>1000)throw new IllegalArgumentException("Bendpoints must be an array with at most 1000 positions");int[][] result=new int[n.size()][];for(int i=0;i<n.size();i++)result[i]=position(n.get(i));return result;}
}
