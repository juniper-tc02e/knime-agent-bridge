package org.knime.agent;

import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;

/** Durable acceptance precedes dispatch. UUID redelivery never repeats a native action. */
final class OperationAccess {
    private final Path directory;private final String sessionId;
    OperationAccess(Path session,String id)throws Exception{directory=session.resolve("operations");sessionId=id;Files.createDirectories(directory);}
    private Path file(String id){if(!id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))throw new IllegalArgumentException("operationId must be a UUID");return directory.resolve(id+".json");}
    synchronized ObjectNode get(String id)throws Exception {
        Path path=file(id);if(!Files.isRegularFile(path))throw new ContextAccess.Conflict("OPERATION_NOT_FOUND","No operation recorded for this session and ID");
        if(Files.size(path)>1024*1024)throw new IllegalArgumentException("Receipt exceeds size bound");
        ObjectNode receipt=(ObjectNode)BridgeActivator.JSON.readTree(Files.readAllBytes(path));
        if(!receipt.path("pinned").asBoolean()&&receipt.has("expiresAt")&&Instant.parse(receipt.path("expiresAt").asText()).isBefore(Instant.now()))receipt.put("status","expired");
        return receipt;
    }
    synchronized ObjectNode existing(String id,JsonNode request)throws Exception {
        if(!Files.exists(file(id)))return null;
        ObjectNode receipt=get(id);
        if(!receipt.path("payloadDigest").asText().equals(payloadDigest(request)))throw new ContextAccess.Conflict("OPERATION_ID_REUSED","Operation UUID was already accepted with a different payload");
        return receipt;
    }
    private String payloadDigest(JsonNode request)throws Exception {
        ObjectNode payload=BridgeActivator.JSON.createObjectNode();payload.set("operation",request.path("operation"));payload.set("args",request.path("args"));payload.set("precondition",request.path("precondition"));
        return RevisionTracker.digest(payload);
    }
    synchronized ObjectNode accept(String id,JsonNode request,JsonNode before)throws Exception {
        ObjectNode receipt=BridgeActivator.JSON.createObjectNode().put("operationId",id).put("sessionId",sessionId)
            .put("contextId",request.path("precondition").path("contextId").asText(request.path("args").path("contextId").asText()))
            .put("operation",request.path("operation").asText()).put("payloadDigest",payloadDigest(request))
            .put("guardCoverage",OperationPolicy.guardCoverage(request.path("operation").asText(),request.path("args")))
            .put("acceptedAt",Instant.now().toString()).put("expiresAt",Instant.now().plusSeconds(7*86400).toString());
        receipt.set("beforeRevisions",before==null?NullNode.instance:before.deepCopy());
        // Preconditions contain only target/revision fingerprints, never settings or table content.
        receipt.set("precondition",request.path("precondition").deepCopy());receipt.putArray("postconditions");receipt.putArray("transitions");
        transition(receipt,"queued");return receipt;
    }
    synchronized void transition(ObjectNode receipt,String state)throws Exception {
        String now=Instant.now().toString();receipt.put("status",state).put("updatedAt",now);
        ArrayNode events=(ArrayNode)receipt.get("transitions");ObjectNode event=events.addObject().put("status",state).put("at",now);
        Path eventsDir=directory.resolve(receipt.path("operationId").asText()+".events");Files.createDirectories(eventsDir);
        Path eventFile=eventsDir.resolve(String.format(Locale.ROOT,"%04d.json",events.size()));
        if(Files.exists(eventFile))throw new IllegalStateException("Receipt event already exists");
        BridgeActivator.atomicWrite(eventFile,event);BridgeActivator.atomicWrite(file(receipt.path("operationId").asText()),receipt);
    }
    synchronized void finish(ObjectNode receipt,ObjectNode response,JsonNode after)throws Exception {
        if(after!=null)receipt.set("afterRevisions",after.deepCopy());
        boolean ok=response.path("ok").asBoolean();JsonNode result=response.path("result");
        boolean pending=ok&&(result.path("completed").isBoolean()&&!result.path("completed").asBoolean()||result.path("completionVerified").isBoolean()&&!result.path("completionVerified").asBoolean());
        if(!ok)receipt.set("error",response.path("error").deepCopy());
        String status=!ok||result.path("status").asText().equals("failed")?"failed":result.path("status").asText().equals("partially_applied")?"partially_applied":pending?"running":"applied";
        receipt.put("acknowledged",ok).put("completionVerified",status.equals("applied"));
        ((ArrayNode)receipt.get("postconditions")).addObject().put("kind",pending?"asynchronous-native-completion":"native-call-returned")
            .put("status",pending?"not_checked":ok?"passed":"failed").putArray("evidenceIds");
        transition(receipt,status);response.set("receipt",receipt.deepCopy());
    }
}
