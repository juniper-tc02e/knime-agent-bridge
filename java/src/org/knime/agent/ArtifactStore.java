package org.knime.agent;

import java.nio.file.*;
import java.time.Instant;
import java.util.UUID;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Binary publication is atomic, bounded and confined to this session. */
final class ArtifactStore {
    private final Path directory;
    ArtifactStore(Path session)throws Exception {directory=session.resolve("artifacts");Files.createDirectories(directory);}
    Path temporary(String extension)throws Exception {
        if(!extension.equals("svg")&&!extension.equals("png"))throw new IllegalArgumentException("Unsupported artifact extension");
        return Files.createTempFile(directory,".capture-","."+extension+".partial");
    }
    ObjectNode publish(Path temporary,String extension,String mimeType)throws Exception {
        if(!temporary.toAbsolutePath().normalize().getParent().equals(directory.toAbsolutePath().normalize())||Files.isSymbolicLink(temporary))throw new IllegalArgumentException("Artifact path escaped session");
        long size=Files.size(temporary),limit=extension.equals("png")?4L*1024*1024:16L*1024*1024;
        if(size==0||size>limit)throw new IllegalArgumentException("Artifact size outside supported bounds: "+size);
        byte[] bytes=Files.readAllBytes(temporary);String hash=RevisionTracker.bytesDigest(bytes),id=UUID.randomUUID()+"."+extension;
        Path target=directory.resolve(id);Files.move(temporary,target,StandardCopyOption.ATOMIC_MOVE);
        ObjectNode metadata=BridgeActivator.JSON.createObjectNode().put("artifactId",id).put("relativePath",id).put("mimeType",mimeType)
            .put("sha256",hash).put("bytes",size).put("createdAt",Instant.now().toString()).put("expiresAt",Instant.now().plusSeconds(86400).toString());
        BridgeActivator.atomicWrite(directory.resolve(id+".json"),metadata);return metadata;
    }
}
