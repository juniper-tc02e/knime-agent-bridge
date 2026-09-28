package org.knime.agent;

import com.fasterxml.jackson.databind.JsonNode;
import org.knime.core.node.workflow.*;
import org.knime.gateway.impl.project.ProjectManager;

/** One strict resolver shared by native reads, guarded writes and captures. */
final class NativeTarget {
    static String required(JsonNode args,String key) {
        JsonNode value=args.path(key);
        if(!value.isTextual()||value.asText().isBlank())throw new IllegalArgumentException(key+" must be a nonempty string");
        return value.asText();
    }
    static WorkflowManager root(JsonNode args) {
        String id=required(args,"projectId");
        return ProjectManager.getInstance().getProject(id).orElseThrow(()->new IllegalArgumentException("Project not found: "+id))
            .getWorkflowManagerIfLoaded().orElseThrow(()->new IllegalArgumentException("Project is not loaded: "+id));
    }
    static WorkflowManager nested(NodeContainer nc) {
        return nc instanceof WorkflowManager w?w:nc instanceof SubNodeContainer s?s.getWorkflowManager():null;
    }
    static String relative(WorkflowManager root,NodeID id) {
        String prefix=root.getID().toString(),full=id.toString();
        return full.equals(prefix)?"root":full.startsWith(prefix+":")?"root:"+full.substring(prefix.length()+1):full;
    }
    static NodeContainer findExact(WorkflowManager w,String id,int depth) {
        if(depth>128)throw new IllegalArgumentException("Workflow nesting exceeds supported resolver depth");
        if(w.getID().toString().equals(id))return w;
        for(NodeContainer nc:w.getNodeContainers()) {
            if(nc.getID().toString().equals(id))return nc;
            WorkflowManager child=nested(nc);
            if(child!=null){NodeContainer found=findExact(child,id,depth+1);if(found!=null)return found;}
        }
        return null;
    }
    static NodeContainer find(WorkflowManager root,String value) {
        if(value.equals("root")||value.equals(root.getID().toString()))return root;
        boolean absolute=value.startsWith("root:")||value.startsWith(root.getID()+":");
        String full=value.startsWith("root:")?root.getID()+value.substring(4):value;
        NodeContainer nc=findExact(root,full,0);
        if(nc==null&&!absolute)nc=findExact(root,root.getID()+":"+value,0);
        if(nc==null)throw new IllegalArgumentException("Node or workflow not found: "+value);
        return nc;
    }
    static WorkflowManager workflow(WorkflowManager root,JsonNode args) {
        if(!args.has("workflowId"))return root;
        String id=required(args,"workflowId");
        if(id.equals("root"))return root;
        WorkflowManager w=nested(find(root,id));
        if(w==null)throw new IllegalArgumentException("workflowId does not identify a component or metanode");return w;
    }
    static NodeContainer node(WorkflowManager root,JsonNode args) {
        WorkflowManager w=workflow(root,args);
        if(!args.has("nodeId"))return w;
        String node=required(args,"nodeId"),prefix=root.getID().toString();
        boolean absolute=node.equals("root")||node.startsWith("root:")||node.equals(prefix)||node.startsWith(prefix+":");
        if(absolute) {
            String id=node.equals("root")?prefix:node.startsWith("root:")?prefix+node.substring(4):node;
            NodeContainer nc=findExact(w,id,0);
            if(nc==null)throw new IllegalArgumentException("Node or workflow not found inside selected workflow: "+node);
            return nc;
        }
        return find(w,node);
    }
}
