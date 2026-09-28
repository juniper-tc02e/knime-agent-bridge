package org.knime.agent;

import java.lang.reflect.InvocationTargetException;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;
import javax.xml.parsers.DocumentBuilderFactory;
import com.fasterxml.jackson.databind.node.*;
import org.w3c.dom.Element;
import org.knime.gateway.api.webui.util.EntityFactory;
import org.knime.gateway.api.webui.util.WorkflowBuildContext;
import org.eclipse.core.runtime.Platform;
import org.knime.core.node.workflow.WorkflowManager;

/** The only reflective preview symbol accepted, pinned to the inspected native bundle. */
final class NativePreviewCapture {
    static final String BUNDLE_VERSION="5.12.0.v202606171738";
    /** Match the generated source against the same native entity builder used by the pinned hook. */
    static ObjectNode correspondence(WorkflowManager manager,Path output)throws Exception {
        var workflow=EntityFactory.Workflow.buildWorkflowEnt(manager,WorkflowBuildContext.builder());
        ObjectNode out=BridgeActivator.JSON.createObjectNode();ArrayNode missing=out.putArray("missingObjectIds"),unexpected=out.putArray("unexpectedObjectIds"),mismatched=out.putArray("positionMismatchIds");
        try {
            var factory=DocumentBuilderFactory.newInstance();factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities",false);factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false);
            factory.setXIncludeAware(false);factory.setExpandEntityReferences(false);factory.setAttribute(javax.xml.XMLConstants.ACCESS_EXTERNAL_DTD,"");factory.setAttribute(javax.xml.XMLConstants.ACCESS_EXTERNAL_SCHEMA,"");
            var document=factory.newDocumentBuilder().parse(output.toFile());var elements=document.getElementsByTagName("*");
            Map<String,Element> nodes=new HashMap<>();Set<String> annotations=new HashSet<>(),connections=new HashSet<>();boolean duplicate=false;
            for(int i=0;i<elements.getLength();i++) {
                Element element=(Element)elements.item(i);
                if(element.hasAttribute("data-node-id"))duplicate|=nodes.put(element.getAttribute("data-node-id"),element)!=null;
                if(element.hasAttribute("data-annotation-id"))duplicate|=!annotations.add(element.getAttribute("data-annotation-id"));
                if(element.hasAttribute("data-connector-id"))duplicate|=!connections.add(element.getAttribute("data-connector-id"));
            }
            Set<String> expectedNodes=new HashSet<>(),expectedAnnotations=new HashSet<>(),expectedConnections=new HashSet<>();
            Pattern translation=Pattern.compile("translate\\(\\s*(-?[0-9]+(?:\\.[0-9]+)?)\\s*[, ]\\s*(-?[0-9]+(?:\\.[0-9]+)?)\\s*\\)");
            for(var node:workflow.getNodes().values()) {
                String id=node.getId().toString();expectedNodes.add(id);Element element=nodes.get(id);
                if(element!=null) {
                    Matcher match=translation.matcher(element.getAttribute("transform"));var position=node.getPosition();
                    if(!match.matches()||position==null||Double.parseDouble(match.group(1))!=position.getX()||Double.parseDouble(match.group(2))!=position.getY())mismatched.add(id);
                }
            }
            for(var a:workflow.getWorkflowAnnotations())expectedAnnotations.add(a.getId().toString());
            for(var c:workflow.getConnections().values())expectedConnections.add(c.getId().toString());
            compare(expectedNodes,nodes.keySet(),missing,unexpected);compare(expectedAnnotations,annotations,missing,unexpected);compare(expectedConnections,connections,missing,unexpected);
            out.put("matched",!duplicate&&missing.isEmpty()&&unexpected.isEmpty()&&mismatched.isEmpty()).put("duplicateIds",duplicate)
                .put("matchedNodePositions",expectedNodes.size()-mismatched.size()).put("basis","pinned-native-entity-ids-and-node-positions");
        } catch(Exception e){out.put("matched",false).put("error",e.getClass().getSimpleName()+": "+e.getMessage());}
        return out;
    }
    private static void compare(Set<String> expected,Set<String> actual,ArrayNode missing,ArrayNode unexpected){for(String id:new TreeSet<>(expected))if(!actual.contains(id))missing.add(id);for(String id:new TreeSet<>(actual))if(!expected.contains(id))unexpected.add(id);}
    static void render(WorkflowManager manager,Path output)throws Exception {
        var bundle=Platform.getBundle("org.knime.gateway.impl");
        if(bundle==null||!BUNDLE_VERSION.equals(bundle.getVersion().toString()))throw new UnsupportedOperationException("Native preview requires org.knime.gateway.impl "+BUNDLE_VERSION);
        Class<?> type=bundle.loadClass("org.knime.gateway.impl.webui.preview.GenerateSVGWorkflowSaveHook");
        var method=type.getDeclaredMethod("renderPreviewSVG",WorkflowManager.class,Path.class);
        if(!method.trySetAccessible())throw new UnsupportedOperationException("Pinned native preview method is not accessible");
        try {method.invoke(null,manager,output);}
        catch(InvocationTargetException e){if(e.getCause() instanceof Exception cause)throw cause;throw e;}
        if(!Files.isRegularFile(output)||Files.size(output)==0)throw new IllegalStateException("Native preview produced no SVG");
    }
}
