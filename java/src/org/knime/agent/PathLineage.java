package org.knime.agent;

import java.nio.file.*;
import java.net.URI;
import java.util.*;

/** Path membership evidence only. It never reads file contents or executes nodes. */
final class PathLineage {
    static Path local(String value) {
        if(value.startsWith("file:"))return Path.of(URI.create(value));
        if(value.contains("://"))throw new IllegalArgumentException("Nonlocal filesystem scheme is not resolved by this gate");
        return Path.of(value);
    }
    static Map<String,Object> check(String value,String physicalRoot,String expectedRoot) {
        Map<String,Object> out=new LinkedHashMap<>();
        out.put("status","unknown");out.put("freshInference","unverified");out.put("fileContentsRead",false);
        out.put("rootSource",expectedRoot==null?"physical_workflow_root":"caller_expected_root");
        if(value==null||physicalRoot==null){out.put("reason","Selected safe scalar/effective local path or physical workflow root is unavailable");return out;}
        try{
            Path physical=local(physicalRoot).toRealPath();
            Path expected=expectedRoot==null?physical:local(expectedRoot).toRealPath();
            if(!Files.isDirectory(expected)){out.put("reason","Expected physical root is not a directory");return out;}
            Path selected=local(value);if(!selected.isAbsolute())selected=physical.resolve(selected);
            Path consumed=selected.toRealPath();
            out.put("physicalWorkflowRoot",physical.toString());out.put("expectedRoot",expected.toString());out.put("effectivePath",consumed.toString());
            boolean inside=consumed.startsWith(expected);out.put("status",inside?"within_expected_root":"outside_expected_root");
            out.put("membershipVerified",true);out.put("matchesPhysicalWorkflowRoot",consumed.startsWith(physical));
            out.put("reason",inside?"Resolved local path is within the selected physical root; run lineage remains unverified":"Resolved consumed path is outside the selected root; inherited cached variables or intentional external data require independent review");
        }catch(Exception failure){out.put("reason","Local path/root resolution unavailable: "+failure.getClass().getSimpleName());}
        return out;
    }
}
