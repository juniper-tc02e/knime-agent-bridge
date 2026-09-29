package org.knime.agent;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.util.UUID;

/** Retry only the metadata publication, never the native action that produced it. */
final class AtomicFiles {
    static void write(Path path,byte[] bytes)throws Exception {
        Path tmp=path.resolveSibling(path.getFileName()+"."+UUID.randomUUID()+".tmp");
        try {
            try(FileChannel file=FileChannel.open(tmp,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)) {
                ByteBuffer buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())file.write(buffer);file.force(true);
            }
            for(int attempt=0;;attempt++) {
                try {
                    try {Files.move(tmp,path,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
                    catch(AtomicMoveNotSupportedException unsupported){Files.move(tmp,path,StandardCopyOption.REPLACE_EXISTING);}
                    return;
                } catch(FileSystemException contention) {
                    if(!retryable(contention)||attempt>=9)throw contention;
                    try {Thread.sleep(Math.min(25L<<Math.min(attempt,4),250L));}
                    catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw interrupted;}
                }
            }
        } finally {try{Files.deleteIfExists(tmp);}catch(IOException ignored){/* Original failure remains authoritative. */}}
    }
    private static boolean retryable(FileSystemException error) {
        if(error instanceof AccessDeniedException)return true;
        String reason=String.valueOf(error.getReason()).toLowerCase(java.util.Locale.ROOT);
        return reason.contains("used by another process")||reason.contains("sharing violation")||reason.contains("being used");
    }
}
