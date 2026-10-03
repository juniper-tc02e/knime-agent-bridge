package org.knime.agent;
import com.fasterxml.jackson.databind.JsonNode;
import java.security.MessageDigest;
import java.util.HexFormat;
final class RevisionTracker {
    static String digest(JsonNode payload)throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(BridgeActivator.JSON.writeValueAsBytes(payload)));
    }
}
