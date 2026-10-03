package org.knime.agent;
import com.fasterxml.jackson.databind.JsonNode;
import org.knime.core.node.workflow.*;
import org.knime.gateway.impl.project.ProjectManager;
final class NativeTarget {
    static String required(JsonNode args,String key){if(!args.path(key).isTextual()||args.path(key).asText().isBlank())throw new IllegalArgumentException(key+" must be a nonempty string");return args.path(key).asText();}
    static WorkflowManager root(JsonNode args){return ProjectManager.getInstance().getProject(required(args,"projectId")).orElseThrow().root();}
    static WorkflowManager workflow(WorkflowManager root,JsonNode args){return !args.has("workflowId")||args.path("workflowId").asText().equals("root")?root:(WorkflowManager)findExact(root,args.path("workflowId").asText(),0);}
    static NodeContainer node(WorkflowManager root,JsonNode args){return workflow(root,args);}
    static WorkflowManager nested(NodeContainer node){return node instanceof WorkflowManager w?w:null;}
    static String relative(WorkflowManager root,NodeContainer.ID id){return id.equals(root.getID())?"root":id.toString();}
    static NodeContainer findExact(WorkflowManager root,String id,int depth){if(root.getID().toString().equals(id))return root;for(var node:root.nodes){if(node.getID().toString().equals(id))return node;if(node instanceof WorkflowManager w){var found=findExact(w,id,depth+1);if(found!=null)return found;}}return null;}
}
