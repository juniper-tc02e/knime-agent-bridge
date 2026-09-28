package org.knime.agent;

import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** JVM-only behavioral probes. Does not create, open, save or mutate a KNIME workflow. */
public final class NativeUtilityProbe {
    interface Checked {void run()throws Exception;}
    static int assertions;
    static void check(boolean value,String message){assertions++;if(!value)throw new AssertionError(message);}
    static void rejected(Checked action,String message)throws Exception {try{action.run();}catch(IllegalArgumentException expected){assertions++;return;}throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        Path scratch=Path.of(args[0]);Files.createDirectories(scratch);
        byte[] png=Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=");
        check(Arrays.equals(EditorViewportCapture.decode(Base64.getEncoder().encode(png)),png),"Decode exactly once");
        check(Arrays.equals(EditorViewportCapture.dimensions(png),new int[]{1,1}),"Read PNG dimensions");
        rejected(()->EditorViewportCapture.decode(new byte[0]),"Empty screenshot accepted");
        rejected(()->EditorViewportCapture.decode("not-base64".getBytes(StandardCharsets.UTF_8)),"Malformed base64 accepted");
        rejected(()->EditorViewportCapture.decode(png),"Raw PNG was mistaken for encoded result");
        byte[] huge=png.clone();huge[16]=0x7f;
        rejected(()->EditorViewportCapture.dimensions(huge),"Pixel overflow accepted");
        ArtifactStore store=new ArtifactStore(scratch);Path draft=store.temporary("svg");Files.writeString(draft,"<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
        ObjectNode artifact=store.publish(draft,"svg","image/svg+xml");Path published=scratch.resolve("artifacts").resolve(artifact.path("artifactId").asText());
        check(Files.isRegularFile(published)&&!Files.exists(draft),"Publish moves complete binary atomically");
        check(RevisionTracker.bytesDigest(Files.readAllBytes(published)).equals(artifact.path("sha256").asText()),"Artifact hash matches");
        Path external=scratch.resolve("external.svg");Files.writeString(external,"<svg/>");
        rejected(()->store.publish(external,"svg","image/svg+xml"),"External artifact path accepted");
        Path empty=store.temporary("png");rejected(()->store.publish(empty,"png","image/png"),"Empty artifact accepted");
        OperationAccess operations=new OperationAccess(scratch,"session-test");String id=UUID.randomUUID().toString();
        ObjectNode request=BridgeActivator.JSON.createObjectNode().put("operation","layout.apply");request.putObject("args").put("contextId","test");request.putObject("precondition").put("contextId","test").putObject("expected").put("layout","a");
        ObjectNode receipt=operations.accept(id,request,null);check(receipt.path("status").asText().equals("queued"),"Acceptance is durable before dispatch");
        check(operations.existing(id,request)!=null,"Identical redelivery resolves existing receipt");
        ObjectNode reordered=BridgeActivator.JSON.createObjectNode();reordered.set("precondition",request.path("precondition"));reordered.set("args",request.path("args"));reordered.set("operation",request.path("operation"));
        check(operations.existing(id,reordered)!=null,"Object key order must not change canonical digest");
        ObjectNode different=request.deepCopy();((ObjectNode)different.path("args")).put("changed",true);
        rejected(()->operations.existing(id,different),"UUID accepted for different payload");
        operations.transition(receipt,"running");ObjectNode response=BridgeActivator.JSON.createObjectNode().put("ok",true);response.putObject("result").put("accepted",true).put("completed",false);
        operations.finish(receipt,response,null);check(operations.get(id).path("status").asText().equals("running"),"Asynchronous acknowledgement upgraded to applied");
        check(operations.get(id).path("postconditions").get(0).path("status").asText().equals("not_checked"),"Unknown postcondition upgraded to success");
        rejected(()->operations.get("../outside"),"Receipt path traversal accepted");
        System.out.println("native-utility-probe assertions="+assertions+"; runtime-model-proof=false");
    }
}
