package org.knime.agent;

import java.io.*;
import java.nio.channels.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.knime.core.node.workflow.WorkflowExporter;
import org.knime.gateway.impl.project.ProjectManager;
import com.sun.jna.platform.win32.*;

/** Native KNIME archive of an already-saved local root. Never saves or executes a workflow. */
final class NativeWorkflowExport {
    static final long DEFAULT_BYTES=128L*1024*1024,MAX_BYTES=512L*1024*1024;
    static final int MAX_ENTRIES=20000,MAX_DEPTH=64;
    private record Evidence(boolean directory,long size,String key,long created,long modified,String sha256){}
    private record Pending(Path path,int depth){}
    private record Archive(ArrayNode manifest,String sha256,long bytes,int files,long uncompressed){}
    private record Identity(Object key,FileTime created,boolean directory){}

    static ObjectNode call(JsonNode args)throws Exception {
        if(args.has("nodeId")||args.has("workflowId"))throw new IllegalArgumentException("core.workflow.export selects the project root only; nodeId/workflowId are not accepted");
        boolean exclude=args.path("excludeData").asBoolean(false);
        if(args.has("excludeData")&&!args.get("excludeData").isBoolean())throw new IllegalArgumentException("excludeData must be boolean");
        long bytes=bound(args,"maxBytes",DEFAULT_BYTES,MAX_BYTES);int entries=(int)bound(args,"maxEntries",MAX_ENTRIES,MAX_ENTRIES);
        String projectId=NativeTarget.required(args,"projectId");
        var project=ProjectManager.getInstance().getProject(projectId).orElseThrow(()->new IllegalArgumentException("Unknown open project: "+projectId));
        if(project.getOrigin().isEmpty()||!project.getOrigin().get().isLocal())throw new IllegalArgumentException("Native workflow export requires a verified local project origin");
        var root=NativeTarget.root(args);
        try(var lock=root.lock()) {
            OperationPolicy.apply();
            if(root.isDirty())throw new ContextAccess.Conflict("WORKFLOW_NOT_SAVED","Save and verify the root before export; export never saves it implicitly");
            if(root.getNodeContainerState().isExecutionInProgress())throw new ContextAccess.Conflict("WORKFLOW_EXECUTING","Wait for the root to settle before exporting its saved disk artifact");
            var context=root.getContext();if(context==null||context.getCurrentLocation()==null)throw new IllegalArgumentException("The project has no physical saved workflow root");
            String configured=System.getProperty("knime.agent.runtime");
            Path runtime=(configured==null||configured.isBlank()?Path.of(System.getProperty("user.home"),".knime-agent","runtime"):Path.of(configured)).toAbsolutePath().normalize();
            ObjectNode out=exportSaved(context.getCurrentLocation().toPath(),runtime,exclude,bytes,entries);
            out.put("projectId",projectId).put("workflowId",root.getID().toString());out.set("revisions",RevisionTracker.read(root));
            return out;
        }
    }
    private static long bound(JsonNode args,String key,long fallback,long maximum) {
        if(!args.has(key))return fallback;JsonNode value=args.get(key);
        if(!value.isIntegralNumber()||!value.canConvertToLong()||value.longValue()<1||value.longValue()>maximum)throw new IllegalArgumentException(key+" must be an integer from 1 to "+maximum);
        return value.longValue();
    }
    static ObjectNode exportSaved(Path source,Path runtime,boolean excludeData,long maxBytes,int maxEntries)throws Exception {
        return exportSaved(source,runtime,excludeData,maxBytes,maxEntries,(phase,file)->{});
    }
    // Private deterministic race seam used only by the isolated installed-API harness.
    private static ObjectNode exportSaved(Path source,Path runtime,boolean excludeData,long maxBytes,int maxEntries,java.util.function.BiConsumer<String,Path> checkpoint)throws Exception {
        if(maxBytes<1||maxBytes>MAX_BYTES||maxEntries<1||maxEntries>MAX_ENTRIES)throw new IllegalArgumentException("Invalid native export bound");
        Path root=source.toAbsolutePath().normalize();exact(root);
        if(!Files.isRegularFile(root.resolve("workflow.knime"),LinkOption.NOFOLLOW_LINKS))throw new IOException("Saved workflow.knime is unavailable");
        Path canonicalRuntime=runtime.toAbsolutePath().normalize();exact(canonicalRuntime);
        Map<Path,Identity> directories=new LinkedHashMap<>();
        for(Path parent=canonicalRuntime;parent!=null;parent=parent.getParent())directories.put(parent,identity(parent,true));
        Path exports=canonicalRuntime.resolve("exports");Files.createDirectories(exports);check(directories);directories.put(exports,identity(exports,true));
        if(exports.startsWith(root))throw new IOException("Export directory must be outside the saved workflow source");
        Map<Path,Evidence> before=scan(root,maxBytes,maxEntries);
        WorkflowExporter<IOException> exporter=new WorkflowExporter<>(excludeData);
        var resources=exporter.collectResourcesToCopy(List.of(root),root.getParent());
        checkpoint.accept("after_collection",exports);check(directories);
        if(resources.paths().isEmpty()||resources.paths().size()>maxEntries||resources.numFiles()>maxEntries||resources.numBytes()>maxBytes)throw new IOException("Native resource collection exceeds export bound");
        Map<String,Evidence> expected=new TreeMap<>();
        for(var entry:resources.paths().entrySet()) {
            Path file=entry.getKey().toAbsolutePath().normalize();exact(file);
            if(!file.startsWith(root)||!before.containsKey(file))throw new IOException("Native resource escaped its verified canonical source");
            String name=entry.getValue().toPortableString();validName(name,root.getFileName().toString());
            Evidence evidence=before.get(file);if(evidence.directory()&&!name.endsWith("/"))name+="/";
            if(expected.put(name,evidence)!=null)throw new IOException("Duplicate native archive entry");
        }
        if(!expected.containsKey(root.getFileName()+"/workflow.knime"))throw new IOException("Native archive has no saved workflow root entry");
        String id=UUID.randomUUID().toString();Path temp=exports.resolve(id+".knwf.tmp"),target=exports.resolve(id+".knwf");Identity ownedIdentity=null;
        try {
            check(directories);
            try(FileChannel channel=FileChannel.open(temp,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)) {
                ownedIdentity=identity(temp,false);check(directories);OutputStream destination=Channels.newOutputStream(channel);
                OutputStream bounded=new OutputStream(){long written;
                    private void reserve(int length)throws IOException{if(Thread.currentThread().isInterrupted())throw new IOException("Native export interrupted");if(length>maxBytes-written)throw new IOException("Native archive output exceeds byte bound");written+=length;}
                    @Override public void write(int value)throws IOException{reserve(1);destination.write(value);}
                    @Override public void write(byte[] bytes,int offset,int length)throws IOException{reserve(length);destination.write(bytes,offset,length);}
                    @Override public void flush()throws IOException{destination.flush();}
                    // KNIME closes its ZIP stream. Keep the owned channel open until force(true).
                    @Override public void close()throws IOException{flush();}
                };
                exporter.exportInto(resources,bounded,progress->{if(Thread.currentThread().isInterrupted())throw new IOException("Native export interrupted");});
                bounded.flush();channel.force(true);check(directories);check(temp,ownedIdentity);
            }
            check(directories);check(temp,ownedIdentity);
            if(!before.equals(scan(root,maxBytes,maxEntries)))throw new IOException("Saved workflow source changed during native export; discard this archive");
            Archive archive=verify(temp,expected,maxBytes,maxEntries);
            checkpoint.accept("after_archive_verified",temp);check(directories);check(temp,ownedIdentity);
            if(!hashFile(temp,archive.bytes()).equals(archive.sha256()))throw new IOException("Native archive changed before publication");
            check(directories);check(temp,ownedIdentity);
            // UUID destination is new and immutable. No replace-existing or retry of export effects.
            Files.move(temp,target);
            checkpoint.accept("after_publish",target);check(directories);check(target,ownedIdentity);
            BasicFileAttributes published=Files.readAttributes(target,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
            if(published.size()!=archive.bytes()||!hashFile(target,archive.bytes()).equals(archive.sha256()))throw new IOException("Published native archive digest/size verification failed; publication is unconfirmed");
            check(directories);check(target,ownedIdentity);
            if(!same(published,Files.readAttributes(target,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS)))throw new IOException("Published native archive changed during final verification; publication is unconfirmed");
            return BridgeActivator.JSON.createObjectNode().put("status","exported").put("id",id).put("path",target.toString()).put("sha256",archive.sha256()).put("bytes",archive.bytes())
                .put("nativeExporter","org.knime.core.node.workflow.WorkflowExporter").put("exportFormat","knime-workflow").put("excludeData",excludeData)
                .put("savedArtifactSource",root.toString()).put("savePerformed",false).put("executionPerformed",false).put("resetPerformed",false)
                .put("freshInference","unverified").put("cachedVersusFresh","not_inferred_from_exported_bytes")
                .put("fileDurability","forced-closed-hash-verified").put("directoryDurability","not_fsynced")
                .put("filesystemObservation","Directory/file identities and SHA-256 verified through publication; external changes after the final check are not excluded")
                .put("fileCount",archive.files()).put("entryCount",archive.manifest().size()).put("uncompressedBytes",archive.uncompressed()).put("manifestComplete",true).set("manifest",archive.manifest());
        }catch(Throwable primary){throw primary;}
        finally{if(ownedIdentity!=null)try{if(Files.exists(temp,LinkOption.NOFOLLOW_LINKS)){check(directories);check(temp,ownedIdentity);Files.delete(temp);}}catch(Exception ignored){/* Preserve the first failure and any foreign replacement or unconfirmed published target. */}}
    }
    private static Identity identity(Path file,boolean directory)throws IOException {
        exact(file);BasicFileAttributes attrs=Files.readAttributes(file,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
        if(attrs.isDirectory()!=directory||(!directory&&!attrs.isRegularFile()))throw new IOException("Native export requires an identifiable regular file/directory: "+file);
        Object key=attrs.fileKey();
        if(key==null&&System.getProperty("os.name").startsWith("Windows"))key=windowsKey(file);
        if(key==null)throw new IOException("Native export filesystem supplies no stable file identity");
        exact(file);if(!same(attrs,Files.readAttributes(file,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS)))throw new IOException("Native export filesystem identity changed while reading: "+file);
        return new Identity(key,attrs.creationTime(),directory);
    }
    private static String windowsKey(Path file)throws IOException {
        // Installed JDK Windows BasicFileAttributes has null fileKey. Read the volume and
        // 128-bit file ID from an OS handle instead, without following a final reparse point.
        Kernel32 kernel=Kernel32.INSTANCE;
        WinNT.HANDLE handle=kernel.CreateFile(file.toString(),0,WinNT.FILE_SHARE_READ|WinNT.FILE_SHARE_WRITE|WinNT.FILE_SHARE_DELETE,null,WinNT.OPEN_EXISTING,WinNT.FILE_FLAG_BACKUP_SEMANTICS|WinNT.FILE_FLAG_OPEN_REPARSE_POINT,null);
        if(WinBase.INVALID_HANDLE_VALUE.equals(handle))throw new IOException("Cannot pin native export file identity; Windows error "+kernel.GetLastError());
        try{
            WinBase.FILE_ID_INFO info=new WinBase.FILE_ID_INFO();
            if(!kernel.GetFileInformationByHandleEx(handle,WinBase.FileIdInfo,info.getPointer(),new WinDef.DWORD(info.size())))throw new IOException("Cannot read native export file identity; Windows error "+kernel.GetLastError());
            info.read();return Long.toUnsignedString(info.VolumeSerialNumber,16)+":"+HexFormat.of().formatHex(info.getPointer().getByteArray(8,16));
        }finally{kernel.CloseHandle(handle);}
    }
    private static void check(Path file,Identity expected)throws IOException {
        if(!expected.equals(identity(file,expected.directory())))throw new IOException("Native export filesystem identity changed: "+file);
    }
    private static void check(Map<Path,Identity> directories)throws IOException {for(var entry:directories.entrySet())check(entry.getKey(),entry.getValue());}
    private static void exact(Path expected)throws IOException {
        if(Files.isSymbolicLink(expected)||!expected.toRealPath().equals(expected))throw new IOException("Native export rejects links/junctions or changed canonical paths");
    }
    private static Map<Path,Evidence> scan(Path root,long maxBytes,int maxEntries)throws Exception {
        Map<Path,Evidence> evidence=new LinkedHashMap<>();Deque<Pending> pending=new ArrayDeque<>();pending.push(new Pending(root,0));long total=0;
        while(!pending.isEmpty()) {
            if(Thread.currentThread().isInterrupted())throw new IOException("Native export interrupted");
            Pending current=pending.pop();Path file=current.path();exact(file);
            if(!file.startsWith(root)||current.depth()>MAX_DEPTH||evidence.size()>=maxEntries)throw new IOException("Source depth/entry count exceeds export bound");
            BasicFileAttributes attrs=Files.readAttributes(file,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
            if(!attrs.isDirectory()&&!attrs.isRegularFile())throw new IOException("Unsupported saved workflow filesystem resource");
            Identity sourceIdentity=identity(file,attrs.isDirectory());
            if(attrs.isRegularFile()){if(attrs.size()>maxBytes-total)throw new IOException("Source bytes exceed export bound");total+=attrs.size();}
            String sha=attrs.isDirectory()?emptyHash():hashFile(file,attrs.size());
            BasicFileAttributes after=Files.readAttributes(file,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);exact(file);
            if(!same(attrs,after))throw new IOException("Source resource changed during hashing");check(file,sourceIdentity);
            evidence.put(file,new Evidence(attrs.isDirectory(),attrs.isDirectory()?0:attrs.size(),String.valueOf(sourceIdentity.key()),attrs.creationTime().toMillis(),attrs.lastModifiedTime().toMillis(),sha));
            if(attrs.isDirectory())try(DirectoryStream<Path> children=Files.newDirectoryStream(file)){for(Path child:children){if(pending.size()+evidence.size()>=maxEntries)throw new IOException("Source entry count exceeds export bound");pending.push(new Pending(child,current.depth()+1));}}
        }
        return evidence;
    }
    private static boolean same(BasicFileAttributes a,BasicFileAttributes b){return a.isDirectory()==b.isDirectory()&&a.size()==b.size()&&Objects.equals(a.fileKey(),b.fileKey())&&a.lastModifiedTime().equals(b.lastModifiedTime())&&a.creationTime().equals(b.creationTime());}
    private static String hashFile(Path file,long expectedBytes)throws Exception {
        // Loaded KNIME roots exclusively lock an empty .knimeLock beyond EOF on Windows.
        // The installed native exporter also emits empty entries without reading them.
        // There are no bytes to hash; surrounding scans still verify size, timestamps and identity.
        if(expectedBytes==0){if(Files.size(file)!=0)throw new IOException("Source resource changed during hashing");return emptyHash();}
        MessageDigest hash=MessageDigest.getInstance("SHA-256");long read=0;byte[] buffer=new byte[65536];
        try(InputStream stream=Files.newInputStream(file,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS)){for(int n;(n=stream.read(buffer))!=-1;){if(Thread.currentThread().isInterrupted())throw new IOException("Native export interrupted");read+=n;if(read>expectedBytes)throw new IOException("Source resource grew during hashing");hash.update(buffer,0,n);}}
        if(read!=expectedBytes)throw new IOException("Source resource changed during hashing");return HexFormat.of().formatHex(hash.digest());
    }
    private static String emptyHash()throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest());}
    private static void validName(String name,String root)throws IOException {
        if(name.isEmpty()||name.length()>4096||name.startsWith("/")||name.contains("\\")||name.contains(":"))throw new IOException("Invalid native archive entry name or length bound");
        String trimmed=name.endsWith("/")?name.substring(0,name.length()-1):name;String[] parts=trimmed.split("/",-1);
        if(!parts[0].equals(root)||parts.length>MAX_DEPTH+1)throw new IOException("Native archive entry is outside its single root");
        for(String part:parts)if(part.isEmpty()||part.equals(".")||part.equals(".."))throw new IOException("Invalid native archive entry component");
    }
    private static Archive verify(Path archive,Map<String,Evidence> expected,long maxBytes,int maxEntries)throws Exception {
        BasicFileAttributes before=Files.readAttributes(archive,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);if(before.size()>maxBytes)throw new IOException("Native archive exceeds byte bound");
        ArrayNode manifest=BridgeActivator.JSON.createArrayNode();Set<String> seen=new HashSet<>();long total=0,manifestBytes=2;int files=0;byte[] buffer=new byte[65536];
        try(ZipFile zip=new ZipFile(archive.toFile())) {
            var entries=zip.entries();while(entries.hasMoreElements()) {
                ZipEntry entry=entries.nextElement();String name=entry.getName();Evidence evidence=expected.get(name);
                if(seen.size()>=maxEntries||!seen.add(name)||evidence==null||entry.isDirectory()!=evidence.directory())throw new IOException("Native archive entry set/type differs from collected source");
                MessageDigest hash=MessageDigest.getInstance("SHA-256");long count=0;
                try(InputStream input=zip.getInputStream(entry)){for(int n;(n=input.read(buffer))!=-1;){count+=n;total+=n;if(total>maxBytes||count>evidence.size())throw new IOException("Native archive decompression exceeds source bound");hash.update(buffer,0,n);}}
                String digest=HexFormat.of().formatHex(hash.digest());if(count!=evidence.size()||!digest.equals(evidence.sha256()))throw new IOException("Native archive entry SHA-256 differs from verified saved source");
                if(!entry.isDirectory())files++;ObjectNode item=manifest.addObject().put("name",name).put("directory",entry.isDirectory()).put("bytes",count).put("sha256",digest);
                item.putObject("sourceMetadata").put("fileKey",evidence.key()).put("createdMillis",evidence.created()).put("lastModifiedMillis",evidence.modified()).put("sha256",evidence.sha256()).put("recheckedAfterExport",true);
                manifestBytes+=item.toString().getBytes(StandardCharsets.UTF_8).length+1;if(manifestBytes>16L*1024*1024)throw new IOException("Complete native export manifest exceeds 16 MiB bound");
            }
        }
        if(!seen.equals(expected.keySet()))throw new IOException("Native archive is missing collected resources");
        String sha=hashFile(archive,before.size());if(!same(before,Files.readAttributes(archive,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS)))throw new IOException("Native archive changed during verification");
        return new Archive(manifest,sha,before.size(),files,total);
    }
}

