package org.knime.agent;
import java.nio.file.*;
import java.lang.reflect.*;
import java.lang.management.ManagementFactory;
import java.util.*;
import java.util.concurrent.*;
import com.fasterxml.jackson.databind.node.*;

/** Shared baseline/changed requests; no UI, lock, external-node or host performance claim. */
public final class StageLatencyHarness {
    static Path session;static BridgeActivator bridge;static Method process;
    static ObjectNode object(){return BridgeActivator.JSON.createObjectNode();}
    static ObjectNode request(String op){return object().put("id",UUID.randomUUID().toString()).put("operation",op).set("args",object());}
    static void field(String name,Object value)throws Exception{Field f=BridgeActivator.class.getDeclaredField(name);f.setAccessible(true);f.set(bridge,value);}
    static ObjectNode submit(ObjectNode request)throws Exception {
        String id=request.path("id").asText();Path file=session.resolve("requests/"+id+".json");BridgeActivator.atomicWrite(file,request);process.invoke(bridge,file);
        Path result=session.resolve("responses/"+id+".json");return Files.isRegularFile(result)?(ObjectNode)BridgeActivator.JSON.readTree(Files.readAllBytes(result)):null;
    }
    static ObjectNode stats(List<Double> samples){var sorted=samples.stream().sorted().toList();return object().put("samples",samples.size()).put("p50Ms",sorted.get((int)Math.ceil(sorted.size()*.5)-1)).put("p95Ms",sorted.get((int)Math.ceil(sorted.size()*.95)-1)).put("maxMs",sorted.getLast());}
    public static void main(String[] argv)throws Exception {
        session=Path.of(argv[0]).resolve("benchmark-session");for(String name:List.of("requests","responses","inflight"))Files.createDirectories(session.resolve(name));
        bridge=new BridgeActivator();field("session",session);field("ready",true);field("contexts",new ContextAccess(object()));field("operations",new OperationAccess(session,"benchmark"));field("canvas",new CanvasAccess(null,null));
        ThreadPoolExecutor jobs=new ThreadPoolExecutor(1,1,0L,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(64));field("jobs",jobs);
        process=BridgeActivator.class.getDeclaredMethod("process",Path.class);process.setAccessible(true);
        long startCpu=ManagementFactory.getThreadMXBean().getCurrentThreadCpuTime();long startHeap=Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory();
        ObjectNode report=object().put("boundary","same-process filesystem submit/private production process/response read; native+Eclipse boundary stubs").put("liveKnime",false).put("pollingDelayIncluded",false);
        try {
            submit(request("core.snapshot"));assert CoreAccess.entered.await(2,TimeUnit.SECONDS);submit(request("core.snapshot"));
            ObjectNode cancel=request("core.cancel");cancel.set("precondition",object().put("contextId","fixture").set("expected",object()));submit(cancel);
            for(String op:List.of("health","operation.get")) {
                ArrayList<Double> samples=new ArrayList<>();long bytes=0;
                for(int i=0;i<25;i++) {
                    ObjectNode r=request(op);if(op.equals("operation.get"))r.set("args",object().put("operationId",cancel.path("id").asText()));
                    long start=System.nanoTime();ObjectNode result=submit(r);samples.add((System.nanoTime()-start)/1_000_000.0);
                    assert result!=null&&result.path("ok").asBoolean();bytes+=Files.size(session.resolve("responses/"+r.path("id").asText()+".json"));
                    if(op.equals("operation.get"))assert result.path("result").path("nativeDispatch").asText().equals("not_started");
                }
                report.set(op,stats(samples).put("responseBytes",bytes));
            }
            assert CoreAccess.effects==0:"cancellation escaped blocked serialized worker";
            CoreAccess.release.countDown();long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(!jobs.getQueue().isEmpty()||jobs.getActiveCount()!=0){assert System.nanoTime()<end;Thread.onSpinWait();}
            assert CoreAccess.effects==1;
            report.put("threadCpuMs",(ManagementFactory.getThreadMXBean().getCurrentThreadCpuTime()-startCpu)/1_000_000.0).put("heapBeforeBytes",startHeap).put("heapAfterBytes",Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory());
            BridgeActivator.atomicWrite(Path.of(argv[0]).resolve("measurements.json"),report);System.out.println(report);
        }finally{CoreAccess.release.countDown();jobs.shutdownNow();}
    }
}
