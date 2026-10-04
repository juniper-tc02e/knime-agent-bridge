package org.knime.agent;

import java.util.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.knime.core.node.workflow.*;

/** Read-only, scope-bounded lineage and native variable resolution. Never executes a producer. */
final class DependencyAccess {
    private static int limit(JsonNode args,String key,int fallback,int max) {
        if(!args.has(key))return fallback;
        JsonNode n=args.get(key);if(!n.isIntegralNumber()||!n.canConvertToInt()||n.intValue()<1||n.intValue()>max)throw new IllegalArgumentException(key+" must be 1.."+max);
        return n.intValue();
    }
    static Object inspect(JsonNode args)throws Exception {
        if(!args.isObject())throw new IllegalArgumentException("args must be an object");
        args.fieldNames().forEachRemaining(k->{if(!Set.of("projectId","workflowId","nodeId","maxNodes","maxVariables","includeEffectiveSettings","variableNames","pathChecks").contains(k))throw new IllegalArgumentException("Unknown dependency.inspect argument: "+k);});
        NativeTarget.required(args,"nodeId");
        if(args.has("includeEffectiveSettings")&&!args.get("includeEffectiveSettings").isBoolean())throw new IllegalArgumentException("includeEffectiveSettings must be boolean");
        int maxNodes=limit(args,"maxNodes",2000,10000),maxVariables=limit(args,"maxVariables",100,1000);
        List<String> names=null;
        if(args.has("variableNames")){
            if(!args.get("variableNames").isArray()||args.get("variableNames").size()>1000)throw new IllegalArgumentException("variableNames must be a list of at most 1000 names");
            names=new ArrayList<>();Set<String> seen=new HashSet<>();for(JsonNode name:args.get("variableNames")){if(!name.isTextual()||name.asText().isBlank()||!seen.add(name.asText()))throw new IllegalArgumentException("variableNames requires unique nonempty names");names.add(name.asText());}
        }
        if(args.has("pathChecks")){
            JsonNode checks=args.get("pathChecks");if(!checks.isArray()||checks.size()>100)throw new IllegalArgumentException("pathChecks must be a list of at most 100 checks");
            for(JsonNode check:checks){if(!check.isObject()||check.has("variableName")==check.has("settingsPath"))throw new IllegalArgumentException("Each path check requires exactly one variableName or settingsPath");
                check.fieldNames().forEachRemaining(k->{if(!Set.of("variableName","settingsPath","expectedRoot").contains(k))throw new IllegalArgumentException("Unknown path check key: "+k);});
                if(check.has("variableName"))NativeTarget.required(check,"variableName");if(check.has("expectedRoot"))NativeTarget.required(check,"expectedRoot");
                if(check.has("settingsPath")){JsonNode p=check.get("settingsPath");if(!p.isArray()||p.isEmpty()||p.size()>64)throw new IllegalArgumentException("settingsPath must contain 1..64 keys");for(JsonNode part:p)if(!part.isTextual()||part.asText().isBlank())throw new IllegalArgumentException("settingsPath keys must be nonempty strings");}
            }
        }
        WorkflowManager root=NativeTarget.root(args);
        try(var lock=root.lock()) {
            WorkflowManager scope=NativeTarget.workflow(root,args);NodeContainer node=NativeTarget.node(root,args);
            // Resolver can select a descendant; lineage never silently widens into its parent scope.
            if(node!=scope&&node.getParent()!=scope)throw new IllegalArgumentException("Select the node's immediate workflowId for dependency inspection");
            ObjectNode out=BridgeActivator.JSON.createObjectNode().put("projectId",NativeTarget.required(args,"projectId"))
                .put("workflowId",scope.getID().toString()).put("gatewayWorkflowId",NativeTarget.relative(root,scope.getID()))
                .put("nodeId",node.getID().toString()).put("gatewayId",NativeTarget.relative(root,node.getID())).put("state",node.getNodeContainerState().toString())
                .put("executedByInspection",false);
            out.set("revisions",RevisionTracker.read(scope));
            String physicalRoot=null;
            ObjectNode physical=out.putObject("physicalWorkflow").put("status","unavailable").put("source","WorkflowContext.getCurrentLocation");
            try{var context=root.getContext();if(context!=null&&context.getCurrentLocation()!=null){physicalRoot=context.getCurrentLocation().toPath().toRealPath().toString();physical.put("status","resolved").put("currentRoot",physicalRoot);
                if(context.getOriginalLocation()!=null)physical.put("originalLocation",context.getOriginalLocation().toString());
                physical.put("originalLocationProvesProducerLineage",false);}}
            catch(Exception failure){physical.put("reason",failure.getClass().getSimpleName());}
            var connections=scope.getConnectionContainers();
            Map<String,List<ConnectionContainer>> incoming=new HashMap<>();int examined=0;boolean edgeTruncated=false;
            for(ConnectionContainer c:connections){if(examined++>=20000){edgeTruncated=true;break;}incoming.computeIfAbsent(c.getDest().toString(),k->new ArrayList<>()).add(c);}
            ArrayNode edges=out.putArray("connections"),upstream=out.putArray("upstreamNodes");Set<String> visited=new HashSet<>();Deque<String> queue=new ArrayDeque<>();queue.add(node.getID().toString());
            while(!queue.isEmpty()&&visited.size()<maxNodes){String id=queue.remove();if(!visited.add(id))continue;
                for(ConnectionContainer c:incoming.getOrDefault(id,List.of())){
                    edges.addObject().put("id",c.getID().toString()).put("source",c.getSource().toString()).put("sourcePort",c.getSourcePort())
                        .put("destination",c.getDest().toString()).put("destinationPort",c.getDestPort()).put("flowVariable",c.isFlowVariablePortConnection());
                    queue.add(c.getSource().toString());
                }
                if(!id.equals(node.getID().toString())){NodeContainer producer=NativeTarget.findExact(scope,id,0);if(producer!=null)upstream.addObject().put("id",id).put("gatewayId",NativeTarget.relative(root,producer.getID())).put("name",producer.getName()).put("state",producer.getNodeContainerState().toString());}
            }
            boolean lineageComplete=queue.isEmpty()&&!edgeTruncated;
            ObjectNode coverage=out.putObject("coverage").put("lineage",lineageComplete?"scope-complete":"truncated").put("crossScopeLineage","not_followed").put("producerDataFingerprint","not_read")
                .put("effectiveOutputRunIdentity","unverified").put("opaqueVariableValues","explicit");
            ArrayNode variables=out.putArray("availableVariables");FlowObjectStack stack=node.getFlowObjectStack();
            Map<String,FlowVariable> available=stack==null?Map.of():stack.getAvailableFlowVariables();int count=0;
            List<String> selectedNames=names==null?new ArrayList<>(available.keySet()):names;
            for(String selectedName:selectedNames){
                if(count++>=maxVariables)break;FlowVariable v=available.get(selectedName);
                if(v==null){variables.addObject().put("name",selectedName).put("status","unavailable");continue;}
                String name=v.getName();String type=v.getVariableType().toString();
                ObjectNode row=variables.addObject().put("name",name).put("nativeType",type).put("scope",v.getScope().toString());
                if(SettingsCodec.protectedKey(name)||type.toLowerCase(Locale.ROOT).contains("credential")){row.put("redacted",true);continue;}
                // No arbitrary toString on unknown variable values: it may disclose secrets or hide type loss.
                switch(v.getType()){
                    case STRING -> row.put("value",v.getStringValue());
                    case INTEGER -> row.put("value",v.getIntValue());
                    case DOUBLE -> {double value=v.getDoubleValue();if(Double.isFinite(value))row.put("value",value);else row.put("value",Double.toString(value));}
                    default -> row.put("opaque",true).put("reason","Native type is not a supported scalar; inspect resolved typed model settings");
                }
            }
            coverage.put("variables",stack==null?"unavailable":selectedNames.size()<=maxVariables?(names==null?"complete_names":"selected_names"):"truncated");out.put("totalVariables",available.size());
            ArrayNode bindings=out.putArray("settingBindings");
            try{JsonNode envelope=SettingsCodec.encode(SettingsHealth.read(node).settings());collectBindings(envelope,new ArrayList<>(),bindings);}
            catch(Exception failure){coverage.put("settingBindings","unavailable");out.put("bindingError",failure.getClass().getSimpleName());}
            if(!coverage.has("settingBindings"))coverage.put("settingBindings","stored_names_only");
            ObjectNode effective=out.putObject("effectiveModelSettings");
            if(!args.path("includeEffectiveSettings").asBoolean(true))effective.put("status","not_requested");
            else if(node instanceof SingleNodeContainer single)try{
                effective.put("status","native_resolved").put("source","SingleNodeContainer.getModelSettingsUsingFlowObjectStack");
                effective.set("settings",SettingsCodec.encode(single.getModelSettingsUsingFlowObjectStack()));
                effective.put("executionVerified",false).put("savedArtifactVerified",false);
            }catch(Exception failure){effective.put("status","unavailable").put("errorType",failure.getClass().getSimpleName()).put("reason","Native flow-variable resolution failed; stored fallback is not an effective value");}
            else effective.put("status","unsupported_container");
            ArrayNode pathChecks=out.putArray("pathChecks");
            for(JsonNode check:args.path("pathChecks")){
                String value=null,unknownReason=null;
                if(check.has("variableName")){
                    String name=check.get("variableName").asText();FlowVariable v=available.get(name);
                    if(SettingsCodec.protectedKey(name))unknownReason="Selected variable is protected";
                    else if(v==null)unknownReason="Selected variable is unavailable";
                    else if(v.getVariableType().toString().toLowerCase(Locale.ROOT).contains("credential"))unknownReason="Selected variable is protected";
                    else if(v.getType()==FlowVariable.Type.STRING)value=v.getStringValue();
                    else unknownReason="Selected variable is opaque/non-string; inspect native resolved model settings";
                }else{
                    JsonNode entry=effective.path("settings");boolean firstKey=true;
                    for(JsonNode key:check.path("settingsPath")){
                        if(SettingsCodec.protectedKey(key.asText())||entry.path("redacted").asBoolean()){unknownReason="Selected setting is protected";break;}
                        if(firstKey&&entry.path("key").asText().equals(key.asText())){firstKey=false;continue;}firstKey=false;
                        JsonNode found=null;for(JsonNode child:entry.path("entries"))if(child.path("key").asText().equals(key.asText())){found=child;break;}
                        if(found==null){unknownReason="Selected effective setting path is unavailable";break;}entry=found;
                    }
                    if(unknownReason==null&&entry.path("value").isTextual()&&!entry.path("redacted").asBoolean())value=entry.get("value").asText();
                    else if(unknownReason==null)unknownReason="Selected effective setting is opaque/non-string";
                }
                ObjectNode row=BridgeActivator.JSON.valueToTree(PathLineage.check(value,physicalRoot,check.has("expectedRoot")?check.get("expectedRoot").asText():null));
                row.set("selector",check.deepCopy());if(unknownReason!=null)row.put("reason",unknownReason);
                row.put("producerExecutionLineage","unverified").put("inspectionExecutedOrResetNodes",false);pathChecks.add(row);
            }
            out.putArray("limitations").add("Variable stack is the node's live native stack, not an inferred file path")
                .add("Cross-scope dependencies and producer table fingerprints are not followed")
                .add("Resolved model settings do not certify current UUID, file freshness or producer completion")
                .add("Native validators and node settings APIs are build-specific");
            return out;
        }
    }
    private static void collectBindings(JsonNode entry,List<String> path,ArrayNode rows){
        if(entry.path("redacted").asBoolean())return;
        List<String> next=new ArrayList<>(path);next.add(entry.path("key").asText());
        if(entry.path("key").asText().equals("used_variable")&&entry.path("value").isTextual())rows.addObject().set("path",BridgeActivator.JSON.valueToTree(next));
        if(entry.path("key").asText().equals("used_variable")&&entry.path("value").isTextual())((ObjectNode)rows.get(rows.size()-1)).put("variableName",entry.path("value").asText());
        for(JsonNode child:entry.path("entries"))collectBindings(child,next,rows);
    }
}
