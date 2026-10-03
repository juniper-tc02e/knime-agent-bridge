package org.knime.core.node.workflow;
import java.util.*;
import java.util.concurrent.locks.ReentrantLock;
public class WorkflowManager extends NodeContainer {
    private final ReentrantLock lock=new ReentrantLock();
    public final List<NodeContainer> nodes=new ArrayList<>();
    public WorkflowManager(String id){super(id);}
    public Collection<NodeContainer> getNodeContainers(){return nodes;}
    public ReentrantLock getReentrantLockInstance(){return lock;}
    public boolean isDirty(){return false;}
    public AutoCloseable lock(){lock.lock();return ()->lock.unlock();}
}
