package org.knime.agent;

import java.util.*;
import java.util.function.Consumer;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import com.fasterxml.jackson.databind.JsonNode;
import org.eclipse.swt.SWT;
import org.eclipse.swt.widgets.Display;
import org.eclipse.swt.widgets.Shell;
import org.eclipse.ui.PlatformUI;
import org.knime.gateway.impl.project.ProjectManager;
import org.knime.ui.java.api.DesktopAPI;

/** Narrow desktop adapter; KNIME remains responsible for each callback's threading. */
final class DesktopAccess {
    Object call(String operation,JsonNode args)throws Exception {
        return switch(operation) {
            case "desktop.describe" -> describe();
            case "desktop.functions" -> functions();
            case "desktop.uiState" -> uiState();
            case "desktop.dialogAction", "desktop.dismissDialog" -> dismissDialog(args);
            case "desktop.openProject" -> openProject(args);
            case "desktop.saveProject" -> saveProject(args);
            case "desktop.closeProject" -> closeProject(args);
            default -> throw new IllegalArgumentException("Unknown desktop operation: "+operation);
        };
    }
    static Object describe() {
        return Map.of("operations",List.of(
            Map.of("operation","desktop.describe","parameters",List.of(),"readOnly",true),
            Map.of("operation","desktop.functions","parameters",List.of(),"readOnly",true,"description","Lists installed callback names; only allowlisted operations can be invoked"),
            Map.of("operation","desktop.uiState","parameters",List.of(),"readOnly",true,"description","Bounded modal text, tree items and controlled acknowledgement actions with identity/fingerprint"),
            Map.of("operation","desktop.dialogAction","parameters",List.of(
                Map.of("name","dialogId","type","string","required",true),Map.of("name","fingerprint","type","string","required",true),Map.of("name","actionId","type","string","required",true)),
                "readOnly",false,"restriction","Only an unchanged inspected Workflow Load warning: reveal Details, then re-inspect and acknowledge OK. Never arbitrary dialogs/progress cancellation. desktop.dismissDialog is an alias."),
            Map.of("operation","desktop.openProject","parameters",List.of(
                Map.of("name","spaceId","type","string","required",true),
                Map.of("name","itemId","type","string","required",true),
                Map.of("name","spaceProviderId","type","string","required",true)),
                "readOnly",false,"completion","Asynchronous; accepted does not mean opened"),
            Map.of("operation","desktop.saveProject","parameters",List.of(
                Map.of("name","projectId","type","string","required",true)),
                "readOnly",false,"restriction","Already-loaded local projects only; no remote upload or Save As",
                "completion","Asynchronous; poll the root core.snapshot dirty flag and verify persisted content before closing"),
            Map.of("operation","desktop.closeProject","parameters",List.of(
                Map.of("name","projectId","type","string","required",true),
                Map.of("name","nextProjectId","type","string or null","required",false)),
                "readOnly",false,"completion","Asynchronous; rejects dirty projects. Save and verify before closing.")),
            "usage","Create with SpaceService.createWorkflow, then pass its returned item ID to desktop.openProject. Poll ApplicationService.getState and match the project's origin. General desktop callback invocation is not exposed.");
    }
    private static Map<String,Consumer<Object[]>> callbacks() {
        Map<String,Consumer<Object[]>> result=new LinkedHashMap<>();
        DesktopAPI.forEachAPIFunction(result::put); return result;
    }
    private static Object functions() {
        List<Object> result=new ArrayList<>();
        callbacks().keySet().stream().sorted().forEach(name->{
            Map<String,Object> function=new LinkedHashMap<>(); function.put("name",name);
            boolean allowed=name.equals("openProject") || name.equals("saveProject") || name.equals("closeProject");
            function.put("invocationAllowed",allowed);
            if(allowed) function.put("operation","desktop."+name);
            if(name.equals("closeProject")) function.put("restriction","Saved projects only; dirty projects are rejected");
            if(name.equals("saveProject")) function.put("restriction","Already-loaded local projects only; no remote upload or Save As");
            result.add(function);
        });
        return Map.of("functions",result,"modernUiReady",DesktopAPI.areDependenciesInjected(),"scope","Callback discovery does not enable arbitrary callback invocation");
    }
    private static Object saveProject(JsonNode args)throws Exception {
        String projectId=text(args,"projectId");
        if(!DesktopAPI.areDependenciesInjected()) throw new IllegalStateException("KNIME's modern UI is not initialized; open it first");
        requireUnblockedUi();
        ProjectManager projects=ProjectManager.getInstance();
        var project=projects.getProject(projectId).orElseThrow(()->new IllegalArgumentException("Unknown open project: "+projectId));
        if(project.getOrigin().isEmpty() || !project.getOrigin().get().isLocal()) {
            throw new IllegalArgumentException("desktop.saveProject supports verified local projects only. Saving a remote project can upload or overwrite remote content.");
        }
        if(project.getWorkflowManagerIfLoaded().isEmpty()) throw new IllegalArgumentException("Project is not loaded: "+projectId);
        var workflow=project.getWorkflowManagerIfLoaded().orElseThrow();
        try(var lock=workflow.lock()){OperationPolicy.apply();SettingsHealth.requireValid(workflow,false);}
        Consumer<Object[]> callback=callbacks().get("saveProject");
        if(callback==null) throw new IllegalStateException("This KNIME version does not expose saveProject");
        boolean dirty=Boolean.TRUE.equals(projects.getDirtyProjectsMap().get(projectId));
        // Exact public callback arguments: (String projectId, Boolean allowOverwritePrompt).
        // Restrict to local origin before disabling the remote overwrite prompt.
        callback.accept(new Object[]{projectId,Boolean.FALSE});
        return Map.of("accepted",true,"completed",false,"operation","desktop.saveProject","projectId",projectId,
            "dirtyAtRequest",dirty,"verification","Poll core.snapshot for this project's root dirty=false. If dirty remains true, inspect desktop.uiState and KNIME's error UI. Reopen and verify persisted content before claiming a complete round trip.");
    }
    private static Object closeProject(JsonNode args) {
        String projectId=text(args,"projectId");
        String nextProjectId=args.hasNonNull("nextProjectId")?text(args,"nextProjectId"):null;
        if(!DesktopAPI.areDependenciesInjected()) throw new IllegalStateException("KNIME's modern UI is not initialized; open it first");
        requireUnblockedUi();
        ProjectManager projects=ProjectManager.getInstance();
        if(projects.getProject(projectId).isEmpty()) throw new IllegalArgumentException("Unknown open project: "+projectId);
        if(Boolean.TRUE.equals(projects.getDirtyProjectsMap().get(projectId))) {
            throw new IllegalArgumentException("Project has unsaved changes. Save it with desktop.saveProject and verify it is clean before closing.");
        }
        if(nextProjectId!=null && (nextProjectId.equals(projectId) || projects.getProject(nextProjectId).isEmpty())) {
            throw new IllegalArgumentException("nextProjectId must identify another open project, or be null");
        }
        Consumer<Object[]> callback=callbacks().get("closeProject");
        if(callback==null) throw new IllegalStateException("This KNIME version does not expose closeProject");
        // Native close retains its own save protection if the user changes the workflow after this check.
        callback.accept(new Object[]{projectId,nextProjectId});
        return Map.of("accepted",true,"completed",false,"operation","desktop.closeProject","projectId",projectId,
            "verification","Poll ApplicationService.getState until this project is absent. Avoid simultaneous edits while closing; KNIME retains its save prompt if new changes occur.");
    }
    private static Object openProject(JsonNode args) {
        String spaceId=text(args,"spaceId"), itemId=text(args,"itemId"), providerId=text(args,"spaceProviderId");
        if(!DesktopAPI.areDependenciesInjected()) throw new IllegalStateException("KNIME's modern UI is not initialized; open it first");
        requireUnblockedUi();
        Consumer<Object[]> callback=callbacks().get("openProject");
        if(callback==null) throw new IllegalStateException("This KNIME version does not expose openProject");
        // KNIME schedules onto SWT. Do not wait on the SWT thread for completion.
        callback.accept(new Object[]{spaceId,itemId,providerId});
        return Map.of("accepted",true,"completed",false,"operation","desktop.openProject",
            "origin",Map.of("spaceId",spaceId,"itemId",itemId,"providerId",providerId),
            "verification","Poll ApplicationService.getState for a matching project origin. Errors after acceptance appear in KNIME's desktop UI; a timeout does not prove failure.");
    }
    private static String text(JsonNode args,String key) {
        JsonNode value=args.get(key);
        if(value==null || !value.isTextual() || value.asText().isBlank()) throw new IllegalArgumentException(key+" must be a nonempty string");
        return value.asText();
    }

    /** Safe for heartbeat use: never waits indefinitely for the SWT thread. */
    static Map<String,Object> uiState() {
        if(!PlatformUI.isWorkbenchRunning()) return Map.of("workbenchRunning",false,"responsive",false,"blocked",true,
            "reason","The Eclipse workbench has not started","shells",List.of());
        Display display=PlatformUI.getWorkbench().getDisplay();
        if(display.isDisposed()) return Map.of("workbenchRunning",false,"responsive",false,"blocked",true,
            "reason","The desktop display has been disposed","shells",List.of());
        if(Display.getCurrent()==display) return inspectShells(display);
        CompletableFuture<Map<String,Object>> result=new CompletableFuture<>();
        try {
            display.asyncExec(()->{
                if(result.isDone()) return;
                try { result.complete(inspectShells(display)); }
                catch(Throwable error) { result.completeExceptionally(error); }
            });
            return result.get(1500,TimeUnit.MILLISECONDS);
        } catch(InterruptedException error) {
            Thread.currentThread().interrupt(); result.cancel(false);
            return Map.of("workbenchRunning",true,"responsive",false,"blocked",true,"reason","UI status check interrupted","shells",List.of());
        } catch(Exception error) {
            result.cancel(false);
            return Map.of("workbenchRunning",true,"responsive",false,"blocked",true,
                "reason","UI status check did not complete: "+error.getClass().getSimpleName(),"shells",List.of());
        }
    }

    private static Map<String,Object> inspectShells(Display display) {
        List<Object> shells=new ArrayList<>(); List<String> blockingTitles=new ArrayList<>();
        for(Shell shell:display.getShells()) {
            if(shell.isDisposed()) continue;
            boolean modal=(shell.getStyle() & (SWT.PRIMARY_MODAL|SWT.APPLICATION_MODAL|SWT.SYSTEM_MODAL))!=0;
            boolean visible=shell.getVisible();
            try{shells.add(DesktopDialogs.inspect(shell));}
            catch(Exception error){shells.add(Map.of("title",shell.getText(),"visible",visible,"modal",modal,"inspectionError",error.getClass().getSimpleName()));}
            if(visible && modal) blockingTitles.add(shell.getText());
        }
        Shell active=display.getActiveShell();
        return Map.of("workbenchRunning",true,"responsive",true,"blocked",!blockingTitles.isEmpty(),
            "blockingShells",blockingTitles,"activeShellTitle",active==null?"":active.getText(),"shells",shells);
    }

    private static Object dismissDialog(JsonNode args)throws Exception {
        Display display=PlatformUI.getWorkbench().getDisplay();
        if(Display.getCurrent()==display)return DesktopDialogs.dismiss(display,args);
        CompletableFuture<Object> result=new CompletableFuture<>();
        display.asyncExec(()->{if(result.isDone())return;try{result.complete(DesktopDialogs.dismiss(display,args));}catch(Throwable failure){result.completeExceptionally(failure);}});
        try{return result.get(2000,TimeUnit.MILLISECONDS);}
        catch(java.util.concurrent.ExecutionException failure){if(failure.getCause() instanceof Exception cause)throw cause;throw failure;}
        catch(java.util.concurrent.TimeoutException failure){result.cancel(false);throw new IllegalStateException("Dialog acknowledgement outcome is unknown; inspect desktop.uiState before retrying",failure);}
        catch(InterruptedException failure){result.cancel(false);Thread.currentThread().interrupt();throw failure;}
    }

    private static void requireUnblockedUi() {
        Map<String,Object> state=uiState();
        if(Boolean.TRUE.equals(state.get("blocked"))) {
            throw new IllegalStateException("KNIME desktop is blocked: "+state.getOrDefault("blockingShells",state.get("reason"))
                +". Inspect desktop.uiState and resolve the dialog before retrying.");
        }
    }
}
