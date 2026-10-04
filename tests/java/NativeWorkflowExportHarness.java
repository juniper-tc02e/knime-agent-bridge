package org.knime.agent;

import java.nio.file.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.function.BiConsumer;
import java.io.UncheckedIOException;
import java.nio.channels.FileChannel;
import org.knime.core.node.workflow.WorkflowExporter;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Real installed KNIME exporter and production helper; no KNIME process or model mutations. */
public final class NativeWorkflowExportHarness {
    public static void main(String[] args)throws Exception {
        Class<?> helper;
        try{helper=Class.forName("org.knime.agent.NativeWorkflowExport");}
        catch(ClassNotFoundException missing){throw new AssertionError("Missing production native workflow export feature",missing);}
        Path scratch=Path.of(args[0]),source=scratch.resolve("源 workflow"),runtime=scratch.resolve("runtime");
        Files.createDirectories(source.resolve("data"));Files.createDirectories(runtime);
        Files.writeString(source.resolve("workflow.knime"),"<config key=\"workflow.knime\"><entry key=\"name\" type=\"xstring\" value=\"中英 🚀\"/></config>");
        Files.writeString(source.resolve("data/Unicode.txt"),"中英 · → 🚀\n");
        Method export=helper.getDeclaredMethod("exportSaved",Path.class,Path.class,boolean.class,long.class,int.class);export.setAccessible(true);
        ObjectNode result=(ObjectNode)export.invoke(null,source,runtime,false,1024L*1024,100);
        assert result.path("nativeExporter").asText().equals("org.knime.core.node.workflow.WorkflowExporter"):result;
        assert result.path("manifestComplete").asBoolean() && result.path("fileCount").asInt()==2:result;
        assert result.path("manifest").isArray() && result.path("manifest").size()>=2:result;
        Path archive=Path.of(result.path("path").asText());assert archive.startsWith(runtime.resolve("exports"));
        assert archive.getFileName().toString().matches("[0-9a-f-]{36}\\.knwf");assert Files.isRegularFile(archive);
        ObjectNode second=(ObjectNode)export.invoke(null,source,runtime,false,1024L*1024,100);assert !second.path("path").asText().equals(result.path("path").asText());
        // Loaded KNIME roots keep a zero-byte .knimeLock exclusively locked beyond EOF.
        // The installed exporter creates an empty ZIP entry without reading that handle.
        Path lockFile=source.resolve(".knimeLock");
        try(FileChannel channel=FileChannel.open(lockFile,StandardOpenOption.CREATE_NEW,StandardOpenOption.READ,StandardOpenOption.WRITE);var lock=channel.lock()){
            var nativeExporter=new WorkflowExporter<java.io.IOException>(false);
            var resources=nativeExporter.collectResourcesToCopy(List.of(source),source.getParent());
            assert resources.paths().containsKey(lockFile):"Installed exporter contract omitted the lock fixture";
            try(var nativeBytes=new java.io.ByteArrayOutputStream()){nativeExporter.exportInto(resources,nativeBytes,progress->{});assert nativeBytes.size()>0;}
            ObjectNode locked=(ObjectNode)export.invoke(null,source,runtime,false,1024L*1024,100);
            var lockEntry=locked.path("manifest").findValues("name").stream().anyMatch(n->n.asText().endsWith("/.knimeLock"));
            assert lockEntry:"Complete native manifest must include its empty lock entry";
            assert Files.size(lockFile)==0 && lock.isValid():"Export modified or unlocked KNIME's lock file";
        }
        Files.delete(lockFile);
        Path lockedData=source.resolve("data/locked-data.bin");Files.writeString(lockedData,"real nonempty selected resource");
        try(FileChannel channel=FileChannel.open(lockedData,StandardOpenOption.READ,StandardOpenOption.WRITE);var lock=channel.lock()){
            if(System.getProperty("os.name").startsWith("Windows")){
                try{export.invoke(null,source,runtime,false,1024L*1024,100);throw new AssertionError("Nonempty locked content was silently accepted");}
                catch(InvocationTargetException expected){assert expected.getCause() instanceof java.io.IOException:expected.getCause();assert expected.getCause().getMessage().contains("locked"):expected.getCause();}
                assert lock.isValid() && Files.size(lockedData)>0:"Failure modified or unlocked selected data";
            }
        }
        Files.delete(lockedData);
        try{export.invoke(null,source,runtime,false,10L,100);throw new AssertionError("Source byte limit did not reject export");}catch(InvocationTargetException expected){assert expected.getCause().getMessage().contains("bound"):expected.getCause();}
        long sourceBytes=Files.size(source.resolve("workflow.knime"))+Files.size(source.resolve("data/Unicode.txt"));
        try{export.invoke(null,source,runtime,false,sourceBytes,100);throw new AssertionError("Archive overhead must obey its output byte limit");}catch(InvocationTargetException expected){assert expected.getCause().getMessage().contains("output")&&expected.getCause().getMessage().contains("bound"):expected.getCause();}
        try{export.invoke(null,source,runtime,false,1024L*1024,1);throw new AssertionError("Entry limit did not reject export");}catch(InvocationTargetException expected){assert expected.getCause().getMessage().contains("bound"):expected.getCause();}
        Files.writeString(source.resolve("model_cached"),"synthetic cached model bytes");
        ObjectNode without=(ObjectNode)export.invoke(null,source,runtime,true,1024L*1024,100);
        for(var entry:without.path("manifest"))assert !entry.path("name").asText().endsWith("model_cached"):"excludeData did not use native resource selection";
        Path outside=scratch.resolve("outside");Files.createDirectories(outside);Files.writeString(outside.resolve("private.txt"),"synthetic outside bytes");
        if(System.getProperty("os.name").startsWith("Windows")){
            Process junction=new ProcessBuilder("cmd.exe","/c","mklink","/J",source.resolve("escape").toString(),outside.toString()).redirectErrorStream(true).start();
            assert junction.waitFor()==0:new String(junction.getInputStream().readAllBytes());
            try{export.invoke(null,source,runtime,false,1024L*1024,100);throw new AssertionError("Junction export was not rejected");}catch(InvocationTargetException expected){assert expected.getCause().getMessage().contains("canonical")||expected.getCause().getMessage().contains("link"):expected.getCause();}
            Files.delete(source.resolve("escape"));
        }
        try(var files=Files.list(runtime.resolve("exports"))){assert files.noneMatch(p->p.getFileName().toString().endsWith(".tmp")):"Owned temporary export leaked";}
        Method raced=helper.getDeclaredMethod("exportSaved",Path.class,Path.class,boolean.class,long.class,int.class,BiConsumer.class);raced.setAccessible(true);
        for(String race:List.of("exports-directory","runtime-directory","temp-replacement","temp-content","published-replacement")){
            Path isolated=scratch.resolve("race-"+race);Files.createDirectories(isolated);Path[] foreign={null};
            BiConsumer<String,Path> replace=(phase,file)->{
                boolean directory=race.endsWith("directory"),published=race.equals("published-replacement");
                if(!(directory?phase.equals("after_collection"):published?phase.equals("after_publish"):phase.equals("after_archive_verified")))return;
                try{
                    if(directory){Path victim=race.equals("runtime-directory")?isolated:file;Files.move(victim,victim.resolveSibling(victim.getFileName()+"-original"));Files.createDirectories(victim);foreign[0]=victim.resolve("foreign.txt");Files.writeString(foreign[0],"foreign directory content");}
                    else if(race.equals("temp-content")){Files.writeString(file,"changed same-file content");}
                    else {Files.move(file,file.resolveSibling(file.getFileName()+"-original"));Files.writeString(file,"foreign replacement bytes");foreign[0]=file;}
                }catch(java.io.IOException e){throw new UncheckedIOException(e);}
            };
            try{raced.invoke(null,source,isolated,false,1024L*1024,100,replace);throw new AssertionError("Filesystem replacement was accepted: "+race);}
            catch(InvocationTargetException rejected){assert rejected.getCause() instanceof java.io.IOException:rejected.getCause();assert rejected.getCause().getMessage().contains("identity")||rejected.getCause().getMessage().contains("changed"):rejected.getCause();}
            if(foreign[0]!=null)assert Files.readString(foreign[0]).startsWith("foreign"):"Cleanup deleted/replaced foreign resource: "+race;
        }
        System.out.println("actual installed exporter: immutable UUID archives, complete SHA manifest, source bounds, junction rejection and directory/temp/publication replacement rejection verified");
    }
}
