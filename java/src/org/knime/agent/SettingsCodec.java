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
    static NodeSettings detachedCopy(NodeSettings original)throws Exception {
        NodeSettings candidate=new NodeSettings(original.getKey());copyEntries(original,candidate);return candidate;
    }
    private static void copyEntries(ConfigBase source,ConfigBase target)throws Exception {
        // ConfigBase.copyTo shares scalar entries and changes their parent pointers in KNIME 5.12.
        // XML/Java serialization would also lose transient strings. Copy every native entry instead.
        for(String key:source.keySet()) {
            AbstractConfigEntry entry=source.getEntry(key);
            if(entry instanceof ConfigBase group) {copyEntries(group,target.addConfigBase(key));continue;}
            switch(entry.getType()) {
                case xstring -> target.addString(key,source.getString(key));
                case xboolean -> target.addBoolean(key,source.getBoolean(key));
                case xbyte -> target.addByte(key,source.getByte(key));
                case xshort -> target.addShort(key,source.getShort(key));
                case xint -> target.addInt(key,source.getInt(key));
                case xlong -> target.addLong(key,source.getLong(key));
                case xfloat -> target.addFloat(key,source.getFloat(key));
                case xdouble -> target.addDouble(key,source.getDouble(key));
                case xchar -> target.addChar(key,source.getChar(key));
                // The encrypted representation is copied directly; no decryption is requested.
                case xpassword -> target.addEntry(new ConfigPasswordEntry(key,((ConfigPasswordEntry)entry).getPassword()));
                case xtransientstring -> target.addEntry(new ConfigTransientStringEntry(key,((ConfigTransientStringEntry)entry).getTransientString()));
                default -> throw new IllegalArgumentException("Unsupported native settings entry prevents detached copy: "+entry.getType().name());
            }
        }
    }
    static void patch(NodeSettings settings,JsonNode patches) throws Exception {
        validatePatches(patches);
        for(JsonNode patch:patches) {
            JsonNode path=patch.path("path");
            ConfigBase parent=settings;
            for(int i=0;i<path.size()-1;i++) {
                String key=path.get(i).asText();
                AbstractConfigEntry group=parent.getEntry(key);
                if(group!=null&&protectedEntry(group))throw new IllegalArgumentException("Protected settings cannot be edited");
                if(group==null && patch.path("createParents").asBoolean(false))group=parent.addConfigBase(key);
                if(!(group instanceof ConfigBase))throw new IllegalArgumentException("Settings group does not exist: "+key);
                parent=(ConfigBase)group;
            }
            String key=path.get(path.size()-1).asText();
            AbstractConfigEntry existing=parent.getEntry(key);
            if(existing!=null && protectedEntry(existing))throw new IllegalArgumentException("Protected settings cannot be edited");
            String type=patch.path("type").asText(existing==null?"":existing.getType().name());
            if(existing!=null && !type.endsWith("Array") && !existing.getType().name().equals(type))
                throw new IllegalArgumentException("Type mismatch at "+key+": expected "+existing.getType().name());
            apply(parent,key,existing,type,patch.get("value"));
        }
    }
    static void validatePatches(JsonNode patches) {
        if(!patches.isArray() || patches.isEmpty() || patches.size()>1000)
            throw new IllegalArgumentException("patches must contain 1..1000 typed path edits");
        List<List<String>> paths=new ArrayList<>();
        Set<String> types=Set.of("xstring","xboolean","xbyte","xshort","xint","xlong","xfloat","xdouble","xchar",
            "stringArray","booleanArray","intArray","longArray","doubleArray");
        for(JsonNode patch:patches) {
            if(!patch.isObject())throw new IllegalArgumentException("Each patch must be an object");
            for(Iterator<String> keys=patch.fieldNames();keys.hasNext();) {
                String key=keys.next();if(!Set.of("path","type","value","createParents").contains(key))
                    throw new IllegalArgumentException("Unknown settings patch field: "+key);
            }
            if(!patch.has("value"))throw new IllegalArgumentException("Each patch requires value");
            if(patch.has("type")&&(!patch.get("type").isTextual()||!types.contains(patch.get("type").asText())))
                throw new IllegalArgumentException("Unsupported or protected settings type");
            if(patch.has("createParents")&&!patch.get("createParents").isBoolean())throw new IllegalArgumentException("createParents must be a boolean");
            JsonNode path=patch.path("path");
            if(!path.isArray() || path.isEmpty() || path.size()>64)throw new IllegalArgumentException("Each path must be an array of 1..64 keys");
            List<String> keys=new ArrayList<>();
            for(int i=0;i<path.size();i++) {
                if(!path.get(i).isTextual() || path.get(i).asText().isEmpty())throw new IllegalArgumentException("Path keys must be nonempty strings");
                String key=path.get(i).asText();
                if(protectedKey(key))throw new IllegalArgumentException("Protected settings cannot be edited");
                keys.add(key);
            }
            for(List<String> previous:paths) {
                int common=Math.min(previous.size(),keys.size());
                if(previous.subList(0,common).equals(keys.subList(0,common)))
                    throw new IllegalArgumentException("Duplicate or overlapping settings patch paths are not allowed");
            }
            paths.add(keys);
        }
    }
    private static void apply(ConfigBase parent,String key,AbstractConfigEntry existing,String type,JsonNode value)throws Exception {
            if(type.endsWith("Array")) {
                if(!value.isArray())throw new IllegalArgumentException("Array value required at "+key);
                if(existing!=null && !(existing instanceof ConfigBase))throw new IllegalArgumentException("Cannot replace a scalar with an array");
                if(existing instanceof ConfigBase group)validateArrayGroup(group,type);
                // Native add*Array methods retain KNIME's size/type representation.
                switch(type) {
                    case "stringArray" -> {String[] a=new String[value.size()];for(int i=0;i<a.length;i++)a[i]=string(value.get(i),true);parent.addStringArray(key,a);}
                    case "intArray" -> {int[] a=new int[value.size()];for(int i=0;i<a.length;i++)a[i]=(int)integer(value.get(i),Integer.MIN_VALUE,Integer.MAX_VALUE);parent.addIntArray(key,a);}
                    case "longArray" -> {long[] a=new long[value.size()];for(int i=0;i<a.length;i++)a[i]=longValue(value.get(i));parent.addLongArray(key,a);}
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
                case "xlong" -> parent.addLong(key,longValue(value));
                case "xdouble" -> parent.addDouble(key,floating(value));
                case "xfloat" -> {double d=floating(value);if(Double.isFinite(d)&&Math.abs(d)>Float.MAX_VALUE)throw new IllegalArgumentException("Float out of range");parent.addFloat(key,(float)d);}
                case "xchar" -> {String s=string(value,false);if(s.length()!=1)throw new IllegalArgumentException("xchar requires one UTF-16 character");parent.addChar(key,s.charAt(0));}
                default -> throw new IllegalArgumentException("Unsupported or protected settings type: "+type);
            }
    }
    private static void validateArrayGroup(ConfigBase group,String type)throws Exception {
        // Array setters must never erase arbitrary subtrees (which may include protected values).
        // KNIME represents a null native array as a completely empty config group.
        if(group.keySet().isEmpty())return;
        String expected=switch(type) {case "stringArray"->"xstring";case "intArray"->"xint";case "longArray"->"xlong";case "doubleArray"->"xdouble";case "booleanArray"->"xboolean";default->"";};
        for(String key:group.keySet()) {
            AbstractConfigEntry entry=group.getEntry(key);
            if(protectedEntry(entry))throw new IllegalArgumentException("Protected settings cannot be replaced");
            if(key.equals("array-size")&&entry.getType()==ConfigEntries.xint)continue;
            if(!key.matches("[0-9]+")||!entry.getType().name().equals(expected))
                throw new IllegalArgumentException("Only a native primitive array group of the same type can be replaced by "+type);
        }
        if(!group.containsKey("array-size"))
            throw new IllegalArgumentException("Only native array groups can be replaced with an array setter");
        int size=group.getInt("array-size");
        if(size<0||size!=group.keySet().size()-1)throw new IllegalArgumentException("Malformed native array group size");
        for(int i=0;i<size;i++)if(!group.containsKey(Integer.toString(i)))
            throw new IllegalArgumentException("Malformed native array group indices");
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
    private static long longValue(JsonNode n) {
        if(!n.isTextual()||!n.asText().matches("-?(0|[1-9][0-9]*)"))
            throw new IllegalArgumentException("xlong and longArray values require signed decimal integer strings");
        return integer(n,Long.MIN_VALUE,Long.MAX_VALUE);
    }
    private static double floating(JsonNode n) {
        if(n.isNumber()) {double value=n.doubleValue();if(!Double.isFinite(value))throw new IllegalArgumentException("Numeric value overflows double range; use an explicit special-value string if intended");return value;}
        if(n.isTextual()&&Set.of("NaN","Infinity","-Infinity").contains(n.asText()))return Double.parseDouble(n.asText());
        throw new IllegalArgumentException("Expected number, NaN, Infinity, or -Infinity");
    }
}
