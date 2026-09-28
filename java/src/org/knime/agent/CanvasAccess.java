package org.knime.agent;

import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.knime.gateway.impl.project.ProjectManager;
import org.knime.gateway.api.entity.AnnotationIDEnt;
import org.knime.gateway.api.entity.ConnectionIDEnt;

final class CanvasAccess {
    private final ContextAccess contexts;private final ArtifactStore artifacts;
    CanvasAccess(ContextAccess contexts,ArtifactStore artifacts){this.contexts=contexts;this.artifacts=artifacts;}
    static Object capabilities(){return Map.of("experimental",true,"nativePreview",Map.of("adapter","GenerateSVGWorkflowSaveHook.renderPreviewSVG","bundleVersion",NativePreviewCapture.BUNDLE_VERSION,"runtimeVerification","required"),
        "viewport",Map.of("adapter","ChromiumBrowser.captureScreenshot","bundleVersion","128.0.30","freshness",EditorViewportCapture.FRESHNESS,"workflowToPixel","unverified"));}
    private static ObjectNode layout(ContextAccess.Bound b) {
        ObjectNode out=BridgeActivator.JSON.createObjectNode();var nodes=out.putArray("nodes");var annotations=out.putArray("annotations");var connections=out.putArray("connections");
        for(var n:b.scope().getNodeContainers()) {
            ObjectNode row=nodes.addObject().put("id",NativeTarget.relative(b.root(),n.getID())).put("nativeId",n.getID().toString());
            if(n.getUIInformation()!=null){int[] bounds=n.getUIInformation().getBounds();row.putObject("position").put("x",bounds[0]).put("y",bounds[1]);row.set("nativeBounds",BridgeActivator.JSON.valueToTree(bounds));}
        }
        for(var a:b.scope().getWorkflowAnnotations())annotations.addObject().put("id",new AnnotationIDEnt(a.getID(),b.scope()).toString()).put("nativeId",a.getID().toString()).putObject("bounds").put("x",a.getX()).put("y",a.getY()).put("width",a.getWidth()).put("height",a.getHeight());
        for(var c:b.scope().getConnectionContainers()) {
            ObjectNode row=connections.addObject().put("id",new ConnectionIDEnt(c.getID(),b.scope()).toString()).put("nativeId",c.getID().toString()).put("source",NativeTarget.relative(b.root(),c.getSource())).put("sourcePort",c.getSourcePort()).put("destination",NativeTarget.relative(b.root(),c.getDest())).put("destinationPort",c.getDestPort());
            var points=row.putArray("bendpoints");if(c.getUIInfo()!=null)for(int[] p:c.getUIInfo().getAllBendpoints())points.addObject().put("x",p[0]).put("y",p[1]);
        }
        return out;
    }
    Object call(String operation,JsonNode args)throws Exception {
        if(operation.equals("canvas.capabilities"))return capabilities();
        for(Iterator<String> it=args.fieldNames();it.hasNext();)if(!Set.of("contextId","projectId","workflowId").contains(it.next()))throw new IllegalArgumentException("Unknown canvas argument");
        String id=NativeTarget.required(args,"contextId");var b=contexts.require(id);
        if(b.root()==null)throw new IllegalArgumentException("Canvas capture requires a loaded project context");
        if(args.has("projectId")&&!b.projectId().equals(args.path("projectId").asText()))throw new ContextAccess.Conflict("CONTEXT_CHANGED","Capture project differs from context");
        if(args.has("workflowId")&&NativeTarget.workflow(b.root(),args)!=b.scope())throw new ContextAccess.Conflict("CONTEXT_CHANGED","Capture scope differs from context");
        boolean preview=operation.equals("canvas.preview");
        if(!preview&&!operation.equals("canvas.viewport"))throw new IllegalArgumentException("Unknown canvas operation");
        ObjectNode before,after,identity=null,artifact,nativeLayout=null,correspondence=null;Path temporary=artifacts.temporary(preview?"svg":"png");long started=System.nanoTime();
        try {
            if(preview) {
                try(var lock=b.root().lock()) {
                    contexts.require(id);before=RevisionTracker.read(b.scope());nativeLayout=layout(b);boolean dirty=b.root().isDirty();
                    NativePreviewCapture.render(b.scope(),temporary);correspondence=NativePreviewCapture.correspondence(b.scope(),temporary);after=RevisionTracker.read(b.scope());
                    if(dirty!=b.root().isDirty()||!before.equals(after))throw new IllegalStateException("Native preview changed model state; adapter rejected");
                }
            } else {
                if(b.scope()!=b.root())throw new UnsupportedOperationException("Viewport nested editor identity has not been proven; only root scope is supported experimentally");
                if(!ProjectManager.getInstance().isActiveProject(b.projectId()))throw new ContextAccess.Conflict("CONTEXT_CHANGED","Viewport requires the bound active project");
                try(var lock=b.root().lock()){contexts.require(id);before=RevisionTracker.read(b.scope());}
                var capture=EditorViewportCapture.capture();identity=capture.identity();Files.write(temporary,capture.png());
                try(var lock=b.root().lock()) {
                    contexts.require(id);after=RevisionTracker.read(b.scope());
                    if(!before.equals(after)||!ProjectManager.getInstance().isActiveProject(b.projectId()))throw new ContextAccess.Conflict("REVISION_CONFLICT","Project or model changed during viewport capture");
                }
            }
            artifact=artifacts.publish(temporary,preview?"svg":"png",preview?"image/svg+xml":"image/png");
        } finally {Files.deleteIfExists(temporary);}
        ObjectNode out=artifact.deepCopy().put("contextId",id).put("sourceFrameId",UUID.randomUUID().toString())
            .put("sourceKind",preview?"native-preview":"live-viewport").put("scopeId",b.identity().path("workflowId").asText())
            .put("freshness",preview&&correspondence.path("matched").asBoolean()?"verified":EditorViewportCapture.FRESHNESS).put("experimental",true)
            .put("capturedAt",Instant.now().toString()).put("durationMs",(System.nanoTime()-started)/1000000);
        out.set("artifact",artifact);out.set("context",contexts.inspect(id));out.set("revisions",after);
        out.set("beforeRevisions",before);out.set("afterRevisions",after);
        out.put("layoutRevision",after.path("layout").asText()).put("executionRevision",after.path("execution").asText());
        out.putObject("renderer").put("name",preview?"KNIME native preview":"Equo Chromium").put("version",preview?NativePreviewCapture.BUNDLE_VERSION:"128.0.30");
        boolean simpleScope=preview&&b.scope()==b.root()&&b.scope().getNodeContainers().stream().allMatch(n->n instanceof org.knime.core.node.workflow.NativeNodeContainer);
        boolean matched=preview&&correspondence.path("matched").asBoolean();
        var coverage=out.putObject("coverage").put("complete",matched&&simpleScope).putNull("bounds").putNull("workflowToPixel");
        var omissions=out.putArray("omissions");
        if(preview) {
            out.set("modelCorrespondence",correspondence);coverage.set("omittedObjectIds",correspondence.path("missingObjectIds"));
            if(!matched)omissions.add("Generated SVG did not match all native object IDs and node positions");
            if(!simpleScope)omissions.add("Nested/component/metanode port presentation requires separate fidelity review");
            out.putArray("fidelityLimitations").add("Native preview omits editor chrome/selection; source freshness does not certify viewport pixel parity");
        } else omissions.add("Frontend project/scope/render revision synchronization is unavailable").add("Only the visible embedded editor surface is captured; native SWT dialogs and offscreen content omitted");
        if(identity!=null)out.set("editorIdentity",identity);if(nativeLayout!=null)out.set("nativeLayout",nativeLayout);return out;
    }
}
