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
        Path path=file(id);ObjectNode receipt=null;FileSystemException aggregateFailure=null;
        try{if(Files.isRegularFile(path))receipt=read(path);}catch(FileSystemException failure){aggregateFailure=failure;}
        Path events=directory.resolve(id+".events");
        if(Files.isDirectory(events))try(var stream=Files.list(events)) {
            var entries=stream.filter(p->p.getFileName().toString().matches("[0-9]{4,8}\\.json")).sorted(Comparator.reverseOrder()).limit(10001).toList();
            if(entries.size()>10000)throw new IllegalArgumentException("Too many operation events");
            for(Path event:entries) {
                ObjectNode candidate=read(event);
                if(!candidate.has("operationId"))continue; // v0.2-beta.1 events contain transitions only.
                if(!id.equals(candidate.path("operationId").asText())||!sessionId.equals(candidate.path("sessionId").asText()))throw new IllegalArgumentException("Journal event identity mismatch");
                if(receipt==null||candidate.path("sequence").asInt()>receipt.path("sequence").asInt())receipt=candidate;
                break;
            }
        }
        if(receipt==null&&aggregateFailure!=null)throw aggregateFailure;
        if(receipt==null)throw new ContextAccess.Conflict("OPERATION_NOT_FOUND","No operation recorded for this session and ID");
        if(!id.equals(receipt.path("operationId").asText())||!sessionId.equals(receipt.path("sessionId").asText()))throw new IllegalArgumentException("Receipt identity mismatch");
        boolean pinned=receipt.path("pinned").isBoolean()&&receipt.path("pinned").asBoolean();
        boolean expired=!pinned&&receipt.hasNonNull("expiresAt")&&Instant.parse(receipt.path("expiresAt").asText()).isBefore(Instant.now());
        // Retention is metadata, never a native outcome or cancellation. Preserve
        // the authoritative status and UUID deduplication even after expiry.
        ObjectNode retention=receipt.putObject("retention").put("pinned",pinned).put("expired",expired).put("cancellationImplied",false);
        retention.set("expiresAt",receipt.has("expiresAt")?receipt.get("expiresAt").deepCopy():NullNode.instance);
        return receipt;
    }
    private ObjectNode read(Path path)throws Exception {
        if(Files.size(path)>1024*1024)throw new IllegalArgumentException("Receipt exceeds size bound");
        return (ObjectNode)BridgeActivator.JSON.readTree(Files.readAllBytes(path));
    }
    synchronized ObjectNode existing(String id,JsonNode request)throws Exception {
        ObjectNode receipt;
        try{receipt=get(id);}catch(ContextAccess.Conflict missing){if(missing.code.equals("OPERATION_NOT_FOUND"))return null;throw missing;}
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
            .put("acceptedAt",Instant.now().toString()).put("expiresAt",Instant.now().plusSeconds(7*86400).toString()).put("nativeDispatch","not_started");
        receipt.set("beforeRevisions",before==null?NullNode.instance:before.deepCopy());
        // Preconditions contain only target/revision fingerprints, never settings or table content.
        receipt.set("precondition",request.path("precondition").deepCopy());receipt.putArray("postconditions");receipt.putArray("transitions");
        transition(receipt,"queued");return receipt;
    }
    synchronized void transition(ObjectNode receipt,String state)throws Exception {
        ObjectNode next=receipt.deepCopy();String now=Instant.now().toString();next.put("status",state).put("updatedAt",now);
        ArrayNode events=(ArrayNode)next.get("transitions");events.addObject().put("status",state).put("at",now);
        next.put("sequence",events.size());
        Path eventsDir=directory.resolve(receipt.path("operationId").asText()+".events");Files.createDirectories(eventsDir);
        Path eventFile=eventsDir.resolve(String.format(Locale.ROOT,"%04d.json",events.size()));
        if(Files.exists(eventFile))throw new IllegalStateException("Receipt event already exists");
        // The immutable full event is authoritative. A contended aggregate cannot
        // erase durable acceptance or make a native action safe to replay.
        BridgeActivator.atomicWrite(eventFile,next);receipt.removeAll();receipt.setAll(next);
        try{BridgeActivator.atomicWrite(file(receipt.path("operationId").asText()),next);}
        catch(Exception failure){receipt.put("aggregateUpdate","deferred; durable event available");}
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
