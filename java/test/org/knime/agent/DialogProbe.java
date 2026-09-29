package org.knime.agent;
import org.eclipse.swt.SWT;
import org.eclipse.swt.widgets.*;
public final class DialogProbe {
 public static void main(String[] args)throws Exception {
  Display display=new Display();try {
   Shell dialog=new Shell(display,SWT.APPLICATION_MODAL|SWT.DIALOG_TRIM);dialog.setText("Workflow Load");
   Label message=new Label(dialog,SWT.NONE);message.setText("Loading model settings failed: splitCriterion missing");message.setBounds(10,10,450,25);
   Text secret=new Text(dialog,SWT.PASSWORD);secret.setText("do-not-export-password");
   Button ok=new Button(dialog,SWT.PUSH);ok.setText("OK");ok.setBounds(10,50,70,25);ok.addListener(SWT.Selection,event->dialog.dispose());dialog.setSize(480,140);dialog.open();dialog.setVisible(false);dialog.setVisible(true);while(display.readAndDispatch()){}
   var before=DesktopDialogs.inspect(dialog);String json=BridgeActivator.JSON.writeValueAsString(before);
   if(!json.contains("splitCriterion")||json.contains("do-not-export-password"))throw new AssertionError("Missing warning or leaked editable field: "+json);
   var buttons=BridgeActivator.JSON.valueToTree(before).path("actions");if(buttons.size()!=1)throw new AssertionError("Missing controlled acknowledgement");
   var request=BridgeActivator.JSON.createObjectNode().put("dialogId",before.get("dialogId").toString()).put("fingerprint",before.get("fingerprint").toString()).put("actionId",buttons.get(0).path("actionId").asText());
   message.setText("Different warning");try{DesktopDialogs.dismiss(display,request);throw new AssertionError("Stale dialog acknowledged");}catch(ContextAccess.Conflict expected){}
   var refreshed=DesktopDialogs.inspect(dialog);request.put("fingerprint",refreshed.get("fingerprint").toString());DesktopDialogs.dismiss(display,request);
   if(!dialog.isDisposed())throw new AssertionError("Acknowledgement was not delivered");
   Shell dangerous=new Shell(display,SWT.APPLICATION_MODAL|SWT.DIALOG_TRIM);dangerous.setText("Confirm overwrite");new Button(dangerous,SWT.PUSH).setText("OK");dangerous.setVisible(true);
   if(BridgeActivator.JSON.valueToTree(DesktopDialogs.inspect(dangerous)).path("actions").size()!=0)throw new AssertionError("Dangerous dialog exposed");dangerous.dispose();
   System.out.println("dialog-probe passed");
  } finally {display.dispose();}
 }
}
