package org.knime.agent;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.knime.core.node.workflow.WorkflowManager;
final class RevisionTracker {
    static Runnable beforeRead;
    static ObjectNode coverage(){return BridgeActivator.JSON.createObjectNode();}
    static ObjectNode read(WorkflowManager scope){if(beforeRead!=null){var callback=beforeRead;beforeRead=null;callback.run();}return BridgeActivator.JSON.createObjectNode().put("structure","s").put("configuration","c").put("layout","l").put("execution","e");}
}
