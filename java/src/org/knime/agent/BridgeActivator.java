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
    static final ObjectMapper JSON = new ObjectMapper();
    static final String VERSION = "0.1.0-beta.1";
    private final String id = UUID.randomUUID().toString();
    private final String startedAt = Instant.now().toString();
    private ScheduledExecutorService heartbeat;
    private ScheduledExecutorService requests;
    private Path session;
    private GatewayAccess gateway;
    private volatile boolean ready;
    private volatile String problem;

    @Override public void start(BundleContext context) throws Exception {
        String root=System.getProperty("knime.agent.runtime");
        if(root==null || root.isBlank()) root=Path.of(System.getProperty("user.home"),".knime-agent","runtime").toString();
        session=Path.of(root).toAbsolutePath().resolve("sessions").resolve(id);
        Files.createDirectories(session.resolve("requests"));
        Files.createDirectories(session.resolve("responses"));
        Files.createDirectories(session.resolve("inflight"));
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
        Bundle core=Platform.getBundle("org.knime.core");
        m.put("knimeVersion",core==null?"unknown":core.getVersion().toString());
        m.put("workspace",Platform.getInstanceLocation().getURL().toString());
        m.put("startedAt",startedAt);m.put("heartbeat",Instant.now().toString());m.put("status",status);
        m.put("workbenchRunning",PlatformUI.isWorkbenchRunning());m.put("modernUiReady",ready);
        if(!ready && PlatformUI.isWorkbenchRunning())m.set("uiState",JSON.valueToTree(DesktopAccess.uiState()));
        m.set("services",JSON.valueToTree(GatewayAccess.SERVICES));
        if(problem!=null)m.put("lastProblem",problem);
        return m;
    }
    private void writeMetadata(String status)throws Exception {atomicWrite(session.resolve("session.json"),metadata(status));}
    static void atomicWrite(Path path,JsonNode value)throws Exception {
        Path tmp=path.resolveSibling(path.getFileName()+".tmp");
        Files.write(tmp,JSON.writeValueAsBytes(value));
        try {Files.move(tmp,path,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
        catch(AtomicMoveNotSupportedException e){Files.move(tmp,path,StandardCopyOption.REPLACE_EXISTING);}
    }
    private void poll() {
        if(!ready)return;
        try(var files=Files.list(session.resolve("requests"))) {
            for(Path req:files.filter(p->p.getFileName().toString().matches("[0-9a-fA-F-]{36}\\.json")).sorted().toList()) process(req);
        } catch(Throwable e){problem=e.toString();log(e);}
    }
    private void process(Path path) {
        String requestId=path.getFileName().toString().replace(".json","");
        ObjectNode response=JSON.createObjectNode().put("id",requestId);
        Path claimed=session.resolve("inflight").resolve(path.getFileName());
        try {Files.move(path,claimed,StandardCopyOption.ATOMIC_MOVE);}
        catch(Exception e){problem=e.toString();log(e);return;}
        try {
            if(Files.size(claimed)>16*1024*1024)throw new IllegalArgumentException("Request exceeds 16 MiB");
            JsonNode request=JSON.readTree(Files.readAllBytes(claimed));
            if(!requestId.equals(request.path("id").asText()))throw new IllegalArgumentException("Request id does not match filename");
            if(request.hasNonNull("expiresAt") && Instant.parse(request.get("expiresAt").asText()).isBefore(Instant.now()))
                throw new IllegalArgumentException("Request expired before execution; no operation was performed");
            String operation=request.path("operation").asText();
            JsonNode args=request.path("args");
            if(!args.isObject())throw new IllegalArgumentException("args must be an object");
            if(gateway==null)gateway=new GatewayAccess();
            Object result=switch(operation) {
                case "health" -> metadata("ready");
                case "gateway.describe" -> gateway.describe(args);
                case "gateway.call" -> gateway.call(args);
                case "core.describe" -> CoreAccess.describe();
                default -> {
                    if(operation.startsWith("core."))yield CoreAccess.call(operation,args);
                    if(operation.startsWith("desktop."))yield new DesktopAccess().call(operation,args);
                    throw new IllegalArgumentException("Unknown operation: "+operation);
                }
            };
            response.put("ok",true);response.set("result",JSON.valueToTree(result));
        }catch(Throwable e){
            response.put("ok",false);
            ObjectNode error=response.putObject("error");
            error.put("code",e instanceof GatewayAccess.GatewayException?"KNIME_ERROR":e instanceof IllegalArgumentException?"INVALID_ARGUMENT":"BRIDGE_ERROR");
            error.put("message",e.getMessage()==null?e.toString():e.getMessage());
            if(e instanceof GatewayAccess.GatewayException ge)error.set("details",ge.detail);
            else error.putObject("details").put("exception",e.getClass().getName());
            log(e);
        }
        try {
            atomicWrite(session.resolve("responses").resolve(requestId+".json"),response);
            // Claimed requests are never replayed, even if a response cannot be written.
            Files.deleteIfExists(claimed);
        }catch(Exception e){problem=e.toString();log(e);}
    }
    private void log(Throwable e) {
        try {Files.writeString(session.resolve("bridge.log"),Instant.now()+" "+e+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);}
        catch(Exception ignored){}
    }
    @Override public void stop(BundleContext context)throws Exception {
        ready=false;if(requests!=null)requests.shutdownNow();if(heartbeat!=null)heartbeat.shutdownNow();
        if(session!=null)writeMetadata("stopped");
    }
}
