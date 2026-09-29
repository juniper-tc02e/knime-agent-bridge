package org.knime.agent;

import java.util.*;
import java.util.List;
import com.fasterxml.jackson.databind.JsonNode;
import org.eclipse.swt.SWT;
import org.eclipse.swt.widgets.*;

/** Bounded SWT observations and a single allowlisted load-warning acknowledgement. */
final class DesktopDialogs {
    private static final Map<Widget,String> IDS=new WeakHashMap<>();
    private static String id(Widget widget){return IDS.computeIfAbsent(widget,w->UUID.randomUUID().toString());}
    static Map<String,Object> inspect(Shell shell)throws Exception {
        Map<String,Object> out=new LinkedHashMap<>();out.put("dialogId",id(shell));out.put("title",shell.getText());
        boolean modal=(shell.getStyle()&(SWT.PRIMARY_MODAL|SWT.APPLICATION_MODAL|SWT.SYSTEM_MODAL))!=0;
        out.put("visible",shell.getVisible());out.put("enabled",shell.getEnabled());out.put("modal",modal);
        List<Map<String,Object>> controls=new ArrayList<>(),actions=new ArrayList<>();int[] budget={256,16000};
        if(modal&&shell.getVisible())walk(shell,controls,actions,budget,shell.getText().equals("Workflow Load"));
        boolean truncated=budget[0]<=0||budget[1]<=0;
        boolean detailsCollapsed=actions.stream().anyMatch(a->a.get("kind").equals("reveal-load-details"));
        if(detailsCollapsed)actions.removeIf(a->a.get("kind").equals("acknowledge-load-warning"));
        if(truncated)actions.clear();
        out.put("controls",controls);out.put("actions",actions);out.put("truncated",truncated);out.put("detailsCollapsed",detailsCollapsed);
        out.put("coverage","SWT labels, read-only text, instantiated tree/table items and buttons; editable fields and embedded browser content omitted");
        out.put("fingerprint",RevisionTracker.digest(BridgeActivator.JSON.valueToTree(out)));return out;
    }
    private static void text(Widget widget,String kind,String value,List<Map<String,Object>> controls,int[] budget) {
        if(budget[0]<=0||budget[1]<=0||value==null||value.isBlank())return;
        int length=Math.min(value.length(),budget[1]);budget[1]-=length;budget[0]--;
        controls.add(Map.of("controlId",id(widget),"kind",kind,"text",value.substring(0,length)));
    }
    private static void walk(Composite parent,List<Map<String,Object>> controls,List<Map<String,Object>> actions,int[] budget,boolean acknowledge) {
        for(Control control:parent.getChildren()) {
            if(control.isDisposed()||budget[0]<=0||budget[1]<=0)continue;
            // Hidden details are included when instantiated; this avoids requiring a Details click.
            if(control instanceof Label label)text(label,"label",label.getText(),controls,budget);
            else if(control instanceof Link link)text(link,"link",link.getText(),controls,budget);
            else if(control instanceof Text input&&(input.getStyle()&SWT.PASSWORD)==0&&(input.getStyle()&SWT.READ_ONLY)!=0)text(input,"read-only-text",input.getText(),controls,budget);
            else if(control instanceof Button button) {
                text(button,"button",button.getText(),controls,budget);
                if(acknowledge&&button.getEnabled()&&button.isVisible()&&button.getText().replace("&","").trim().equals("OK"))
                    actions.add(Map.of("actionId",id(button),"kind","acknowledge-load-warning","label",button.getText()));
                if(acknowledge&&button.getEnabled()&&button.isVisible()&&button.getText().replace("&","").trim().equals("Details >>"))
                    actions.add(Map.of("actionId",id(button),"kind","reveal-load-details","label",button.getText()));
            } else if(control instanceof org.eclipse.swt.widgets.List list) {
                for(String item:list.getItems())text(list,"list-item",item,controls,budget);
            } else if(control instanceof Tree tree)for(TreeItem item:tree.getItems())tree(item,controls,budget,0);
            else if(control instanceof Table table)for(TableItem item:table.getItems()) {
                if(budget[0]<=0||budget[1]<=0)break;
                for(int column=0;column<Math.max(1,table.getColumnCount());column++)text(item,"table-item",item.getText(column),controls,budget);
            }
            if(control instanceof Composite composite)walk(composite,controls,actions,budget,acknowledge);
        }
    }
    private static void tree(TreeItem item,List<Map<String,Object>> controls,int[] budget,int depth) {
        if(depth>32||budget[0]<=0||budget[1]<=0)return;
        for(int column=0;column<Math.max(1,item.getParent().getColumnCount());column++)text(item,"tree-item",item.getText(column),controls,budget);
        for(TreeItem child:item.getItems())tree(child,controls,budget,depth+1);
    }
    static Map<String,Object> dismiss(Display display,JsonNode args)throws Exception {
        for(Iterator<String> keys=args.fieldNames();keys.hasNext();)if(!Set.of("dialogId","fingerprint","actionId").contains(keys.next()))throw new IllegalArgumentException("Unknown dismissDialog argument");
        String dialogId=NativeTarget.required(args,"dialogId"),fingerprint=NativeTarget.required(args,"fingerprint"),actionId=NativeTarget.required(args,"actionId");
        for(Shell shell:display.getShells())if(!shell.isDisposed()&&id(shell).equals(dialogId)) {
            var state=inspect(shell);
            if(!fingerprint.equals(state.get("fingerprint")))throw new ContextAccess.Conflict("DIALOG_CHANGED","Dialog changed since inspection; read desktop.uiState again");
            JsonNode actions=BridgeActivator.JSON.valueToTree(state.get("actions"));
            String kind=null;for(JsonNode action:actions)if(action.path("actionId").asText().equals(actionId))kind=action.path("kind").asText();
            if(kind==null)throw new ContextAccess.Conflict("DIALOG_ACTION_NOT_ALLOWED","Only observed Workflow Load details/OK actions are supported; reveal collapsed details before acknowledgement");
            Button button=findButton(shell,actionId);if(button==null||!button.isEnabled()||!button.isVisible())throw new ContextAccess.Conflict("DIALOG_CHANGED","Dialog action is no longer available");
            Event event=new Event();event.widget=button;button.notifyListeners(SWT.Selection,event);
            boolean dismissed=shell.isDisposed()||!shell.getVisible();
            return Map.of("accepted",true,"completed",kind.equals("reveal-load-details")||dismissed,"dismissed",dismissed,"actionKind",kind,"dialogId",dialogId,"verification","Read desktop.uiState again. Acknowledgement does not repair the workflow; inspect node/settings errors before execution or saving");
        }
        throw new ContextAccess.Conflict("DIALOG_CHANGED","Observed dialog no longer exists");
    }
    private static Button findButton(Composite parent,String actionId) {
        for(Control control:parent.getChildren()) {
            if(control instanceof Button button&&id(button).equals(actionId))return button;
            if(control instanceof Composite nested){Button found=findButton(nested,actionId);if(found!=null)return found;}
        }return null;
    }
}
