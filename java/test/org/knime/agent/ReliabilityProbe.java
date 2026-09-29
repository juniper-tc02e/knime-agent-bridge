package org.knime.agent;
import java.io.*;
import java.nio.file.*;
import java.util.*;
public final class ReliabilityProbe {
 public static void main(String[] args)throws Exception {
  Path file=Path.of(args[0]).resolve("session.json");BridgeActivator.atomicWrite(file,BridgeActivator.JSON.createObjectNode().put("generation",1));
  String escaped=file.toString().replace("'","''");
  Process locker=new ProcessBuilder("powershell.exe","-NoProfile","-NonInteractive","-Command","$f=[System.IO.File]::Open('"+escaped+"',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); Write-Output 'LOCKED'; [Console]::ReadLine() | Out-Null; $f.Dispose()").redirectError(ProcessBuilder.Redirect.INHERIT).start();
  var reader=new BufferedReader(new InputStreamReader(locker.getInputStream()));if(!"LOCKED".equals(reader.readLine()))throw new AssertionError("Failed to acquire Windows sharing lock");
  Thread release=new Thread(()->{try{Thread.sleep(250);locker.getOutputStream().write('\n');locker.getOutputStream().flush();}catch(Exception e){throw new RuntimeException(e);}});release.start();
  try{BridgeActivator.atomicWrite(file,BridgeActivator.JSON.createObjectNode().put("generation",2));}
  finally{release.join();locker.waitFor();}
  if(BridgeActivator.JSON.readTree(Files.readAllBytes(file)).path("generation").asInt()!=2)throw new AssertionError("Metadata update lost");
  try(var entries=Files.list(file.getParent())){if(entries.anyMatch(p->p.getFileName().toString().endsWith(".tmp")))throw new AssertionError("Temporary file leaked");}
  OperationAccess operations=new OperationAccess(Path.of(args[0]),"test-session");String id=UUID.randomUUID().toString();
  var request=BridgeActivator.JSON.createObjectNode().put("operation","layout.apply");request.putObject("args");
  var receipt=operations.accept(id,request,null);Path aggregate=file.getParent().resolve("operations").resolve(id+".json");
  Process journalLock=new ProcessBuilder("powershell.exe","-NoProfile","-NonInteractive","-Command","$f=[System.IO.File]::Open('"+aggregate.toString().replace("'","''")+"',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None); Write-Output 'LOCKED'; [Console]::ReadLine() | Out-Null; $f.Dispose()").start();
  if(!"LOCKED".equals(new BufferedReader(new InputStreamReader(journalLock.getInputStream())).readLine()))throw new AssertionError("Journal lock failed");
  try {
   operations.transition(receipt,"running");
   if(!operations.get(id).path("status").asText().equals("running"))throw new AssertionError("Durable event hidden by stale aggregate");
   if(operations.existing(id,request)==null)throw new AssertionError("Accepted operation could replay");
  } finally {journalLock.getOutputStream().write('\n');journalLock.getOutputStream().flush();journalLock.waitFor();}
  var detail=BridgeActivator.JSON.createObjectNode();
  BridgeActivator.preserveNativeResult(detail,BridgeActivator.JSON.createObjectNode().put("newNodeId","root:42"));
  if(!detail.path("nativeResult").path("newNodeId").asText().equals("root:42"))throw new AssertionError("Native result lost");
  detail.removeAll();BridgeActivator.preserveNativeResult(detail,BridgeActivator.JSON.createObjectNode().put("large","x".repeat(65536)));
  if(detail.has("nativeResult")||detail.path("nativeResultSha256").asText().length()!=64)throw new AssertionError("Large result not bounded");
  System.out.println("reliability-probe passed");
 }
}
