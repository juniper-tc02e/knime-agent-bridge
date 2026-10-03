package org.knime.agent;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import java.nio.file.*;
import java.util.*;

/** Executes the production journal reader and deduplication methods against real disk receipts. */
public final class OperationRetentionHarness {
    static ObjectNode object(){return BridgeActivator.JSON.createObjectNode();}
    static ObjectNode receipt(String id,String status,String expiry,boolean pinned) {
        var value=object().put("operationId",id).put("sessionId","session").put("status",status).put("sequence",1).put("pinned",pinned);
        if(expiry!=null)value.put("expiresAt",expiry);return value;
    }
    static void retention(JsonNode read,String status,boolean expired,boolean pinned,String expiresAt) {
        assert read.path("status").asText().equals(status):"expiry replaced authoritative "+status+" with "+read.path("status").asText();
        JsonNode retention=read.path("retention");assert retention.isObject():"retention metadata is missing";
        assert retention.path("expired").asBoolean()==expired && retention.path("expired").isBoolean();
        assert retention.path("pinned").asBoolean()==pinned && retention.path("pinned").isBoolean();
        assert !retention.path("cancellationImplied").asBoolean() && retention.path("cancellationImplied").isBoolean();
        if(expiresAt==null)assert retention.path("expiresAt").isNull();else assert retention.path("expiresAt").asText().equals(expiresAt);
    }
    public static void main(String[] args)throws Exception {
        Path session=Path.of(args[0]).resolve("synthetic-session");var operations=new OperationAccess(session,"session");
        Path directory=session.resolve("operations");String past="2000-01-01T00:00:00Z",future="2999-01-01T00:00:00Z";
        for(String status:List.of("applied","failed","partially_applied","queued","running","dispatching")) {
            String id=UUID.randomUUID().toString();var stored=receipt(id,status,past,false);Path aggregate=directory.resolve(id+".json");
            BridgeActivator.atomicWrite(aggregate,stored);byte[] before=Files.readAllBytes(aggregate);
            retention(operations.get(id),status,true,false,past);
            assert Arrays.equals(before,Files.readAllBytes(aggregate)):"retention observation rewrote the immutable journal";
        }
        for(String expiry:List.of(past,future)) {
            String id=UUID.randomUUID().toString();BridgeActivator.atomicWrite(directory.resolve(id+".json"),receipt(id,"failed",expiry,true));
            retention(operations.get(id),"failed",false,true,expiry);
        }
        String missing=UUID.randomUUID().toString();BridgeActivator.atomicWrite(directory.resolve(missing+".json"),receipt(missing,"applied",null,false));
        retention(operations.get(missing),"applied",false,false,null);
        String live=UUID.randomUUID().toString();BridgeActivator.atomicWrite(directory.resolve(live+".json"),receipt(live,"applied",future,false));
        retention(operations.get(live),"applied",false,false,future);
        String eventId=UUID.randomUUID().toString();BridgeActivator.atomicWrite(directory.resolve(eventId+".json"),receipt(eventId,"queued",future,false));
        var event=receipt(eventId,"applied",past,false).put("sequence",2);Path eventPath=directory.resolve(eventId+".events/0002.json");BridgeActivator.atomicWrite(eventPath,event);
        retention(operations.get(eventId),"applied",true,false,past);
        Files.delete(directory.resolve(eventId+".json"));retention(operations.get(eventId),"applied",true,false,past);
        expiredRedelivery(operations,directory,past);
        System.out.println("native operation retention behavior verified");
    }
    static void expiredRedelivery(OperationAccess operations,Path directory,String past)throws Exception {
        String id=UUID.randomUUID().toString();var request=object().put("operation","core.execute");request.set("args",object().put("projectId","fixture"));
        var precondition=object().put("contextId","context");precondition.set("expected",object());request.set("precondition",precondition);
        int effects=0;ObjectNode existing=operations.existing(id,request);
        assert existing==null;
        var accepted=operations.accept(id,request,null);effects++;
        operations.transition(accepted,"dispatching");operations.finish(accepted,object().put("ok",true).set("result",object().put("completed",true)),null);
        accepted.put("expiresAt",past);Path aggregate=directory.resolve(id+".json"),event=directory.resolve(id+".events/0003.json");
        BridgeActivator.atomicWrite(aggregate,accepted);BridgeActivator.atomicWrite(event,accepted);
        byte[] aggregateBefore=Files.readAllBytes(aggregate),eventBefore=Files.readAllBytes(event);
        var replay=operations.existing(id,request);if(replay==null){effects++;operations.accept(id,request,null);}
        assert effects==1:"expired UUID redelivery authorized a repeated effect";
        retention(replay,"applied",true,false,past);
        assert Arrays.equals(aggregateBefore,Files.readAllBytes(aggregate)) && Arrays.equals(eventBefore,Files.readAllBytes(event));
        try{operations.existing(id,request.deepCopy().put("operation","core.reset"));throw new AssertionError("altered UUID payload accepted after expiry");}
        catch(ContextAccess.Conflict expected){assert expected.code.equals("OPERATION_ID_REUSED");}
        try(var entries=Files.list(event.getParent())){assert entries.count()==3:"redelivery appended a native dispatch event";}
    }
}
