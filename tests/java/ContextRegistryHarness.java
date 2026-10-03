package org.knime.agent;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Runs the actual registry; replacing atomic insertion or conditional cleanup breaks these assertions. */
public final class ContextRegistryHarness {
    record Model(Object root,Object scope){}
    public static void main(String[] args)throws Exception {
        capacityAndWarning();
        independentBindingsAndRelease();
        concurrentCapacity();
        conservativePrune();
        cleanupDoesNotHoldRegistryLock();
        System.out.println("context lifecycle behavior verified");
    }
    static void capacityAndWarning() {
        var r=new ContextRegistry<String>();
        assert r.usage().active()==0 && r.usage().remaining()==1024;
        for(int i=0;i<921;i++)r.bind(id->id);
        assert !r.usage().warning();
        r.bind(id->id);
        assert r.usage().warning() && r.usage().remaining()==102;
        for(int i=922;i<1024;i++)r.bind(id->id);
        assert r.usage().active()==1024 && r.usage().remaining()==0;
        AtomicBoolean constructed=new AtomicBoolean();
        try {r.bind(id->{constructed.set(true);return id;});throw new AssertionError("cap accepted a 1025th binding");}
        catch(ContextRegistry.Capacity expected) {assert expected.usage().active()==1024;}
        assert !constructed.get():"capacity rejection must precede constructing a new binding";
    }
    static void independentBindingsAndRelease() {
        var r=new ContextRegistry<Model>();var model=new Model(new Object(),new Object());
        var a=r.bind(id->model);var b=r.bind(id->model);
        assert !a.id().equals(b.id()):"bindings must not deduplicate clients";
        assert UUID.fromString(a.id()).version()==4;
        assert UUID.fromString(a.id()).variant()==2;
        assert r.release(a.id())==model;
        assert r.get(a.id())==null:"released ID still authorizes access";
        assert r.release(a.id())==null && r.release("unknown")==null;
        assert r.get(b.id())==model:"one client's release invalidated another client's context";
        Set<String> ids=new HashSet<>(List.of(a.id(),b.id()));
        for(int i=0;i<3000;i++) {var next=r.bind(id->model);assert ids.add(next.id()):"released UUID reused";r.release(next.id());}
        assert r.usage().active()==1;
        for(int i=1;i<1024;i++)r.bind(id->model);
        r.release(b.id());var replacement=r.bind(id->model);
        assert !replacement.id().equals(b.id()) && r.usage().remaining()==0;
    }
    static void concurrentCapacity()throws Exception {
        var r=new ContextRegistry<String>();ExecutorService pool=Executors.newFixedThreadPool(32);
        CountDownLatch start=new CountDownLatch(1);AtomicInteger accepted=new AtomicInteger(),rejected=new AtomicInteger();
        List<Future<?>> tasks=new ArrayList<>();
        try {
            for(int n=0;n<32;n++)tasks.add(pool.submit(()->{
                try {start.await();}catch(InterruptedException e){throw new RuntimeException(e);}
                for(int i=0;i<64;i++)try{r.bind(id->id);accepted.incrementAndGet();}catch(ContextRegistry.Capacity full){rejected.incrementAndGet();}
            }));
            start.countDown();for(var task:tasks)task.get(10,TimeUnit.SECONDS);
            assert accepted.get()==1024 && rejected.get()==1024 && r.usage().active()==1024:"cap raced under concurrent binds";
        }finally{pool.shutdownNow();}
    }
    static void conservativePrune() {
        var r=new ContextRegistry<String>();var alive=r.bind(id->"alive");var closed=r.bind(id->"closed");var replaced=r.bind(id->"replaced");var locked=r.bind(id->"locked");var error=r.bind(id->"error");
        var result=r.prune(value->switch(value){case "closed","replaced"->ContextRegistry.Validity.INVALID;case "locked"->ContextRegistry.Validity.UNKNOWN;case "error"->throw new IllegalStateException("cannot observe model");default->ContextRegistry.Validity.VALID;});
        assert result.removedIds().equals(List.of(closed.id(),replaced.id()));
        assert result.checked()==5 && result.retained()==1 && result.skipped()==2;
        assert r.get(alive.id())!=null && r.get(locked.id())!=null && r.get(error.id())!=null;
        assert r.get(closed.id())==null && r.get(replaced.id())==null && r.usage().active()==3;
        assert r.prune(v->ContextRegistry.Validity.VALID).removedIds().isEmpty():"prune evicted live models";
    }
    static void cleanupDoesNotHoldRegistryLock()throws Exception {
        var r=new ContextRegistry<String>();var a=r.bind(id->"old");
        CountDownLatch observed=new CountDownLatch(1),resume=new CountDownLatch(1);ExecutorService pool=Executors.newSingleThreadExecutor();
        try {
            var pending=pool.submit(()->r.prune(value->{observed.countDown();try{resume.await(10,TimeUnit.SECONDS);}catch(InterruptedException e){throw new RuntimeException(e);}return ContextRegistry.Validity.INVALID;}));
            assert observed.await(5,TimeUnit.SECONDS);
            assert r.release(a.id()).equals("old"):"cleanup blocks explicit release";
            var b=r.bind(id->"new");resume.countDown();var result=pending.get(5,TimeUnit.SECONDS);
            assert result.removedIds().isEmpty() && r.get(b.id()).equals("new"):"stale cleanup removed a new binding";
        }finally{resume.countDown();pool.shutdownNow();}
    }
}
