package org.knime.agent;

import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.util.*;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.introspect.BeanPropertyDefinition;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.googlecode.jsonrpc4j.JsonRpcMethod;
import com.googlecode.jsonrpc4j.JsonRpcParam;
import org.knime.gateway.api.entity.NodeIDEnt;
import org.knime.gateway.api.service.GatewayService;
import org.knime.gateway.api.webui.service.util.ListServices;
import org.knime.gateway.impl.webui.jsonrpc.DefaultJsonRpcRequestHandler;
import org.knime.gateway.impl.webui.jsonrpc.service.util.WrapWithJsonRpcService;
import org.knime.gateway.json.util.ObjectMapperUtil;
import org.knime.ui.java.api.DesktopAPI;

/** Attaches to the services and project registry already owned by the modern UI. */
final class GatewayAccess {
    private static final String EVENT_RESTRICTION = "EventService subscriptions belong to KNIME's UI and are shared per workflow. Use ApplicationService.getState and WorkflowService.getWorkflow/getWorkflowMonitorState to poll.";
    private static final String SAVE_RESTRICTION = "WorkflowService.saveProject does not save in KNIME Desktop because its browser service context is absent. Use desktop.saveProject, then verify the root workflow is no longer dirty.";
    private static final Map<String, Class<? extends GatewayService>> INTERFACES = serviceInterfaces();
    static final List<String> SERVICES = List.copyOf(INTERFACES.keySet());
    private DefaultJsonRpcRequestHandler handler;

    static final class GatewayException extends Exception {
        final JsonNode detail;
        GatewayException(JsonNode detail) { super(detail.path("message").asText(detail.toString())); this.detail=detail; }
    }

    private static Map<String, Class<? extends GatewayService>> serviceInterfaces() {
        Map<String, Class<? extends GatewayService>> result = new LinkedHashMap<>();
        ListServices.listServiceInterfaces().stream().sorted(Comparator.comparing(Class::getSimpleName))
            .forEach(type -> result.put(type.getSimpleName(), type));
        return Collections.unmodifiableMap(result);
    }

    synchronized JsonNode call(JsonNode args) throws Exception {
        String name=args.path("method").asText();
        int separator=name.indexOf('.');
        String service=separator<0?"":name.substring(0,separator);
        String method=separator<0?"":name.substring(separator+1);
        Class<? extends GatewayService> api=INTERFACES.get(service);
        if(api==null || methods(api).stream().noneMatch(m->rpcName(m).equals(method)))
            throw new IllegalArgumentException("Unknown service/method: "+name);
        if(service.equals("EventService")) throw new IllegalArgumentException(EVENT_RESTRICTION);
        if(name.equals("WorkflowService.saveProject")) throw new IllegalArgumentException(SAVE_RESTRICTION);
        if(!DesktopAPI.areDependenciesInjected()) throw new IllegalStateException("KNIME's modern UI is not initialized; open it first");
        JsonNode params=args.get("params");
        if(params==null) params=BridgeActivator.JSON.createObjectNode();
        if(!(params.isArray() || params.isObject())) throw new IllegalArgumentException("params must be an array or object");
        ObjectNode request=BridgeActivator.JSON.createObjectNode().put("jsonrpc","2.0")
            .put("id",UUID.randomUUID().toString()).put("method",name);
        request.set("params",params);
        if(handler==null) handler=new DefaultJsonRpcRequestHandler();
        JsonNode response=BridgeActivator.JSON.readTree(handler.handle(BridgeActivator.JSON.writeValueAsBytes(request)));
        if(response==null || !response.isObject()) throw new IllegalStateException("Gateway returned no JSON-RPC response");
        if(response.has("error")) throw new GatewayException(response.get("error"));
        return response.path("result");
    }

    Object describe(JsonNode args) throws Exception {
        if(args.hasNonNull("entity")) return entity(args.get("entity").asText());
        if(args.path("commands").asBoolean(false)) return entity("WorkflowCommandEnt");
        String requested=args.path("service").asText("");
        String requestedMethod=args.path("method").asText("");
        if(requestedMethod.contains(".")) {
            int separator=requestedMethod.indexOf('.');
            String methodService=requestedMethod.substring(0,separator);
            if(!requested.isEmpty() && !requested.equals(methodService)) throw new IllegalArgumentException("service and method refer to different services");
            requested=methodService; requestedMethod=requestedMethod.substring(separator+1);
        }
        if(!requested.isEmpty() && !INTERFACES.containsKey(requested)) throw new IllegalArgumentException("Unknown service: "+requested);
        List<Object> descriptions=new ArrayList<>(); int matched=0;
        for(String name:SERVICES) {
            if(!requested.isEmpty() && !requested.equals(name)) continue;
            List<Object> descriptionsForService=new ArrayList<>();
            for(Method method:methods(INTERFACES.get(name))) {
                if(!requestedMethod.isEmpty() && !rpcName(method).equals(requestedMethod)) continue;
                List<Object> params=new ArrayList<>(); Parameter[] parameters=method.getParameters();
                for(int i=0;i<parameters.length;i++) {
                    Parameter parameter=parameters[i];
                    JsonRpcParam annotation=parameter.getAnnotation(JsonRpcParam.class);
                    if(annotation==null) throw new IllegalStateException("Missing gateway parameter annotation: "+method);
                    params.add(Map.of("index",i,"name",annotation.value(),"type",parameter.getParameterizedType().getTypeName()));
                }
                Map<String,Object> description=new LinkedHashMap<>();
                description.put("method",name+"."+rpcName(method)); description.put("parameters",params);
                description.put("returns",method.getGenericReturnType().getTypeName());
                boolean desktopSave=name.equals("WorkflowService") && rpcName(method).equals("saveProject");
                description.put("callable",!name.equals("EventService") && !desktopSave);
                if(name.equals("EventService")) description.put("restriction",EVENT_RESTRICTION);
                if(desktopSave) description.put("restriction",SAVE_RESTRICTION);
                descriptionsForService.add(description); matched++;
            }
            if(requestedMethod.isEmpty() || !descriptionsForService.isEmpty()) descriptions.add(Map.of("service",name,"methods",descriptionsForService));
        }
        if(!requestedMethod.isEmpty() && matched==0) throw new IllegalArgumentException("Unknown gateway method: "+requestedMethod);
        return Map.of("services",descriptions,"parameterNamesSource","Installed JSON-RPC wrapper annotations",
            "usage","Use named params or positional params in listed index order. Inspect fields with {entity:'AddNodeCommandEnt'} and command kinds with {commands:true}. Required parameters/defaults are not inferred. KNIME internal API, version-specific.");
    }

    @SuppressWarnings({"unchecked","rawtypes"})
    private static List<Method> methods(Class<? extends GatewayService> api) {
        // Never evaluate the supplier: discovery must not initialize a live service.
        GatewayService wrapper=WrapWithJsonRpcService.wrap(()->null,(Class)api);
        return Arrays.stream(wrapper.getClass().getDeclaredMethods()).filter(m->m.isAnnotationPresent(JsonRpcMethod.class))
            .sorted(Comparator.comparing(GatewayAccess::rpcName)).toList();
    }
    private static String rpcName(Method method) {
        String annotated=method.getAnnotation(JsonRpcMethod.class).value();
        return annotated.isEmpty()?method.getName():annotated;
    }

    private Object entity(String name) throws Exception {
        if(!name.matches("[A-Za-z][A-Za-z0-9_$]*")) throw new IllegalArgumentException("Invalid entity name");
        Class<?> type;
        try { type=Class.forName("org.knime.gateway.api.webui.entity."+name); }
        catch(ClassNotFoundException first) {
            try { type=Class.forName("org.knime.gateway.api.entity."+name); }
            catch(ClassNotFoundException second) { throw new IllegalArgumentException("Unknown gateway entity: "+name); }
        }
        if(type==NodeIDEnt.class) return Map.of("entity",name,"jsonType","string","examples",List.of("root","root:1","root:1:2"),"usage","Use IDs returned by KNIME; IDs are relative to the workflow project.");
        ObjectMapper mapper=ObjectMapperUtil.getInstance().getObjectMapper();
        if(type.isEnum()) return Map.of("entity",name,"jsonType","string","values",enumValues(type,mapper));
        BeanDescription bean=mapper.getSerializationConfig().introspect(mapper.constructType(type));
        List<Object> fields=new ArrayList<>();
        for(BeanPropertyDefinition property:bean.findProperties().stream().sorted(Comparator.comparing(BeanPropertyDefinition::getName)).toList()) {
            var member=property.getPrimaryMember(); if(member==null) continue;
            Map<String,Object> field=new LinkedHashMap<>();
            field.put("name",property.getName()); field.put("type",member.getType().toCanonical());
            // Missing required metadata is unknown, not proof that a field is optional.
            if(property.isRequired()) field.put("required",true);
            if(member.getRawType().isEnum()) field.put("values",enumValues(member.getRawType(),mapper));
            fields.add(field);
        }
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("entity",name); result.put("fields",fields);
        result.put("source","Installed KNIME Jackson mapper, including entity mixins");
        result.put("requiredness","Only explicit required annotations are reported; absence is unknown");
        Class<?> mixin=mapper.findMixInClassFor(type); if(mixin!=null) result.put("mixin",mixin.getName());
        JsonTypeInfo discriminator=bean.getClassInfo().getAnnotation(JsonTypeInfo.class);
        if(discriminator!=null) result.put("discriminator",Map.of("property",discriminator.property(),"type",discriminator.use().name(),"inclusion",discriminator.include().name(),"visible",discriminator.visible()));
        JsonSubTypes subtypes=bean.getClassInfo().getAnnotation(JsonSubTypes.class);
        if(subtypes!=null) {
            List<Object> descriptions=new ArrayList<>();
            for(JsonSubTypes.Type subtype:subtypes.value()) {
                String implementation=subtype.value().getSimpleName();
                String entityName=implementation.startsWith("Default")?implementation.substring(7):implementation;
                descriptions.add(Map.of("value",subtype.name(),"entity",entityName,"implementation",subtype.value().getName()));
            }
            result.put("subtypes",descriptions);
        }
        return result;
    }
    private static List<JsonNode> enumValues(Class<?> type,ObjectMapper mapper) {
        return Arrays.stream(type.getEnumConstants()).map(value->(JsonNode)mapper.valueToTree(value)).toList();
    }
}
