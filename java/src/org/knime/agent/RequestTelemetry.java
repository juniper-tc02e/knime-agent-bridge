package org.knime.agent;

import java.util.*;
import com.fasterxml.jackson.databind.node.*;

/** Bounded, payload-free observations. Every duration uses this process's monotonic clock. */
final class RequestTelemetry {
    private static final int LIMIT=256;
    private final LinkedHashMap<String,Entry> entries=new LinkedHashMap<>();
    private long claims,reads,bytesRead,bytesWritten,enqueued,started,published,publicationFailures;
    private Entry worker;
    private static final class Entry {
        final String id;final long claimed=System.nanoTime();String operation="unknown",phase="claimed",publication="not_attempted";
        long requestBytes,responseBytes,queuedAt,start,nativeStart,nativeEnd,resultSerializationStart,resultSerializationEnd,journalStart,journalEnd,publishStart,publishEnd,end;
        boolean queued;String publicationError;
        Entry(String id){this.id=id;}
    }
    synchronized boolean claim(String id) {
        claims++;
        // A duplicate delivery must not overwrite the original dispatch clock.
        if(entries.containsKey(id))return false;
        while(entries.size()>=LIMIT) {
            String removable=entries.values().stream().filter(e->e.end!=0).map(e->e.id).findFirst().orElse(entries.keySet().iterator().next());entries.remove(removable);
        }
        entries.put(id,new Entry(id));return true;
    }
    synchronized void read(String id,String operation,long bytes){Entry e=entries.get(id);if(e!=null&&e.phase.equals("claimed")){e.operation=operation.substring(0,Math.min(operation.length(),512));e.requestBytes=bytes;e.phase="validated";}reads++;bytesRead+=bytes;}
    synchronized void enqueue(String id){Entry e=entries.get(id);if(e!=null){e.queued=true;e.queuedAt=System.nanoTime();e.phase="queued";}}
    synchronized void admitted(){enqueued++;}
    synchronized void start(String id,boolean serialized){Entry e=entries.get(id);if(e!=null){e.start=System.nanoTime();e.queued=false;e.phase="guards";if(serialized)worker=e;}started++;}
    synchronized void phase(String id,String phase){Entry e=entries.get(id);if(e!=null)e.phase=phase;}
    synchronized void nativeStart(String id){Entry e=entries.get(id);if(e!=null){e.nativeStart=System.nanoTime();e.phase="native_call";}}
    synchronized void nativeEnd(String id){Entry e=entries.get(id);if(e!=null&&e.nativeStart!=0&&e.nativeEnd==0)e.nativeEnd=System.nanoTime();}
    synchronized void resultSerializationStart(String id){Entry e=entries.get(id);if(e!=null){e.resultSerializationStart=System.nanoTime();e.phase="result_serialization";}}
    synchronized void resultSerializationEnd(String id){Entry e=entries.get(id);if(e!=null)e.resultSerializationEnd=System.nanoTime();}
    synchronized void responseBytes(String id,long bytes){Entry e=entries.get(id);if(e!=null)e.responseBytes=bytes;}
    synchronized void journalStart(String id){Entry e=entries.get(id);if(e!=null){e.journalStart=System.nanoTime();e.phase="journal";}}
    synchronized void journalEnd(String id){Entry e=entries.get(id);if(e!=null)e.journalEnd=System.nanoTime();}
    synchronized void publishing(String id){Entry e=entries.get(id);if(e!=null){e.publishStart=System.nanoTime();e.phase="response_publication";e.publication="pending";}}
    synchronized void published(String id,Throwable error){Entry e=entries.get(id);if(e!=null){e.publishEnd=System.nanoTime();e.end=e.publishEnd;e.queued=false;e.phase=error==null?"response_published":"response_publication_failed";e.publication=error==null?"published":"failed";String message=error==null?null:error.getClass().getName()+": "+String.valueOf(error.getMessage());e.publicationError=message==null?null:message.substring(0,Math.min(message.length(),4096));if(error==null)bytesWritten+=e.responseBytes;}if(error==null)published++;else publicationFailures++;}
    synchronized void redeliveryPublished(long bytes,Throwable error){if(error==null){published++;bytesWritten+=bytes;}else publicationFailures++;}
    synchronized void workerDone(String id){if(worker!=null&&worker.id.equals(id)){worker.end=System.nanoTime();worker.phase=worker.publication.equals("published")?"response_published":"response_publication_failed";worker=null;}}
    synchronized ObjectNode request(String id){Entry e=entries.get(id);return e==null?BridgeActivator.JSON.createObjectNode().put("requestId",id).put("available",false):entry(e);}
    synchronized ObjectNode publication(String id){Entry e=entries.get(id);ObjectNode out=BridgeActivator.JSON.createObjectNode().put("state",e==null?"unknown":e.publication).put("source","process_telemetry");if(e!=null&&e.publicationError!=null)out.put("error",e.publicationError);return out;}
    synchronized ObjectNode snapshot() {
        long now=System.nanoTime();ObjectNode out=BridgeActivator.JSON.createObjectNode().put("clock","native_process_monotonic").put("descriptorOnly",true).put("uiResponsiveness","unmeasured").put("retainedRequests",entries.size()).put("requestLimit",LIMIT);
        out.putObject("counters").put("claims",claims).put("requestReads",reads).put("requestBytesRead",bytesRead).put("responseBytesWritten",bytesWritten).put("enqueued",enqueued).put("started",started).put("responsesPublished",published).put("responsePublicationFailures",publicationFailures);
        long oldest=entries.values().stream().filter(e->e.queued).mapToLong(e->e.queuedAt).min().orElse(0);
        out.putObject("queue").put("depth",entries.values().stream().filter(e->e.queued).count()).put("capacity",64).put("oldestAgeMs",oldest==0?0:ms(now-oldest));
        if(worker==null)out.putObject("worker").put("state","idle");else out.set("worker",entry(worker).put("state","busy"));
        out.putObject("control").put("safeReads","health, operation.get, bridge.diagnostics").put("cancellationDispatch","serialized_native_lane").put("parallelNativeCalls",false);
        out.putArray("unmeasuredStages").add("KNIME lock wait within native call").add("SWT/UI work").add("external node work").add("host rendering");
        return out;
    }
    private ObjectNode entry(Entry e) {
        long now=System.nanoTime();ObjectNode out=BridgeActivator.JSON.createObjectNode().put("requestId",e.id).put("operation",e.operation).put("phase",e.phase).put("requestBytes",e.requestBytes).put("responseBytes",e.responseBytes).put("clock","native_process_monotonic").put("elapsedMs",ms((e.end==0?now:e.end)-e.claimed));
        ObjectNode durations=out.putObject("durationsMs");duration(durations,"queueWait",e.queuedAt,e.start,now);duration(durations,"nativeCall",e.nativeStart,e.nativeEnd,now);duration(durations,"resultSerialization",e.resultSerializationStart,e.resultSerializationEnd,now);duration(durations,"journal",e.journalStart,e.journalEnd,now);duration(durations,"responsePublication",e.publishStart,e.publishEnd,now);
        out.putObject("publication").put("state",e.publication).put("completionObserved",e.publishEnd!=0);return out;
    }
    private static void duration(ObjectNode out,String key,long from,long to,long now){if(from==0)out.putNull(key);else out.put(key,ms((to==0?now:to)-from));}
    private static double ms(long nanos){return nanos/1_000_000.0;}
}
