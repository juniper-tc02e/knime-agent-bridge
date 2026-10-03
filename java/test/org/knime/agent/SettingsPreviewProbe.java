package org.knime.agent;

import java.util.*;
import com.fasterxml.jackson.databind.JsonNode;
import org.knime.core.node.NodeSettings;

/** Detached native settings tests; never opens or mutates a workflow. */
public final class SettingsPreviewProbe {
    interface Checked {void run()throws Exception;}
    static int assertions;
    static void check(boolean value,String message){assertions++;if(!value)throw new AssertionError(message);}
    static void rejected(Checked action,String message)throws Exception {
        try{action.run();}catch(IllegalArgumentException expected){assertions++;return;}throw new AssertionError(message);
    }
    static JsonNode json(String source)throws Exception{return BridgeActivator.JSON.readTree(source);}
    static NodeSettings fixture() {
        NodeSettings envelope=new NodeSettings("configuration"),model=new NodeSettings("model");envelope.addNodeSettings(model);
        model.addInt("count",3);model.addString("label","");model.addLong("seed",9007199254740993L);
        model.addStringArray("labels",new String[]{"alpha","",null});model.addDouble("rate",Double.NaN);
        model.addString("password","unchanged-protected-value");
        model.addEncryptedPassword("hiddenEncrypted","encrypted-sentinel");model.addTransientString("hiddenTransient","transient-sentinel");
        envelope.addNodeSettings("view").addString("text","preserved");return envelope;
    }
    public static void main(String[] args)throws Exception {
        // This first regression fails against the old codec, which silently ignores fields.
        rejected(()->SettingsCodec.patch(fixture(),json("[{\"path\":[\"model\",\"count\"],\"value\":4,\"typo\":true}]")),"Unknown patch field accepted");
        rejected(()->SettingsCodec.patch(fixture(),json("[{\"path\":[\"model\",\"count\"],\"value\":4},{\"path\":[\"model\",\"count\"],\"value\":5}]")),"Duplicate path accepted");
        rejected(()->SettingsCodec.patch(fixture(),json("[{\"path\":[\"model\",\"labels\"],\"type\":\"stringArray\",\"value\":[]},{\"path\":[\"model\",\"labels\",\"0\"],\"type\":\"xstring\",\"value\":\"bad\"}]")),"Overlapping edits accepted");
        rejected(()->SettingsCodec.patch(fixture(),json("[{\"path\":[\"model\",\"count\"],\"type\":\"xdouble\",\"value\":4}]")),"Existing scalar type changed");
        rejected(()->SettingsCodec.patch(fixture(),json("[{\"path\":[\"model\",\"new\"],\"value\":4}]")),"New key without type accepted");
        rejected(()->SettingsCodec.patch(fixture(),json("[{\"path\":[\"model\",\"count\"],\"type\":null,\"value\":4}]")),"Null type silently inferred");
        rejected(()->SettingsCodec.patch(fixture(),json("[{\"path\":[\"missing\",\"value\"],\"type\":\"xstring\",\"value\":\"x\"}]")),"Missing parent implicitly created");
        rejected(()->SettingsCodec.patch(fixture(),json("[{\"path\":[\"model\",\"password\"],\"value\":\"bad\"}]")),"Protected entry changed");
        rejected(()->SettingsCodec.patch(fixture(),json("[{\"path\":[\"model\",\"seed\"],\"value\":9007199254740993}]")),"Numeric xlong accepted");
        rejected(()->SettingsCodec.patch(fixture(),json("[{\"path\":[\"model\",\"labels\"],\"type\":\"intArray\",\"value\":[]}]")),"Array element type changed");
        NodeSettings emptyGroup=fixture();emptyGroup.getNodeSettings("model").addStringArray("nullArray",(String[])null);
        var emptyPrepared=SettingsPreview.prepare(emptyGroup,json("[{\"path\":[\"model\",\"nullArray\"],\"type\":\"stringArray\",\"value\":[]}]"));
        check(emptyPrepared.diff().get(0).path("arrayElementTypeCoverage").asText().startsWith("unknown"),"Null array ambiguity hidden");
        check(emptyGroup.getNodeSettings("model").getStringArray("nullArray")==null,"Null source array lost");
        check(emptyPrepared.settings().getNodeSettings("model").getStringArray("nullArray").length==0,"Empty candidate array lost");
        NodeSettings malformed=fixture();malformed.getNodeSettings("model").getNodeSettings("labels").addInt("array-size",99);
        rejected(()->SettingsCodec.patch(malformed,json("[{\"path\":[\"model\",\"labels\"],\"type\":\"stringArray\",\"value\":[]}]")),"Malformed array shape erased");
        NodeSettings original=fixture();JsonNode before=SettingsCodec.encode(original);
        JsonNode edits=json("[{\"path\":[\"model\",\"label\"],\"value\":null},{\"path\":[\"model\",\"seed\"],\"value\":\"9223372036854775807\"},{\"path\":[\"model\",\"labels\"],\"type\":\"stringArray\",\"value\":[null,\"\",\"beta\"]},{\"path\":[\"model\",\"rate\"],\"value\":\"Infinity\"},{\"path\":[\"newGroup\",\"value\"],\"type\":\"xint\",\"value\":7,\"createParents\":true}]");
        var prepared=SettingsPreview.prepare(original,edits);
        check(before.equals(SettingsCodec.encode(original)),"Preparation altered original full envelope");
        NodeSettings candidate=prepared.settings();
        check(candidate.getNodeSettings("model").getString("label")==null,"Null string collapsed into empty");
        check(candidate.getNodeSettings("model").getLong("seed")==Long.MAX_VALUE,"Long precision lost");
        check(Arrays.equals(candidate.getNodeSettings("model").getStringArray("labels"),new String[]{null,"","beta"}),"Native array distinctions lost");
        check(candidate.getNodeSettings("model").getDouble("rate")==Double.POSITIVE_INFINITY,"Special float lost");
        check(candidate.getNodeSettings("newGroup").getInt("value")==7,"Explicit new parent failed");
        check(candidate.getNodeSettings("model").getString("password").equals("unchanged-protected-value"),"Protected native value lost");
        check(((org.knime.core.node.config.base.ConfigPasswordEntry)candidate.getNodeSettings("model").getEntry("hiddenEncrypted")).getPassword().equals("encrypted-sentinel"),"Encrypted password value lost");
        check(candidate.getNodeSettings("model").getTransientString("hiddenTransient").equals("transient-sentinel"),"Transient native value lost");
        check(original.getNodeSettings("model").getEntry("count").getParent()==original.getNodeSettings("model"),"Original scalar reparented");
        check(original.getNodeSettings("model").getEntry("hiddenEncrypted").getParent()==original.getNodeSettings("model"),"Protected scalar reparented");
        check(candidate.getNodeSettings("view").getString("text").equals("preserved"),"Unedited view lost");
        check(prepared.diff().size()==5&&prepared.changedFields()==5,"Incorrect typed field diff");
        check(!prepared.diff().toString().contains("unchanged-protected-value"),"Protected secret leaked in diff");
        check(prepared.diff().get(0).path("before").path("value").asText().equals("")&&prepared.diff().get(0).path("after").path("value").isNull(),"Diff collapsed empty and missing");
        check(prepared.diff().get(1).path("after").path("value").asText().equals("9223372036854775807"),"Diff long is not decimal string");
        check(candidate.getNodeSettings("model").getEntry("hiddenEncrypted")!=original.getNodeSettings("model").getEntry("hiddenEncrypted"),"Protected scalar aliased");
        var noop=SettingsPreview.prepare(original,json("[{\"path\":[\"model\",\"count\"],\"value\":3}]"));
        check(noop.changedFields()==0&&!noop.diff().get(0).path("changed").asBoolean(),"No-op diff reported a change");
        for(int i=0;i<64;i++) {
            int value=new Random(i).nextInt();
            var result=SettingsPreview.prepare(original,json("[{\"path\":[\"model\",\"count\"],\"value\":"+value+"}]"));
            check(result.settings().getNodeSettings("model").getInt("count")==value,"Generated int roundtrip failed");
            check(before.equals(SettingsCodec.encode(original)),"Generated patch mutated original");
        }
        for(String value:List.of("2147483648","-2147483649","1.5","true","null","\"invalid\""))
            rejected(()->SettingsPreview.prepare(original,json("[{\"path\":[\"model\",\"count\"],\"value\":"+value+"}]")),"Invalid generated int accepted: "+value);
        check(before.equals(SettingsCodec.encode(original)),"Rejected preparation altered source");
        System.out.println("settings-preview-probe assertions="+assertions+"; runtime-model-proof=false");
    }
}
