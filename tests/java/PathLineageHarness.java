package org.knime.agent;
import java.nio.file.*;import java.util.*;
public final class PathLineageHarness {
 public static void main(String[] args)throws Exception{
  Path base=Path.of(args[0]),parent=Files.createDirectories(base.resolve("parent")),copy=Files.createDirectories(base.resolve("copy"));
  Path runA=Files.writeString(parent.resolve("run-A.csv"),"id,run\n1,A\n"),runB=Files.writeString(copy.resolve("run-B.csv"),"id,run\n1,B\n");
  var mismatch=PathLineage.check(runA.toString(),copy.toString(),null);check(mismatch.get("status").equals("outside_expected_root"));check(mismatch.get("freshInference").equals("unverified"));check(mismatch.get("fileContentsRead").equals(false));
  check(PathLineage.check(runB.toString(),copy.toString(),null).get("status").equals("within_expected_root"));
  check(PathLineage.check("run-B.csv",copy.toString(),null).get("status").equals("within_expected_root"));
  check(PathLineage.check(runA.toUri().toString(),copy.toString(),parent.toString()).get("status").equals("within_expected_root"));
  check(PathLineage.check(null,copy.toString(),null).get("status").equals("unknown"));
  check(PathLineage.check("knime://knime.workflow/path",copy.toString(),null).get("status").equals("unknown"));
  check(PathLineage.check("absent.csv",copy.toString(),null).get("status").equals("unknown"));
  check(PathLineage.check(runB.toString(),copy.toString(),runA.toString()).get("status").equals("unknown"));
  System.out.println("PASS PathLineage 10 assertions, no file contents read or producer execution");
 }
 static void check(boolean value){if(!value)throw new AssertionError("Path lineage gate failed");}
}
