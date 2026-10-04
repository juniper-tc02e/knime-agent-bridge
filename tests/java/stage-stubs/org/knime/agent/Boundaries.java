package org.knime.agent;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;

class ContextAccess {
    ContextAccess(JsonNode value){}Object bind(JsonNode args){return Map.of();}ObjectNode inspect(String id){return BridgeActivator.JSON.createObjectNode().set("revisions",BridgeActivator.JSON.createObjectNode());}
    Object usage(JsonNode a){return Map.of();}Object release(JsonNode a){return Map.of();}Object prune(JsonNode a){return Map.of();}
    static class Conflict extends RuntimeException {final String code;final ObjectNode details=BridgeActivator.JSON.createObjectNode();Conflict(String code,String message){super(message);this.code=code;}}
}
class CoreAccess {
    static volatile CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);static volatile int effects;
    static void validateArguments(String operation,JsonNode args){}static Object describe(){return Map.of();}
    static Object call(String operation,JsonNode args)throws Exception {
        if(operation.equals("core.snapshot")){entered.countDown();if(!release.await(10,TimeUnit.SECONDS))throw new IllegalStateException("test worker latch expired");return Map.of();}
        effects++;
        if(args.path("obstructJournal").asBoolean()) {
            // Only the synthetic boundary injects faults. Production has no test switches.
            Path session=StageTelemetryHarness.session;
            try(var stream=Files.list(session.resolve("inflight"))) {
                Path request=stream.filter(p->{try{return BridgeActivator.JSON.readTree(Files.readAllBytes(p)).path("args").path("obstructJournal").asBoolean();}catch(Exception e){return false;}}).findFirst().orElseThrow();
                String id=request.getFileName().toString().replace(".json","");Path event=session.resolve("operations/"+id+".events/0004.json");Files.createDirectory(event);Files.writeString(event.resolve("obstruction"),"x");
            }
        }
        if(args.path("fail").asBoolean())throw new IllegalStateException("synthetic primary failure");
        return BridgeActivator.JSON.createObjectNode().put("accepted",true).put("completionVerified",operation.equals("core.cancel")?false:true);
    }
}
class GatewayAccess {
    static final List<String> SERVICES=List.of();static int initializations;GatewayAccess(){initializations++;}
    Object describe(JsonNode a){return Map.of();}Object call(JsonNode a){return Map.of();}
    static class GatewayException extends Exception {final ObjectNode detail=BridgeActivator.JSON.createObjectNode();}
}
class OperationPolicy {
    static boolean mutation(String op,JsonNode args){return op.equals("core.reset")||op.equals("core.cancel");}
    static ObjectNode coverage(){return BridgeActivator.JSON.createObjectNode();}static String guardCoverage(String op,JsonNode args){return "synthetic";}
    static void enter(ContextAccess contexts,JsonNode precondition,String op,JsonNode args){if(!precondition.path("contextId").asText().equals("fixture"))throw new ContextAccess.Conflict("SCOPE","wrong scope");}
    static void leave(){}
}
class CanvasAccess {CanvasAccess(ContextAccess c,ArtifactStore s){}static Map<String,Object> capabilities(){return Map.of();}Object call(String op,JsonNode a){return Map.of();}}
class ArtifactStore {ArtifactStore(Path p){}}
class LayoutAccess {static Object apply(ContextAccess c,JsonNode a){return Map.of();}}
class DependencyAccess {static Object inspect(JsonNode a){return Map.of();}}
class DesktopAccess {static Object uiState(){throw new AssertionError("UI queried from descriptor/control lane");}Object call(String op,JsonNode a){return Map.of();}}
class NativeTarget {static String required(JsonNode a,String key){if(!a.path(key).isTextual()||a.path(key).asText().isBlank())throw new IllegalArgumentException(key+" required");return a.path(key).asText();}}
class RevisionTracker {
    static String bytesDigest(byte[] bytes){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}catch(Exception e){throw new RuntimeException(e);}}
    static String digest(JsonNode value){try{return bytesDigest(BridgeActivator.JSON.writeValueAsBytes(value));}catch(Exception e){throw new RuntimeException(e);}}
}
