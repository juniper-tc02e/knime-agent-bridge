package org.knime.agent;

import java.util.*;
import java.util.function.Function;

/** Bounded native authority only. Historical client evidence has a separate lifecycle. */
final class ContextRegistry<T> {
    static final int CAP=1024;
    static final int WARNING_AT=922;
    enum Validity {VALID,INVALID,UNKNOWN}
    record Entry<T>(String id,T value){}
    record Usage(int active,int cap,int remaining,int warningAt,boolean warning){}
    record Pruned(List<String> removedIds,int checked,int retained,int skipped){}
    static final class Capacity extends IllegalStateException {
        private final Usage usage;
        Capacity(Usage usage){super("Context limit reached (1024 per session); explicitly release or prune invalid contexts");this.usage=usage;}
        Usage usage(){return usage;}
    }
    private final Map<String,T> entries=new LinkedHashMap<>();
    // The fixed random UUID prefix and monotonic 62-bit suffix never repeat in this registry.
    // This avoids an unbounded tombstone set while still returning RFC 4122 version 4 IDs.
    private final long namespace=UUID.randomUUID().getMostSignificantBits();
    private long sequence;
    synchronized Entry<T> bind(Function<String,T> create) {
        if(entries.size()>=CAP)throw new Capacity(usage());
        if(sequence==0x3fffffffffffffffL)throw new IllegalStateException("Context identity sequence exhausted; restart the session");
        String id=new UUID(namespace,0x8000000000000000L|sequence++).toString();
        T value=Objects.requireNonNull(create.apply(id));
        entries.put(id,value);return new Entry<>(id,value);
    }
    synchronized T get(String id){return entries.get(id);}
    synchronized T release(String id){return entries.remove(id);}
    synchronized Usage usage(){int count=entries.size();return new Usage(count,CAP,CAP-count,WARNING_AT,count>=WARNING_AT);}
    private synchronized List<Entry<T>> snapshot(){return entries.entrySet().stream().map(e->new Entry<>(e.getKey(),e.getValue())).toList();}
    private synchronized boolean removeIfSame(Entry<T> entry) {
        if(entries.get(entry.id())!=entry.value())return false;
        entries.remove(entry.id());return true;
    }
    Pruned prune(Function<T,Validity> observe) {
        List<String> removed=new ArrayList<>();int checked=0,retained=0,skipped=0;
        // Never hold the registry monitor during model lookup/locking: release stays cheap
        // and workflow-lock -> registry-lock guards cannot deadlock with cleanup.
        for(var entry:snapshot()) {
            checked++;Validity validity;
            try{validity=observe.apply(entry.value());}catch(RuntimeException unavailable){validity=Validity.UNKNOWN;}
            if(validity==Validity.INVALID){if(removeIfSame(entry))removed.add(entry.id());}
            else if(validity==Validity.VALID)retained++;
            else skipped++;
        }
        return new Pruned(List.copyOf(removed),checked,retained,skipped);
    }
}
