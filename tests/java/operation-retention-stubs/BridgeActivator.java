package org.knime.agent;
import com.fasterxml.jackson.databind.*;
import java.nio.file.*;
final class BridgeActivator {
    static final ObjectMapper JSON=new ObjectMapper();
    static void atomicWrite(Path path,JsonNode value)throws Exception {
        Files.createDirectories(path.getParent());Path temporary=path.resolveSibling(path.getFileName()+".tmp");
        Files.write(temporary,JSON.writeValueAsBytes(value));Files.move(temporary,path,StandardCopyOption.REPLACE_EXISTING);
    }
}
