package org.knime.agent;
import java.nio.file.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import com.fasterxml.jackson.databind.node.*;

/** Real bridge scheduler/journal/filesystem; native and Eclipse boundaries are synthetic. */
public final class StageTelemetryHarness {
    static Path session;static BridgeActivator bridge;static ThreadPoolExecutor jobs;
    static ObjectNode object(){return BridgeActivator.JSON.createObjectNode();}
    static void field(String name,Object value)throws Exception{Field f=BridgeActivator.class.getDeclaredField(name);f.setAccessible(true);f.set(bridge,value);}
    static void submit(ObjectNode request)throws Exception {
        Path file=session.resolve("requests/"+request.path("id").asText()+".json");BridgeActivator.atomicWrite(file,request);
        Method process=BridgeActivator.class.getDeclaredMethod("process",Path.class);process.setAccessible(true);process.invoke(bridge,file);
    }
    static ObjectNode request(String operation){return object().put("id",UUID.randomUUID().toString()).put("operation",operation).set("args",object());}
    static ObjectNode mutation(String operation){ObjectNode r=request(operation);r.set("precondition",object().put("contextId","fixture").set("expected",object()));return r;}
    static ObjectNode response(String id)throws Exception {
        Path file=session.resolve("responses/"+id+".json");long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(!Files.isRegularFile(file)&&System.nanoTime()<end)Thread.onSpinWait();
        assert Files.isRegularFile(file):"response absent "+id;
        return (ObjectNode)BridgeActivator.JSON.readTree(Files.readAllBytes(file));
    }
    public static void main(String[] argv)throws Exception {
        session=Path.of(argv[0]).resolve("session");for(String name:List.of("requests","responses","inflight"))Files.createDirectories(session.resolve(name));
        bridge=new BridgeActivator();field("session",session);field("ready",true);field("contexts",new ContextAccess(object()));
        field("operations",new OperationAccess(session,"fixture-session"));field("canvas",new CanvasAccess(null,null));
        jobs=new ThreadPoolExecutor(1,1,0L,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(64));field("jobs",jobs);
        try {
            field("ready",false);ObjectNode starting=request("health");submit(starting);assert response(starting.path("id").asText()).path("result").path("status").asText().equals("starting");field("ready",true);
            ObjectNode cold=request("health");submit(cold);assert response(cold.path("id").asText()).path("ok").asBoolean();
            assert GatewayAccess.initializations==0:"health initialized gateway on safe path";
            ObjectNode blocked=request("core.snapshot");submit(blocked);assert CoreAccess.entered.await(2,TimeUnit.SECONDS);
            ObjectNode edit=mutation("core.reset");submit(edit);ObjectNode cancel=mutation("core.cancel");submit(cancel);
            ObjectNode health=request("health");submit(health);ObjectNode h=response(health.path("id").asText());
            assert h.path("ok").asBoolean();
            assert h.path("result").path("descriptorOnly").asBoolean():"health incorrectly implies worker/UI proof";
            ObjectNode diagnostics=request("bridge.diagnostics");submit(diagnostics);ObjectNode d=response(diagnostics.path("id").asText());
            assert d.path("ok").asBoolean():d.toString();
            assert d.path("result").path("queue").path("depth").asInt()==2:d.toString();
            assert d.path("result").path("worker").path("requestId").asText().equals(blocked.path("id").asText());
            assert d.path("result").path("worker").path("phase").asText().equals("native_call");
            assert CoreAccess.effects==0:"queued mutation/cancel escaped serialized lane";
            ObjectNode lookup=request("operation.get");lookup.set("args",object().put("operationId",cancel.path("id").asText()));submit(lookup);
            ObjectNode receipt=response(lookup.path("id").asText()).path("result").deepCopy();
            assert receipt.path("status").asText().equals("queued") && receipt.path("nativeDispatch").asText().equals("not_started");
            assert receipt.path("cancellation").path("state").asText().equals("queued"):receipt.toString();
            assert !receipt.path("cancellation").path("acknowledged").asBoolean();
            // Original UUID redelivery must not create another queued mutation.
            submit(edit.deepCopy());assert response(edit.path("id").asText()).path("result").path("deduplicated").asBoolean();
            ObjectNode countCheck=request("bridge.diagnostics");submit(countCheck);ObjectNode counts=response(countCheck.path("id").asText()).path("result").path("counters").deepCopy();
            assert counts.path("claims").asLong()==10 && counts.path("requestReads").asLong()==10:"duplicate delivery disappeared from IO counts: "+counts;
            Files.delete(session.resolve("responses/"+edit.path("id").asText()+".json"));
            CoreAccess.release.countDown();response(blocked.path("id").asText());ObjectNode e=response(edit.path("id").asText()),c=response(cancel.path("id").asText());
            assert CoreAccess.effects==2:"not exactly one edit and cancellation request";
            assert e.path("telemetry").path("durationsMs").path("queueWait").asDouble()>0;
            assert e.path("telemetry").path("durationsMs").path("resultSerialization").isNumber():"result conversion boundary is unmeasured";
            assert c.path("receipt").path("cancellation").path("state").asText().equals("acknowledged");
            assert !c.path("receipt").path("completionVerified").asBoolean():"cancel ack became terminal cancellation";
            // Journal failure follows native primary failure and cannot replace it.
            ObjectNode failing=mutation("core.reset");failing.set("args",object().put("fail",true).put("obstructJournal",true));submit(failing);
            ObjectNode failure=response(failing.path("id").asText());
            assert failure.path("error").path("message").asText().equals("synthetic primary failure"):failure.toString();
            assert failure.path("error").path("details").path("secondaryErrors").size()>0:failure.toString();
            ObjectNode compound=mutation("core.reset");compound.set("args",object().put("fail",true).put("obstructJournal",true));
            Path compoundResponse=session.resolve("responses/"+compound.path("id").asText()+".json");Files.createDirectory(compoundResponse);Files.writeString(compoundResponse.resolve("obstruction"),"x");submit(compound);
            long compoundEnd=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(!jobs.getQueue().isEmpty()||jobs.getActiveCount()!=0){assert System.nanoTime()<compoundEnd;Thread.onSpinWait();}
            ObjectNode recover=request("operation.get");recover.set("args",object().put("operationId",compound.path("id").asText()));submit(recover);ObjectNode recovered=response(recover.path("id").asText());
            assert recovered.path("result").path("outcomeRecovery").path("primaryError").path("message").asText().equals("synthetic primary failure"):recovered.toString();
            assert !recovered.path("result").path("outcomeRecovery").path("durable").asBoolean();
            assert recovered.path("result").path("outcomeRecovery").path("publication").path("state").asText().equals("failed"):recovered.toString();
            // A response-path obstruction cannot erase a durable one-effect receipt.
            ObjectNode obstruction=mutation("core.reset");Path target=session.resolve("responses/"+obstruction.path("id").asText()+".json");Files.createDirectory(target);Files.writeString(target.resolve("lock"),"obstruction");
            submit(obstruction);long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(!jobs.getQueue().isEmpty()||jobs.getActiveCount()!=0){assert System.nanoTime()<end;Thread.onSpinWait();}
            ObjectNode pub=request("operation.get");pub.set("args",object().put("operationId",obstruction.path("id").asText()));submit(pub);ObjectNode published=response(pub.path("id").asText());
            assert published.path("result").path("status").asText().equals("applied");
            assert published.path("result").path("publication").path("state").asText().equals("failed"):published.toString();
            assert published.path("result").path("nativeOutcome").asText().equals("returned_successfully");
            assert Files.isRegularFile(session.resolve("inflight/"+obstruction.path("id").asText()+".json"));
            int before=CoreAccess.effects;submit(obstruction.deepCopy());assert CoreAccess.effects==before;
            CoreAccess.entered=new CountDownLatch(1);CoreAccess.release=new CountDownLatch(1);
            ObjectNode blockAgain=request("core.snapshot");submit(blockAgain);assert CoreAccess.entered.await(2,TimeUnit.SECONDS);
            ObjectNode expiring=mutation("core.reset");expiring.put("expiresAt",java.time.Instant.now().plusMillis(200).toString());submit(expiring);
            for(int i=0;i<63;i++)submit(request("core.snapshot"));
            ObjectNode overflow=mutation("core.reset");submit(overflow);ObjectNode rejected=response(overflow.path("id").asText());
            assert !rejected.path("ok").asBoolean();assert rejected.path("receipt").path("status").asText().equals("failed"):rejected.toString();
            assert rejected.path("receipt").path("nativeDispatch").asText().equals("not_started");
            while(java.time.Instant.now().isBefore(java.time.Instant.parse(expiring.path("expiresAt").asText())))Thread.onSpinWait();
            before=CoreAccess.effects;CoreAccess.release.countDown();ObjectNode expired=response(expiring.path("id").asText());
            assert expired.path("error").path("code").asText().equals("REQUEST_EXPIRED");assert expired.path("receipt").path("nativeDispatch").asText().equals("not_started");
            assert CoreAccess.effects==before:"queue expiry repeated a native effect";
            long drainEnd=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(!jobs.getQueue().isEmpty()||jobs.getActiveCount()!=0){assert System.nanoTime()<drainEnd;Thread.onSpinWait();}
            System.out.println("production dispatch telemetry verified (synthetic native/Eclipse boundaries; no live KNIME performance claim)");
        } finally {CoreAccess.release.countDown();jobs.shutdownNow();}
    }
}
