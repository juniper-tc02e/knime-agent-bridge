package org.knime.agent;

import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;

/** Durable acceptance precedes dispatch. UUID redelivery never repeats a native action. */
final class OperationAccess {
    private final Path directory;private final String sessionId;
    private final Map<String,ObjectNode> recovery=Collections.synchronizedMap(new LinkedHashMap<>());
    OperationAccess(Path session,String id)throws Exception{directory=session.resolve("operations");sessionId=id;Files.createDirectories(directory);}
    private Path file(String id){if(!id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))throw new IllegalArgumentException("operationId must be a UUID");return directory.resolve(id+".json");}
    ObjectNode get(String id)throws Exception {
        ObjectNode remembered; synchronized(recovery){ObjectNode value=recovery.get(id);remembered=value==null?null:value.deepCopy();}
        try {
            ObjectNode durable=getDurable(id);if(remembered!=null)durable.set("outcomeRecovery",remembered);return durable;
        }catch(Exception failure) {
            if(remembered==null)throw failure;
            // This is explicit process-local evidence, never a fabricated durable journal.
            ObjectNode fallback=remembered.path("receipt").deepCopy();fallback.put("journalStatus","read_unavailable");
            fallback.set("outcomeRecovery",remembered);fallback.putObject("journalReadError").put("exception",failure.getClass().getName()).put("message",String.valueOf(failure.getMessage()));return fallback;
        }
    }
    private ObjectNode getDurable(String id)throws Exception {
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
    void rememberUnpersisted(ObjectNode receipt,ObjectNode response,Throwable failure) {
        ObjectNode observed=BridgeActivator.JSON.createObjectNode().put("source","native_process_memory").put("durable",false).put("journalStatus","outcome_not_persisted");
        ObjectNode retained=BridgeActivator.JSON.createObjectNode();
        for(String key:List.of("operationId","sessionId","contextId","operation","payloadDigest","guardCoverage","status","sequence","nativeDispatch","nativeOutcome","expiresAt")) {
            JsonNode value=receipt.path(key);if(value.isMissingNode())continue;
            if(value.isTextual()&&value.asText().length()>512)retained.put(key,value.asText().substring(0,512));else retained.set(key,value.deepCopy());
        }
        retained.put("journalStatus","outcome_not_persisted").put("completionVerified",false);observed.set("receipt",retained);
        if(response.has("error"))observed.set("primaryError",boundedError(response.path("error")));
        if(response.has("result"))BridgeActivator.preserveNativeResult(observed,response.path("result"));
        String message=String.valueOf(failure.getMessage());observed.putObject("journalFailure").put("exception",failure.getClass().getName()).put("message",message.substring(0,Math.min(message.length(),4096)));
        observed.put("recordByteLimit",128*1024).put("recordLimit",64);
        try {
            if(BridgeActivator.JSON.writeValueAsBytes(observed).length>128*1024) {
                observed.remove("nativeResult");observed.put("nativeResultOmitted","Process recovery record exceeded 128 KiB; inspect target before retry");
            }
        }catch(Exception ignored){observed.remove("nativeResult");}
        synchronized(recovery){while(recovery.size()>=64)recovery.remove(recovery.keySet().iterator().next());recovery.put(receipt.path("operationId").asText(),observed);}
    }
    private ObjectNode boundedError(JsonNode error) {
        try {if(BridgeActivator.JSON.writeValueAsBytes(error).length<=32*1024)return error.deepCopy();}catch(Exception ignored){}
        String message=error.path("message").asText();return BridgeActivator.JSON.createObjectNode().put("code",error.path("code").asText()).put("message",message.substring(0,Math.min(message.length(),4096))).put("detailsOmitted","Primary error exceeded 32 KiB; original code/message retained");
    }
    private ObjectNode read(Path path)throws Exception {
        if(Files.size(path)>1024*1024)throw new IllegalArgumentException("Receipt exceeds size bound");
        return (ObjectNode)BridgeActivator.JSON.readTree(Files.readAllBytes(path));
    }
    ObjectNode existing(String id,JsonNode request)throws Exception {
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
        receipt.put("nativeOutcome","not_started").put("journalStatus","acceptance_persisted");
        receipt.putObject("publication").put("state","not_attempted");
        if(request.path("operation").asText().equals("core.cancel"))receipt.putObject("cancellation").put("state","queued").put("requested",true).put("acknowledged",false).put("terminalVerified",false).put("dispatchLane","serialized_native_lane");
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
        receipt.put("nativeOutcome",ok?"returned_successfully":receipt.path("nativeDispatch").asText().equals("not_started")?"not_started":"failed_or_unknown");
        receipt.put("journalStatus","outcome_persisted");
        if(ok)BridgeActivator.preserveNativeResult(receipt,result);
        if(receipt.path("operation").asText().equals("core.cancel")) {
            receipt.putObject("cancellation").put("state",ok?"acknowledged":"failed_or_unknown").put("requested",true)
                .put("acknowledged",ok).put("terminalVerified",false).put("dispatchLane","serialized_native_lane");
        }
        boolean pending=ok&&(result.path("completed").isBoolean()&&!result.path("completed").asBoolean()||result.path("completionVerified").isBoolean()&&!result.path("completionVerified").asBoolean());
        if(!ok)receipt.set("error",response.path("error").deepCopy());
        String status=!ok||result.path("status").asText().equals("failed")?"failed":result.path("status").asText().equals("partially_applied")?"partially_applied":pending?"running":"applied";
        receipt.put("acknowledged",ok).put("completionVerified",status.equals("applied"));
        ((ArrayNode)receipt.get("postconditions")).addObject().put("kind",pending?"asynchronous-native-completion":"native-call-returned")
            .put("status",pending?"not_checked":ok?"passed":"failed").putArray("evidenceIds");
        transition(receipt,status);response.set("receipt",receipt.deepCopy());
    }
    synchronized void publication(String id,Throwable failure)throws Exception {
        ObjectNode publication=BridgeActivator.JSON.createObjectNode().put("state",failure==null?"published":"failed").put("completionObserved",true);
        if(failure!=null){String message=String.valueOf(failure.getMessage());publication.put("exception",failure.getClass().getName()).put("message",message.substring(0,Math.min(message.length(),4096)));}
        synchronized(recovery){ObjectNode observed=recovery.get(id);if(observed!=null){observed.set("publication",publication.deepCopy());try{if(BridgeActivator.JSON.writeValueAsBytes(observed).length>128*1024){observed.remove("nativeResult");observed.put("nativeResultOmitted","Process recovery record exceeded 128 KiB; inspect target before retry");}}catch(Exception ignored){observed.remove("nativeResult");}}}
        ObjectNode receipt=getDurable(id);receipt.set("publication",publication);
        transition(receipt,receipt.path("status").asText());
    }
}
