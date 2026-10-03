package org.knime.core.node;

/** Detached settings tests only: KNIME's logger requires the OSGi application runtime. */
public final class NodeLogger {
    public static NodeLogger getLogger(Class<?> type){return new NodeLogger();}
    public static NodeLogger getLogger(String name){return new NodeLogger();}
    public void warn(Object message){throw new AssertionError("Unexpected native settings warning: "+message);}
    public void debug(Object message){}
    public void debug(Object message,Throwable error){}
}
