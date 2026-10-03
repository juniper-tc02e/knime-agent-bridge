package org.knime.core.node.workflow;
public class NodeContainer {
    public record ID(String value){@Override public String toString(){return value;}}
    private final ID id;
    public NodeContainer(String id){this.id=new ID(id);}
    public ID getID(){return id;}
}
