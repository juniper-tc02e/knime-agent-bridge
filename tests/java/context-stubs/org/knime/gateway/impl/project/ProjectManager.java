package org.knime.gateway.impl.project;
import java.util.*;
import java.util.concurrent.*;
import org.knime.core.node.workflow.WorkflowManager;
public final class ProjectManager {
    private static final ProjectManager INSTANCE=new ProjectManager();
    public static ProjectManager getInstance(){return INSTANCE;}
    public final Map<String,Project> projects=new ConcurrentHashMap<>();
    public boolean unavailable;
    public Optional<Project> getProject(String id){if(unavailable)throw new IllegalStateException("lookup unavailable");return Optional.ofNullable(projects.get(id));}
    public boolean isActiveProject(String id){return projects.containsKey(id);}
    public record Origin(String providerId,String spaceId,String itemId){}
    public record Project(WorkflowManager root){
        public Optional<WorkflowManager> getWorkflowManagerIfLoaded(){return Optional.ofNullable(root);}
        public Optional<Origin> getOrigin(){return Optional.empty();}
    }
}
