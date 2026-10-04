package org.knime.agent;

import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.osgi.framework.*;
import org.eclipse.core.runtime.Platform;
import org.knime.ui.java.api.DesktopAPI;
import org.eclipse.ui.PlatformUI;

/** A local, per-process command queue. No sockets, account tokens, or remote services. */
public final class BridgeActivator implements BundleActivator {
    static final ObjectMapper JSON = new ObjectMapper().enable(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
    static final String VERSION = "0.5.0";
    private final String id = UUID.randomUUID().toString();
    private final String startedAt = Instant.now().toString();
    private ScheduledExecutorService heartbeat;
    private ScheduledExecutorService requests;
    private Path session;
    private ThreadPoolExecutor jobs;
    private ContextAccess contexts;
    private CanvasAccess canvas;
    private OperationAccess operations;
    private String bundleFingerprint="unavailable",capabilityFingerprint="unavailable";
    private GatewayAccess gateway;
    private final RequestTelemetry telemetry=new RequestTelemetry();
    private volatile boolean ready;
    private volatile String problem;

    @Override public void start(BundleContext context) throws Exception {
        String root=System.getProperty("knime.agent.runtime");
        if(root==null || root.isBlank()) root=Path.of(System.getProperty("user.home"),".knime-agent","runtime").toString();
        session=Path.of(root).toAbsolutePath().resolve("sessions").resolve(id);
        Files.createDirectories(session.resolve("requests"));
        Files.createDirectories(session.resolve("responses"));
        Files.createDirectories(session.resolve("inflight"));
        try {
            Path loaded=org.eclipse.core.runtime.FileLocator.getBundleFileLocation(context.getBundle()).orElseThrow().toPath();
            if(!Files.isRegularFile(loaded))throw new IllegalStateException("Running bridge bundle is not a JAR");
            bundleFingerprint=RevisionTracker.bytesDigest(Files.readAllBytes(loaded));
        } catch(Exception e) {problem="Loaded JAR fingerprint unavailable: "+e.getClass().getSimpleName()+"; bundle="+context.getBundle().getLocation();}
        capabilityFingerprint=RevisionTracker.digest(JSON.valueToTree(Map.of("version",VERSION,"policies",OperationPolicy.coverage(),"canvas",CanvasAccess.capabilities())));
        contexts=new ContextAccess(metadata("starting"));
        operations=new OperationAccess(session,id);canvas=new CanvasAccess(contexts,new ArtifactStore(session));
        jobs=new ThreadPoolExecutor(1,1,0L,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(64),r->{Thread t=new Thread(r,"knime-agent-native-jobs");t.setDaemon(true);return t;});
        heartbeat=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"knime-agent-heartbeat");t.setDaemon(true);return t;});
        requests=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"knime-agent-commands");t.setDaemon(true);return t;});
        heartbeat.scheduleWithFixedDelay(()->{
            try { ready=PlatformUI.isWorkbenchRunning() && DesktopAPI.areDependenciesInjected(); writeMetadata(ready?"ready":"starting"); }
            catch(Throwable e) {problem=e.toString(); log(e);}
        },0,2,TimeUnit.SECONDS);
        requests.scheduleWithFixedDelay(this::poll,0,50,TimeUnit.MILLISECONDS);
    }

    private ObjectNode metadata(String status) {
        ObjectNode m=JSON.createObjectNode();
        m.put("id",id);m.put("pid",ProcessHandle.current().pid());m.put("bridgeVersion",VERSION);
        m.put("bundleFingerprint",bundleFingerprint).put("capabilityFingerprint",capabilityFingerprint);
        m.set("operationPolicies",OperationPolicy.coverage());m.set("canvasCapabilities",JSON.valueToTree(CanvasAccess.capabilities()));
        Bundle core=Platform.getBundle("org.knime.core");
        m.put("knimeVersion",core==null?"unknown":core.getVersion().toString());
        m.put("workspace",Platform.getInstanceLocation().getURL().toString());
        m.put("startedAt",startedAt);m.put("heartbeat",Instant.now().toString());m.put("status",status);
        m.put("workbenchRunning",PlatformUI.isWorkbenchRunning());m.put("modernUiReady",ready);
        m.put("descriptorOnly",true).put("uiResponsiveness","unmeasured");
        m.set("diagnostics",telemetry.snapshot());
        m.set("services",JSON.valueToTree(GatewayAccess.SERVICES));
        if(problem!=null)m.put("lastProblem",problem);
        return m;
    }
    private void writeMetadata(String status)throws Exception {atomicWrite(session.resolve("session.json"),metadata(status));}
    static void atomicWrite(Path path,JsonNode value)throws Exception {
        AtomicFiles.write(path,JSON.writeValueAsBytes(value));
    }
    private void poll() {
        try(var files=Files.list(session.resolve("requests"))) {
            for(Path req:files.filter(p->p.getFileName().toString().matches("[0-9a-fA-F-]{36}\\.json")).sorted().toList()) process(req);
        } catch(Throwable e){problem=e.toString();log(e);}
    }
    private void process(Path path) {
        String requestId=path.getFileName().toString().replace(".json","");
        Path claimed=session.resolve("inflight").resolve(path.getFileName());
        try {Files.move(path,claimed,StandardCopyOption.ATOMIC_MOVE);}
        catch(Exception e){problem=e.toString();log(e);return;}
        boolean originalTelemetry=telemetry.claim(requestId);
        ObjectNode response=JSON.createObjectNode().put("id",requestId);
        ObjectNode acceptedReceipt=null;
        try {
            if(Files.size(claimed)>16*1024*1024)throw new IllegalArgumentException("Request exceeds 16 MiB");
            JsonNode request=JSON.readTree(Files.readAllBytes(claimed));
            if(!requestId.equals(request.path("id").asText()))throw new IllegalArgumentException("Request id does not match filename");
            String operation=request.path("operation").asText();JsonNode args=request.path("args");
            telemetry.read(requestId,operation,Files.size(claimed));
            if(!args.isObject())throw new IllegalArgumentException("args must be an object");
            if(!ready&&!safeRead(operation))throw new ContextAccess.Conflict("NATIVE_NOT_READY","Native dependencies are not ready; no operation was dispatched");
            boolean tracked=!safeRead(operation)&&(OperationPolicy.mutation(operation,args)||operation.equals("canvas.preview")||operation.equals("canvas.viewport"));
            if(tracked) {
                ObjectNode previous=operations.existing(requestId,request);
                if(previous!=null){response.put("ok",true);response.set("receipt",previous);response.set("result",JSON.createObjectNode().put("deduplicated",true).set("receipt",previous));publish(claimed,response,false);return;}
            }
            if(request.hasNonNull("expiresAt")&&Instant.parse(request.get("expiresAt").asText()).isBefore(Instant.now()))throw new ContextAccess.Conflict("REQUEST_EXPIRED","Request expired before execution; no operation was performed");
            // Preserve strict malformed-target failures before any project/context resolution.
            if(operation.startsWith("core."))CoreAccess.validateArguments(operation,cleanArgs(args));
            ObjectNode receipt=tracked?operations.accept(requestId,request,null):null;acceptedReceipt=receipt;
            if(safeRead(operation))executeControl(claimed,request,response);
            else try {telemetry.enqueue(requestId);jobs.execute(()->execute(claimed,request,response,receipt));telemetry.admitted();}
            catch(RejectedExecutionException e){throw new IllegalStateException("Native job queue is full (64); request not dispatched",e);}
            return;
        }catch(Throwable e){error(response,e);((ObjectNode)response.path("error").path("details")).put("nativeDispatch","not_started");
            if(acceptedReceipt!=null)try{operations.finish(acceptedReceipt,response,null);}catch(Exception journal){
                ObjectNode details=(ObjectNode)response.path("error").path("details");secondary(details,"outcome_journal",journal);details.put("journalStatus","outcome_not_persisted");
                response.set("receipt",acceptedReceipt.deepCopy().put("journalStatus","outcome_not_persisted"));operations.rememberUnpersisted(acceptedReceipt,response,journal);
            }
        }
        publish(claimed,response,originalTelemetry);
    }
    private static boolean safeRead(String operation){return Set.of("health","operation.get","bridge.diagnostics").contains(operation);}
    private void executeControl(Path claimed,JsonNode request,ObjectNode response) {
        String requestId=response.path("id").asText();telemetry.start(requestId,false);telemetry.phase(requestId,"control_read");
        try {
            ObjectNode result=switch(request.path("operation").asText()) {
                case "health" -> metadata(ready?"ready":"starting");
                case "bridge.diagnostics" -> diagnostics(request.path("args"));
                case "operation.get" -> {
                    String operationId=NativeTarget.required(request.path("args"),"operationId");ObjectNode receipt=operations.get(operationId);
                    ObjectNode observed=telemetry.publication(operationId);if(!observed.path("state").asText().equals("unknown"))receipt.set("publication",observed);
                    receipt.set("telemetry",telemetry.request(operationId));yield receipt;
                }
                default -> throw new IllegalArgumentException("Unknown safe bridge read");
            };
            response.put("ok",true);response.set("result",result);
        }catch(Throwable e){error(response,e);((ObjectNode)response.path("error").path("details")).put("nativeDispatch","not_started");}
        publish(claimed,response,true);
    }
    private ObjectNode diagnostics(JsonNode args) {
        for(Iterator<String> keys=args.fieldNames();keys.hasNext();)if(!keys.next().equals("requestId"))throw new IllegalArgumentException("bridge.diagnostics accepts only optional requestId");
        ObjectNode result=telemetry.snapshot().put("sessionId",id).put("nativeDeadlineOwner","expiresAt: queue/start only");
        if(args.has("requestId")){String requestId=NativeTarget.required(args,"requestId");if(!requestId.matches("[0-9a-fA-F-]{36}"))throw new IllegalArgumentException("requestId must be a UUID");result.set("request",telemetry.request(requestId));}
        return result;
    }
    private static ObjectNode cleanArgs(JsonNode args) {
        ObjectNode clean=args.deepCopy();clean.remove("contextId");return clean;
    }
    private void execute(Path claimed,JsonNode request,ObjectNode response,ObjectNode receipt) {
        String operation=request.path("operation").asText();JsonNode args=request.path("args");String contextId=request.path("precondition").path("contextId").asText(args.path("contextId").asText());
        boolean dispatched=false;
        String requestId=response.path("id").asText();telemetry.start(requestId,true);
        try {
            if(receipt!=null)operations.transition(receipt,"running");
            if(request.hasNonNull("expiresAt")&&Instant.parse(request.get("expiresAt").asText()).isBefore(Instant.now()))throw new ContextAccess.Conflict("REQUEST_EXPIRED","Request expired in queue before execution; no operation was performed");
            if(gateway==null)gateway=new GatewayAccess();
            if(OperationPolicy.mutation(operation,args)) {
                if(!request.path("precondition").isObject())throw new ContextAccess.Conflict("PRECONDITION_REQUIRED","Mutation requires {contextId,expected} precondition");
                OperationPolicy.enter(contexts,request.path("precondition"),operation,args);
                if(receipt!=null)receipt.set("beforeRevisions",contexts.inspect(contextId).path("revisions"));
            }
            if(receipt!=null){receipt.put("nativeDispatch","started");operations.transition(receipt,"dispatching");}
            dispatched=true;
            telemetry.nativeStart(requestId);
            Object result=switch(operation) {
                case "health" -> metadata("ready");
                case "context.bind" -> contexts.bind(args);
                case "context.inspect" -> contexts.inspect(NativeTarget.required(args,"contextId"));
                case "context.usage" -> contexts.usage(args);
                case "context.release" -> contexts.release(args);
                case "context.prune" -> contexts.prune(args);
                case "dependency.inspect" -> DependencyAccess.inspect(cleanArgs(args));
                case "operation.get" -> operations.get(NativeTarget.required(args,"operationId"));
                case "canvas.preview", "canvas.viewport", "canvas.capabilities" -> canvas.call(operation,args);
                case "layout.apply" -> LayoutAccess.apply(contexts,args);
                case "gateway.describe" -> gateway.describe(args);
                case "gateway.call" -> gateway.call(args);
                case "core.describe" -> CoreAccess.describe();
                default -> {
                    if(operation.startsWith("core."))yield CoreAccess.call(operation,cleanArgs(args));
                    if(operation.startsWith("desktop."))yield new DesktopAccess().call(operation,cleanArgs(args));
                    throw new IllegalArgumentException("Unknown operation: "+operation);
                }
            };
            telemetry.nativeEnd(requestId);telemetry.resultSerializationStart(requestId);
            response.put("ok",true);response.set("result",JSON.valueToTree(result));telemetry.resultSerializationEnd(requestId);
            if(receipt!=null)receipt.put("nativeDispatch","returned");
        }catch(Throwable e){error(response,e);
            ObjectNode details=(ObjectNode)response.path("error").path("details");
            if(!details.has("nativeDispatch"))details.put("nativeDispatch",dispatched?"started_outcome_unknown":"not_started");
            if(receipt!=null)receipt.set("nativeDispatch",details.path("nativeDispatch"));
        }
        finally {OperationPolicy.leave();}
        telemetry.nativeEnd(requestId);
        telemetry.journalStart(requestId);
        if(receipt!=null)try {
            JsonNode after=null;
            if(!contextId.isBlank())try{after=contexts.inspect(contextId).path("revisions");}catch(Exception ignored){}
            operations.finish(receipt,response,after);
        }catch(Exception e){
            boolean returned=response.path("ok").asBoolean();
            if(returned)error(response,new IllegalStateException("Operation outcome journal update failed; do not replay",e));
            ObjectNode details=(ObjectNode)response.path("error").path("details");
            secondary(details,"outcome_journal",e);
            details.put("nativeDispatch",receipt.path("nativeDispatch").asText()).put("nativeReturnedSuccessfully",returned).put("journalStatus","outcome_not_persisted");
            if(returned&&response.has("result"))preserveNativeResult(details,response.get("result"));
            response.set("receipt",receipt.deepCopy().put("journalStatus","outcome_not_persisted"));
            operations.rememberUnpersisted(receipt,response,e);
        }
        telemetry.journalEnd(requestId);
        publish(claimed,response,true);
    }
    static void preserveNativeResult(ObjectNode details,JsonNode result) {
        try {
            byte[] bytes=JSON.writeValueAsBytes(result);
            details.put("nativeResultBytes",bytes.length);
            if(bytes.length<=64*1024)details.set("nativeResult",result.deepCopy());
            else details.put("nativeResultOmitted","Result exceeds 64 KiB; inspect the target before any retry").put("nativeResultSha256",RevisionTracker.bytesDigest(bytes));
        }catch(Exception failure){details.put("nativeResultOmitted","Result could not be encoded; inspect the target before any retry");}
    }
    private void error(ObjectNode response,Throwable e) {
        response.put("ok",false);ObjectNode error=response.putObject("error");
        error.put("code",e instanceof ContextAccess.Conflict c?c.code:e instanceof GatewayAccess.GatewayException?"KNIME_ERROR":e instanceof IllegalArgumentException||e instanceof com.fasterxml.jackson.core.JsonProcessingException?"INVALID_ARGUMENT":"BRIDGE_ERROR");
        error.put("message",e.getMessage()==null?e.toString():e.getMessage());
        if(e instanceof GatewayAccess.GatewayException ge)error.set("details",ge.detail);
        else if(e instanceof ContextAccess.Conflict c)error.set("details",c.details);
        else error.putObject("details").put("exception",e.getClass().getName());
        log(e);
    }
    private static void secondary(ObjectNode details,String stage,Throwable error) {
        ArrayNode errors=details.has("secondaryErrors")?(ArrayNode)details.get("secondaryErrors"):details.putArray("secondaryErrors");
        if(errors.size()<8)errors.addObject().put("stage",stage).put("exception",error.getClass().getName()).put("message",String.valueOf(error.getMessage()));
    }
    private void publish(Path claimed,ObjectNode response,boolean updateTelemetry) {
        String requestId=response.path("id").asText();Throwable publicationFailure=null;long responseBytes=0;
        if(updateTelemetry)telemetry.publishing(requestId);
        response.set("telemetry",telemetry.request(requestId));
        response.putObject("publication").put("state","pending").put("completionObserved",false);
        try {byte[] bytes=JSON.writeValueAsBytes(response);responseBytes=bytes.length;if(updateTelemetry)telemetry.responseBytes(requestId,bytes.length);AtomicFiles.write(session.resolve("responses").resolve(requestId+".json"),bytes);}
        catch(Exception e){publicationFailure=e;problem=e.toString();log(e);}
        if(updateTelemetry)telemetry.published(requestId,publicationFailure);
        else telemetry.redeliveryPublished(responseBytes,publicationFailure);
        // Publishing a response and finishing a native action are different facts.
        // Preserve publication failure in an immutable event when the journal remains writable.
        if(updateTelemetry&&response.has("receipt"))try{telemetry.phase(requestId,"publication_journal");operations.publication(requestId,publicationFailure);}
        catch(Exception secondary){problem="Response publication journal failed: "+secondary;log(secondary);}
        if(publicationFailure==null)try{Files.deleteIfExists(claimed);}catch(Exception e){problem="Response published; inflight cleanup failed: "+e;log(e);}
        if(updateTelemetry)telemetry.workerDone(requestId);
    }
    private void log(Throwable e) {
        try {Files.writeString(session.resolve("bridge.log"),Instant.now()+" "+e+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);}
        catch(Exception ignored){}
    }
    @Override public void stop(BundleContext context)throws Exception {
        ready=false;if(jobs!=null)jobs.shutdownNow();if(requests!=null)requests.shutdownNow();if(heartbeat!=null)heartbeat.shutdownNow();
        if(session!=null)writeMetadata("stopped");
    }
}
