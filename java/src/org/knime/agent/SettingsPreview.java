package org.knime.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.knime.core.node.NodeSettings;
import org.knime.core.node.config.base.*;

/** Shared detached patch preparation. It never has a live node reference. */
final class SettingsPreview {
    record Prepared(NodeSettings settings,ArrayNode diff,int changedFields) {}
    private SettingsPreview() {}
    static Prepared prepare(NodeSettings original,JsonNode patches)throws Exception {
        SettingsCodec.validatePatches(patches);
        NodeSettings candidate=SettingsCodec.detachedCopy(original);
        SettingsCodec.patch(candidate,patches);
        ArrayNode diff=BridgeActivator.JSON.createArrayNode();int changed=0;
        for(JsonNode patch:patches) {
            ObjectNode before=entry(original,patch.path("path")),after=entry(candidate,patch.path("path"));
            boolean different=!before.equals(after);if(different)changed++;
            ObjectNode row=diff.addObject().put("changed",different).put("kind",before.path("exists").asBoolean()?"update":"add");
            row.set("path",patch.path("path").deepCopy());row.set("before",before);row.set("after",after);
            row.put("requestedType",patch.path("type").asText(after.path("type").asText()));
            row.put("createParents",patch.path("createParents").asBoolean(false));
            if(before.path("type").asText().equals("config")&&patch.path("type").asText().endsWith("Array"))
                row.put("arrayElementTypeCoverage",arrayElementCoverage(before));
        }
        return new Prepared(candidate,diff,changed);
    }
    private static String arrayElementCoverage(ObjectNode before) {
        for(JsonNode entry:before.path("entries"))if(!entry.path("key").asText().equals("array-size"))return "checked";
        if(before.path("entries").isEmpty())return "unknown-null-native-array-or-empty-config-group";
        return "unknown-empty-native-array";
    }
    private static ObjectNode entry(NodeSettings envelope,JsonNode path)throws Exception {
        AbstractConfigEntry entry=envelope;
        for(JsonNode part:path) {
            if(!(entry instanceof ConfigBase group))return BridgeActivator.JSON.createObjectNode().put("exists",false);
            entry=group.getEntry(part.asText());if(entry==null)return BridgeActivator.JSON.createObjectNode().put("exists",false);
        }
        return SettingsCodec.encode(entry).put("exists",true);
    }
}
