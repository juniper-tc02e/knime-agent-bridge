package org.knime.agent;

import java.lang.reflect.*;
import java.util.*;
import com.fasterxml.jackson.databind.node.*;
import org.knime.core.node.*;
import org.knime.core.node.workflow.*;

/** Pinned KNIME 5.12 adapter: observe save failures before Node's wrapper swallows them. */
final class SettingsHealth {
    record Snapshot(NodeSettings settings,ObjectNode validation) {}
    private static Method method(Class<?> type,String name,Class<?>... parameters)throws Exception {
        Method method=type.getDeclaredMethod(name,parameters);method.setAccessible(true);return method;
    }
    private static void invoke(Method method,Object target,Object... args)throws Exception {
        try {method.invoke(target,args);}
        catch(InvocationTargetException failure) {
            Throwable cause=failure.getCause();
            if(cause instanceof VirtualMachineError fatal)throw fatal;
            if(cause instanceof Exception error)throw error;
            throw new IllegalStateException("Native settings adapter failed",cause);
        }
    }
    static Snapshot read(NodeContainer container)throws Exception {
        ObjectNode health=BridgeActivator.JSON.createObjectNode().put("serialization","passed").put("validation","not_checked")
            .put("validForSave",false).put("coverage","native-model-settings; reopen still required");
        if(!(container instanceof NativeNodeContainer nativeNode)) {
            health.put("serialization","not_checked").put("coverage","container envelope only; inspect children");
            return new Snapshot(container.getNodeSettings(),health);
        }
        NodeContext.pushContext(container);
        try {
            // false,false reads stored settings without asking KNIME to serialize missing
            // defaults through its exception-swallowing saveModelSettingsTo wrapper.
            NodeSettings envelope=new NodeSettings("configuration");
            invoke(method(SingleNodeContainer.class,"saveSettings",NodeSettingsWO.class,boolean.class,boolean.class),container,envelope,false,false);
            NodeModel model=nativeNode.getNode().getNodeModel();
            boolean stored=envelope.containsKey("model");
            if(!stored) {
                NodeSettings generated=new NodeSettings("model");
                try {invoke(method(NodeModel.class,"saveSettingsTo",NodeSettingsWO.class),model,generated);}
                catch(Exception error) {health.put("serialization","failed");issue(health,"serializationError",error);}
                envelope.addNodeSettings(generated); // Partial settings stay available for a typed repair.
            }
            health.put("modelSettingsSource",stored?"stored-envelope":"generated-defaults");
            if(!envelope.containsKey("view")) {
                NodeSettings view=new NodeSettings("view");
                try {nativeNode.getNode().saveDefaultViewSettingsTo(view);if(!view.keySet().isEmpty())envelope.addNodeSettings(view);}
                catch(Exception error) {health.put("serialization","failed");issue(health,"viewSerializationError",error);}
            }
            try {
                invoke(method(NodeModel.class,"validateSettings",NodeSettingsRO.class),model,envelope.getNodeSettings("model"));
                health.put("validation","passed");
            } catch(Exception error) {health.put("validation","failed");issue(health,"validationError",error);}
            health.put("validForSave",health.path("serialization").asText().equals("passed")&&health.path("validation").asText().equals("passed"));
            return new Snapshot(envelope,health);
        } finally {NodeContext.removeLastContext();}
    }
    /** Validate a detached candidate using the native validation-only dispatch. Never loads settings. */
    static ObjectNode validate(NodeContainer container,NodeSettings candidate) {
        ObjectNode health=BridgeActivator.JSON.createObjectNode().put("serialization","not_checked").put("validation","not_checked")
            .put("validForSave",false).put("modelSettingsSource","detached-candidate")
            .put("coverage",container instanceof NativeNodeContainer?"native-common-envelope-and-model-validation; detached serialization":"native-common-envelope-validation only; child settings unknown");
        try {
            // The bytes stay in memory and are discarded; protected native values are not returned.
            candidate.saveToXML(java.io.OutputStream.nullOutputStream());health.put("serialization","passed");
        } catch(Exception error) {health.put("serialization","failed");issue(health,"serializationError",error);}
        NodeContext.pushContext(container);
        try {
            // Reflection invokes the actual container's override (SingleNodeContainer for native nodes).
            // In the pinned KNIME build this parses common settings and calls validateModelSettings.
            invoke(method(NodeContainer.class,"validateSettings",NodeSettingsRO.class),container,candidate);
            health.put("validation","passed");
        } catch(Exception error) {health.put("validation","failed");issue(health,"validationError",error);}
        finally {NodeContext.removeLastContext();}
        health.put("validForSave",container instanceof NativeNodeContainer&&health.path("serialization").asText().equals("passed")
            &&health.path("validation").asText().equals("passed"));
        health.put("viewValidation","not_checked").put("effectiveFlowVariableSettings","unknown").put("savedReopen","not_checked");
        return health;
    }
    private static void issue(ObjectNode out,String name,Exception error) {
        String message=Objects.toString(error.getMessage(),error.getClass().getSimpleName());
        out.putObject(name).put("exception",error.getClass().getName()).put("message",message.substring(0,Math.min(1200,message.length())));
    }
    static ObjectNode inspect(NodeContainer selected,boolean dependencies)throws Exception {
        ArrayNode failures=BridgeActivator.JSON.createArrayNode();Set<NodeContainer> visited=Collections.newSetFromMap(new IdentityHashMap<>());
        ArrayDeque<NodeContainer> pending=new ArrayDeque<>();pending.add(selected);int checked=0;
        while(!pending.isEmpty()) {
            NodeContainer node=pending.removeFirst();if(!visited.add(node))continue;
            if(visited.size()>10000)throw new IllegalArgumentException("Settings validation exceeds 10000 nodes");
            if(node instanceof NativeNodeContainer) {
                checked++;Snapshot snapshot=read(node);
                if(!snapshot.validation().path("validForSave").asBoolean())failures.addObject().put("nodeId",node.getID().toString()).put("name",node.getName()).set("settingsValidation",snapshot.validation());
            }
            WorkflowManager nested=NativeTarget.nested(node);if(nested!=null)pending.addAll(nested.getNodeContainers());
            if(dependencies) {
                WorkflowManager parent=node.getParent();
                if(parent!=null)for(ConnectionContainer connection:parent.getConnectionContainers())if(connection.getDest().equals(node.getID())) {
                    NodeContainer source=NativeTarget.findExact(parent,connection.getSource().toString(),0);if(source!=null)pending.add(source);
                }
            }
        }
        ObjectNode result=BridgeActivator.JSON.createObjectNode().put("validForSave",failures.isEmpty()).put("checkedNodes",checked)
            .put("coverage","native-model-settings; excludes custom view validation and saved-file verification");result.set("issues",failures);return result;
    }
    static void requireValid(NodeContainer selected,boolean dependencies)throws Exception {
        ObjectNode result=inspect(selected,dependencies);
        if(!result.path("validForSave").asBoolean())throw new ContextAccess.Conflict("NODE_SETTINGS_INVALID",
            "Native node settings are incomplete or invalid. Inspect settingsValidation, complete configuration, then retry. No execution/save was dispatched.",result.put("nativeDispatch","not_started"));
    }
}
