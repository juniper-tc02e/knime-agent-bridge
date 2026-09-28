package org.knime.agent;

import java.util.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.knime.core.node.NodeSettings;
import org.knime.core.node.config.base.*;

/** Lossless typed views and bounded edits of a native, detached settings envelope. */
final class SettingsCodec {
    private SettingsCodec() { }
    static boolean protectedKey(String key) {
        String k=key.toLowerCase(Locale.ROOT).replaceAll("[^a-z]", "");
        return k.contains("password") || k.contains("secret") || k.contains("credential")
            || k.contains("accesstoken") || k.contains("refreshtoken") || k.contains("privatekey") || k.equals("token");
    }
    private static boolean protectedEntry(AbstractConfigEntry e) {
        return protectedKey(e.getKey()) || e.getType()==ConfigEntries.xpassword || e.getType()==ConfigEntries.xtransientstring;
    }
    static ObjectNode encode(AbstractConfigEntry e) throws Exception {
        ObjectNode out=BridgeActivator.JSON.createObjectNode().put("key",e.getKey()).put("type",e.getType().name());
        if(protectedEntry(e)) return out.put("redacted",true).put("editable",false);
        if(e instanceof ConfigBase group) {
            ArrayNode entries=out.putArray("entries");
            for(String key:group.keySet()) entries.add(encode(group.getEntry(key)));
        } else {
            ConfigBase parent=(ConfigBase)e.getParent();String key=e.getKey();
            switch(e.getType()) {
                case xstring -> out.put("value",parent.getString(key));
                case xboolean -> out.put("value",parent.getBoolean(key));
                case xbyte -> out.put("value",parent.getByte(key));
                case xshort -> out.put("value",parent.getShort(key));
                case xint -> out.put("value",parent.getInt(key));
                case xlong -> out.put("value",Long.toString(parent.getLong(key)));
                case xfloat -> putFloating(out,parent.getFloat(key));
                case xdouble -> putFloating(out,parent.getDouble(key));
                case xchar -> out.put("value",String.valueOf(parent.getChar(key)));
                default -> out.put("editable",false).put("opaque",true);
            }
        }
        return out;
    }
    private static void putFloating(ObjectNode out,double value) {
        if(Double.isFinite(value))out.put("value",value);else out.put("value",Double.toString(value));
    }
    static void patch(NodeSettings settings,JsonNode patches) throws Exception {
        if(!patches.isArray() || patches.isEmpty() || patches.size()>1000)
            throw new IllegalArgumentException("patches must contain 1..1000 typed path edits");
        for(JsonNode patch:patches) {
            if(patch.has("createParents")&&!patch.get("createParents").isBoolean())throw new IllegalArgumentException("createParents must be a boolean");
            JsonNode path=patch.path("path");
            if(!path.isArray() || path.isEmpty() || path.size()>64)throw new IllegalArgumentException("Each path must be an array of 1..64 keys");
            ConfigBase parent=settings;
            for(int i=0;i<path.size();i++) {
                if(!path.get(i).isTextual() || path.get(i).asText().isEmpty())throw new IllegalArgumentException("Path keys must be nonempty strings");
                String key=path.get(i).asText();
                if(protectedKey(key))throw new IllegalArgumentException("Protected settings cannot be edited");
                if(i<path.size()-1) {
                    AbstractConfigEntry group=parent.getEntry(key);
                    if(group==null && patch.path("createParents").asBoolean(false))group=parent.addConfigBase(key);
                    if(!(group instanceof ConfigBase))throw new IllegalArgumentException("Settings group does not exist: "+key);
                    parent=(ConfigBase)group;
                }
            }
            String key=path.get(path.size()-1).asText();
            AbstractConfigEntry existing=parent.getEntry(key);
            if(existing!=null && protectedEntry(existing))throw new IllegalArgumentException("Protected settings cannot be edited");
            String type=patch.path("type").asText(existing==null?"":existing.getType().name());
            if(!patch.has("value"))throw new IllegalArgumentException("Each patch requires value");
            if(existing!=null && !type.endsWith("Array") && !existing.getType().name().equals(type))
                throw new IllegalArgumentException("Type mismatch at "+key+": expected "+existing.getType().name());
            JsonNode value=patch.get("value");
            if(type.endsWith("Array")) {
                if(!value.isArray())throw new IllegalArgumentException("Array value required at "+key);
                if(existing!=null && !(existing instanceof ConfigBase))throw new IllegalArgumentException("Cannot replace a scalar with an array");
                if(existing instanceof ConfigBase group)validateArrayGroup(group,type);
                // Native add*Array methods retain KNIME's size/type representation.
                switch(type) {
                    case "stringArray" -> {String[] a=new String[value.size()];for(int i=0;i<a.length;i++)a[i]=string(value.get(i),true);parent.addStringArray(key,a);}
                    case "intArray" -> {int[] a=new int[value.size()];for(int i=0;i<a.length;i++)a[i]=(int)integer(value.get(i),Integer.MIN_VALUE,Integer.MAX_VALUE);parent.addIntArray(key,a);}
                    case "longArray" -> {long[] a=new long[value.size()];for(int i=0;i<a.length;i++)a[i]=integer(value.get(i),Long.MIN_VALUE,Long.MAX_VALUE);parent.addLongArray(key,a);}
                    case "doubleArray" -> {double[] a=new double[value.size()];for(int i=0;i<a.length;i++)a[i]=floating(value.get(i));parent.addDoubleArray(key,a);}
                    case "booleanArray" -> {boolean[] a=new boolean[value.size()];for(int i=0;i<a.length;i++)a[i]=bool(value.get(i));parent.addBooleanArray(key,a);}
                    default -> throw new IllegalArgumentException("Unsupported array type: "+type);
                }
            } else switch(type) {
                case "xstring" -> parent.addString(key,string(value,true));
                case "xboolean" -> parent.addBoolean(key,bool(value));
                case "xbyte" -> parent.addByte(key,(byte)integer(value,Byte.MIN_VALUE,Byte.MAX_VALUE));
                case "xshort" -> parent.addShort(key,(short)integer(value,Short.MIN_VALUE,Short.MAX_VALUE));
                case "xint" -> parent.addInt(key,(int)integer(value,Integer.MIN_VALUE,Integer.MAX_VALUE));
                case "xlong" -> parent.addLong(key,integer(value,Long.MIN_VALUE,Long.MAX_VALUE));
                case "xdouble" -> parent.addDouble(key,floating(value));
                case "xfloat" -> {double d=floating(value);if(Double.isFinite(d)&&Math.abs(d)>Float.MAX_VALUE)throw new IllegalArgumentException("Float out of range");parent.addFloat(key,(float)d);}
                case "xchar" -> {String s=string(value,false);if(s.length()!=1)throw new IllegalArgumentException("xchar requires one UTF-16 character");parent.addChar(key,s.charAt(0));}
                default -> throw new IllegalArgumentException("Unsupported or protected settings type: "+type);
            }
        }
    }
    private static void validateArrayGroup(ConfigBase group,String type) {
        // Array setters must never erase arbitrary subtrees (which may include protected values).
        String expected=switch(type) {case "stringArray"->"xstring";case "intArray"->"xint";case "longArray"->"xlong";case "doubleArray"->"xdouble";case "booleanArray"->"xboolean";default->"";};
        for(String key:group.keySet()) {
            AbstractConfigEntry entry=group.getEntry(key);
            if(protectedEntry(entry))throw new IllegalArgumentException("Protected settings cannot be replaced");
            if(key.equals("array-size")&&entry.getType()==ConfigEntries.xint)continue;
            if(!key.matches("[0-9]+")||!entry.getType().name().equals(expected))
                throw new IllegalArgumentException("Only a native primitive array group of the same type can be replaced by "+type);
        }
        if(!group.keySet().isEmpty()&&!group.containsKey("array-size"))
            throw new IllegalArgumentException("Only native array groups can be replaced with an array setter");
    }
    private static String string(JsonNode n,boolean nullable) {
        if(nullable&&n.isNull())return null;
        if(!n.isTextual())throw new IllegalArgumentException("Expected string value");return n.asText();
    }
    private static boolean bool(JsonNode n) {
        if(!n.isBoolean())throw new IllegalArgumentException("Expected boolean value");return n.booleanValue();
    }
    private static long integer(JsonNode n,long min,long max) {
        if(!n.isIntegralNumber()&&!n.isTextual())throw new IllegalArgumentException("Expected integer or decimal integer string");
        final long v;try{v=Long.parseLong(n.asText());}catch(NumberFormatException e){throw new IllegalArgumentException("Invalid integer value");}
        if(v<min||v>max)throw new IllegalArgumentException("Integer value outside type range");return v;
    }
    private static double floating(JsonNode n) {
        if(n.isNumber()) {double value=n.doubleValue();if(!Double.isFinite(value))throw new IllegalArgumentException("Numeric value overflows double range; use an explicit special-value string if intended");return value;}
        if(n.isTextual()&&Set.of("NaN","Infinity","-Infinity").contains(n.asText()))return Double.parseDouble(n.asText());
        throw new IllegalArgumentException("Expected number, NaN, Infinity, or -Infinity");
    }
}
