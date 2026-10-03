package org.knime.agent;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import org.knime.core.node.workflow.WorkflowManager;
import org.knime.gateway.impl.project.ProjectManager;

/** Native runtime is replaced only at the dependency boundary; actual ContextAccess runs. */
public final class ContextAccessHarness {
    static ObjectNode args(){return BridgeActivator.JSON.createObjectNode();}
    static JsonNode invoke(ContextAccess access,String method,JsonNode args)throws Exception {
        try{return (JsonNode)ContextAccess.class.getDeclaredMethod(method,JsonNode.class).invoke(access,args);}
        catch(NoSuchMethodException absent){throw new AssertionError("context."+method+" is not implemented",absent);}
        catch(InvocationTargetException wrapper){if(wrapper.getCause() instanceof Exception e)throw e;throw wrapper;}
    }
    static void changed(Runnable check){try{check.run();throw new AssertionError("stale context was accepted");}catch(ContextAccess.Conflict expected){assert expected.code.equals("CONTEXT_CHANGED");}}
    static ContextAccess access(){return new ContextAccess(args().put("id","session").put("workspace","synthetic").put("bundleFingerprint","a".repeat(64)));}
    static JsonNode bind(ContextAccess access,ObjectNode args)throws Exception{return (JsonNode)access.bind(args);}
    public static void main(String[] ignored)throws Exception {
        var access=access();
        assert invoke(access,"usage",args()).path("remaining").asInt()==1024;
        String a=bind(access,args()).path("contextId").asText(),b=bind(access,args()).path("contextId").asText();
        assert !a.equals(b);
        ObjectNode precondition=args().put("contextId",a);precondition.set("expected",args());
        access.validate(precondition,"SpaceService.createWorkflow",args(),List.of(),false);
        assert invoke(access,"release",args().put("contextId",a)).path("released").asBoolean();
        changed(()->access.require(a));
        try{access.validate(precondition,"SpaceService.createWorkflow",args(),List.of(),false);throw new AssertionError("released context passed apply-time guard");}catch(ContextAccess.Conflict expected){assert expected.code.equals("CONTEXT_CHANGED");}
        changed(()->{try{invoke(access,"release",args().put("contextId",a));}catch(RuntimeException e){throw e;}catch(Exception e){throw new RuntimeException(e);}});
        access.require(b);
        for(ObjectNode bad:List.of(args(),args().putNull("contextId"),args().put("contextId",""),args().put("contextId",1),args().put("contextId",b).put("extra",true)))try{invoke(access,"release",bad);throw new AssertionError("invalid release argument accepted");}catch(IllegalArgumentException expected){}
        assert invoke(access,"prune",args()).path("removed").asInt()==0:"session context silently evicted";
        nativePrune();
        capacityTelemetry();
        releaseDuringRevisionRead();
        System.out.println("context access behavior verified");
    }
    static void capacityTelemetry()throws Exception {
        var access=access();String first="";
        for(int i=0;i<1024;i++) {
            var bound=bind(access,args());if(i==0)first=bound.path("contextId").asText();
            assert bound.path("usage").path("active").asInt()==i+1;
            if(i==921)assert bound.path("usage").path("warning").asBoolean();
        }
        try{bind(access,args());throw new AssertionError("native bind exceeded hard cap");}catch(ContextAccess.Conflict limit){assert limit.code.equals("CONTEXT_LIMIT") && limit.details.path("remaining").asInt()==0;}
        invoke(access,"release",args().put("contextId",first));
        var replacement=bind(access,args());assert !replacement.path("contextId").asText().equals(first);
        assert replacement.path("usage").path("active").asInt()==1024;
    }
    static void releaseDuringRevisionRead()throws Exception {
        var access=access();var projects=ProjectManager.getInstance();projects.projects.clear();
        var root=new WorkflowManager("0:1");projects.projects.put("p",new ProjectManager.Project(root));
        var bound=bind(access,args().put("projectId","p"));String id=bound.path("contextId").asText();
        ObjectNode precondition=args().put("contextId",id);precondition.set("expected",args().put("structure","s"));
        RevisionTracker.beforeRead=()->{try{invoke(access,"release",args().put("contextId",id));}catch(Exception e){throw new RuntimeException(e);}};
        try{access.validate(precondition,"core.execute",args().put("projectId","p"),List.of("structure"),true);throw new AssertionError("release during guard validation was missed");}catch(ContextAccess.Conflict expected){assert expected.code.equals("CONTEXT_CHANGED");}
        bound=bind(access,args().put("projectId","p"));String inspectedId=bound.path("contextId").asText();
        RevisionTracker.beforeRead=()->{try{invoke(access,"release",args().put("contextId",inspectedId));}catch(Exception e){throw new RuntimeException(e);}};
        try{access.inspect(inspectedId);throw new AssertionError("inspect returned authority released during revision read");}catch(ContextAccess.Conflict expected){assert expected.code.equals("CONTEXT_CHANGED");}
    }
    static void nativePrune()throws Exception {
        var access=access();var projects=ProjectManager.getInstance();projects.projects.clear();
        var root=new WorkflowManager("0:1");var scope=new WorkflowManager("0:1:2");root.nodes.add(scope);
        projects.projects.put("p",new ProjectManager.Project(root));
        var live=bind(access,args().put("projectId","p"));var nested=bind(access,args().put("projectId","p").put("workflowId",scope.getID().toString()));
        var session=bind(access,args());
        CountDownLatch locked=new CountDownLatch(1),release=new CountDownLatch(1);ExecutorService pool=Executors.newSingleThreadExecutor();
        try {
            var holder=pool.submit(()->{root.getReentrantLockInstance().lock();locked.countDown();try{release.await(10,TimeUnit.SECONDS);}catch(InterruptedException e){throw new RuntimeException(e);}finally{root.getReentrantLockInstance().unlock();}});
            assert locked.await(5,TimeUnit.SECONDS);
            long start=System.nanoTime();var skipped=invoke(access,"prune",args());
            assert skipped.path("removed").asInt()==0 && skipped.path("skipped").asInt()==2;
            assert System.nanoTime()-start<TimeUnit.SECONDS.toNanos(1):"prune blocked on native workflow lock";
            release.countDown();holder.get(5,TimeUnit.SECONDS);
        }finally{release.countDown();pool.shutdownNow();}
        projects.unavailable=true;assert invoke(access,"prune",args()).path("skipped").asInt()==2;projects.unavailable=false;
        root.nodes.clear();root.nodes.add(new WorkflowManager(scope.getID().toString()));
        assert invoke(access,"prune",args()).path("removed").asInt()==1;
        changed(()->access.require(nested.path("contextId").asText()));access.require(live.path("contextId").asText());
        projects.projects.put("p",new ProjectManager.Project(new WorkflowManager(root.getID().toString())));
        assert invoke(access,"prune",args()).path("removed").asInt()==1;
        changed(()->access.require(live.path("contextId").asText()));access.require(session.path("contextId").asText());
        var reopened=bind(access,args().put("projectId","p"));projects.projects.clear();
        assert invoke(access,"prune",args()).path("removed").asInt()==1;
        changed(()->access.require(reopened.path("contextId").asText()));
        assert invoke(access,"usage",args()).path("active").asInt()==1;
    }
}
