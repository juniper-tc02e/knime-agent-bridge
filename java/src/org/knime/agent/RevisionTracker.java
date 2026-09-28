package org.knime.agent;

import java.security.MessageDigest;
import java.util.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.knime.core.node.NodeSettings;
import org.knime.core.node.workflow.*;

/** Content revisions: caller owns the root model lock. Protected settings stay redacted. */
final class RevisionTracker {
    static String digest(JsonNode value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(BridgeActivator.JSON.writeValueAsBytes(canonical(value))));
    }
    static String bytesDigest(byte[] value)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));}
    static JsonNode canonical(JsonNode value) {
        if(value.isObject()) {
            ObjectNode out=BridgeActivator.JSON.createObjectNode();TreeSet<String> keys=new TreeSet<>();value.fieldNames().forEachRemaining(keys::add);
            for(String key:keys)out.set(key,canonical(value.get(key)));return out;
        }
        if(value.isArray()){ArrayNode out=BridgeActivator.JSON.createArrayNode();for(JsonNode v:value)out.add(canonical(v));return out;}
        return value;
    }
    static ObjectNode read(WorkflowManager scope)throws Exception {
        ObjectNode inputs=BridgeActivator.JSON.createObjectNode();
        for(String name:List.of("structure","configuration","layout","execution"))inputs.putArray(name);
        walk(scope,inputs,new int[]{0},0);
        ObjectNode result=BridgeActivator.JSON.createObjectNode();
        for(String name:List.of("structure","configuration","layout","execution"))result.put(name,digest(inputs.get(name)));
        return result;
    }
    static ObjectNode coverage() {
        ObjectNode out=BridgeActivator.JSON.createObjectNode().put("structure","complete-for-loaded-scope")
            .put("configuration","redacted-settings-only").put("layout","native-ui-fields-and-serialized-annotations")
            .put("execution","states-and-output-availability; progress-excluded");
        out.putArray("omissions").add("Protected settings values are not hashed; external protected-value edits cannot be detected")
            .add("Execution revision is not a full output-data fingerprint or a durable execution-generation identifier")
            .add("Native layout revision does not observe browser-only selection, zoom or renderer preferences");
        return out;
    }
    private static void walk(WorkflowManager scope,ObjectNode inputs,int[] count,int depth)throws Exception {
        if(depth>128)throw new IllegalArgumentException("Revision nesting exceeds 128");
        List<NodeContainer> nodes=new ArrayList<>(scope.getNodeContainers());nodes.sort(Comparator.comparing(n->n.getID().toString()));
        for(NodeContainer n:nodes) {
            if(++count[0]>10000)throw new IllegalArgumentException("Revision scope exceeds 10000 nodes");
            String id=n.getID().toString();
            ObjectNode structure=((ArrayNode)inputs.get("structure")).addObject().put("id",id).put("parent",scope.getID().toString())
                .put("kind",n.getClass().getName()).put("inputs",n.getNrInPorts()).put("outputs",n.getNrOutPorts());
            if(n instanceof NativeNodeContainer nativeNode)structure.put("factory",nativeNode.getNode().getFactory().getFactoryId());
            ArrayNode portTypes=structure.putArray("portTypes");
            for(int p=0;p<n.getNrInPorts();p++)portTypes.add(n.getInPort(p).getPortType().getPortObjectClass().getName());
            for(int p=0;p<n.getNrOutPorts();p++)portTypes.add(n.getOutPort(p).getPortType().getPortObjectClass().getName());
            ObjectNode configuration=((ArrayNode)inputs.get("configuration")).addObject().put("id",id);
            // SettingsCodec never exposes/hashes password or transient values.
            try {configuration.set("settings",SettingsCodec.encode(n.getNodeSettings()));}
            catch(Exception e){configuration.put("unavailable",e.getClass().getName());}
            ObjectNode layout=((ArrayNode)inputs.get("layout")).addObject().put("id",id).put("name",n.getName())
                .put("label",n.getDisplayLabel()).put("customName",n.getCustomName());
            if(n.getUIInformation()!=null)layout.set("ui",BridgeActivator.JSON.valueToTree(Map.of("bounds",n.getUIInformation().getBounds(),
                "absolute",n.getUIInformation().hasAbsoluteCoordinates(),"symbolRelative",n.getUIInformation().isSymbolRelative(),"snapToGrid",n.getUIInformation().getSnapToGrid())));
            if(n.getNodeAnnotation()!=null)layout.set("annotation",annotation(n.getNodeAnnotation()));
            ObjectNode execution=((ArrayNode)inputs.get("execution")).addObject().put("id",id).put("state",n.getNodeContainerState().toString()).put("inactive",n.isInactive());
            ArrayNode outputs=execution.putArray("outputs");
            for(int p=0;p<n.getNrOutPorts();p++)outputs.add(n.getOutPort(p).getPortObject()!=null);
            WorkflowManager nested=NativeTarget.nested(n);if(nested!=null)walk(nested,inputs,count,depth+1);
        }
        List<ConnectionContainer> connections=new ArrayList<>(scope.getConnectionContainers());connections.sort(Comparator.comparing(c->c.getID().toString()));
        for(ConnectionContainer c:connections) {
            ((ArrayNode)inputs.get("structure")).addObject().put("connection",c.getID().toString()).put("source",c.getSource().toString()).put("sourcePort",c.getSourcePort())
                .put("destination",c.getDest().toString()).put("destinationPort",c.getDestPort()).put("type",c.getType().toString());
            ObjectNode layout=((ArrayNode)inputs.get("layout")).addObject().put("connection",c.getID().toString());
            layout.set("bendpoints",BridgeActivator.JSON.valueToTree(c.getUIInfo()==null?new int[0][]:c.getUIInfo().getAllBendpoints()));
        }
        List<WorkflowAnnotation> annotations=new ArrayList<>(scope.getWorkflowAnnotations());annotations.sort(Comparator.comparing(a->a.getID().toString()));
        for(WorkflowAnnotation a:annotations)((ArrayNode)inputs.get("layout")).addObject().put("annotation",a.getID().toString()).set("data",annotation(a));
    }
    static JsonNode annotation(Annotation annotation)throws Exception {
        NodeSettings settings=new NodeSettings("annotation");annotation.save(settings);return SettingsCodec.encode(settings);
    }
}

