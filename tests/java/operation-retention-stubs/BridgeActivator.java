package org.knime.agent;
import com.fasterxml.jackson.databind.*;
import java.nio.file.*;
final class BridgeActivator {
    static final ObjectMapper JSON=new ObjectMapper();
    static void preserveNativeResult(com.fasterxml.jackson.databind.node.ObjectNode target,JsonNode result) {
        try {
            byte[] bytes=JSON.writeValueAsBytes(result);target.put("nativeResultBytes",bytes.length);
            if(bytes.length<=64*1024)target.set("nativeResult",result.deepCopy());
            else target.put("nativeResultOmitted","Result exceeds 64 KiB; inspect the target before any retry").put("nativeResultSha256",java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes)));
        }catch(Exception failure){target.put("nativeResultOmitted","Result could not be encoded; inspect the target before any retry");}
    }
    static void atomicWrite(Path path,JsonNode value)throws Exception {
        Files.createDirectories(path.getParent());Path temporary=path.resolveSibling(path.getFileName()+".tmp");
        Files.write(temporary,JSON.writeValueAsBytes(value));Files.move(temporary,path,StandardCopyOption.REPLACE_EXISTING);
    }
}
