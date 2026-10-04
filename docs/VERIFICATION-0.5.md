# v0.5 verification receipt

Release target: `0.5.0`, 5 October 2026. Windows 11, KNIME Analytics Platform `5.12.0.v202606180846` modern UI, Node.js `24.15.0`, JDK `24.0.2` compiling Java 21 bytecode. MCP exposes **25 tools**. This independent bridge uses installed internal APIs; other builds require verification.

**Final acceptance:** `npm run test:beta`'s serial runner passed its bootstrap **1/1** (15.19 s) and main suite **245/245** (451.49 s), with **0 failures and 0 skips**. Total runner time 466.93 s. These are two child test invocations under one acceptance command, not a single 246-test invocation. Final immutable bundle: `org.knime.agent.bridge_0.5.0-34c7f878da0d.jar`, SHA-256 `a020eb778a183d0afead8f804b2734aed687d45fcd9ddc51bc52be1a1f17f15c`. All **48** production class entries match the fresh compilation of **24** Java source files. The loaded native process reported the same fingerprint. Sanitized acceptance, export manifest and inspected images are published in [measurements](measurements/README.md).

The first frozen full run passed bootstrap 1/1 and main 244/245, failing native export on Windows' locked empty `.knimeLock`. The installed exporter succeeds without reading an empty entry; the bridge's source hash read had failed. A regression reproduced that exact error before repair. The repair hashes verified zero-byte files without reading them, retains identity/size rechecks and lock ownership, and still refuses nonempty locked resources. The final full run above used a newly loaded repaired bundle; failed receipts remain preserved and are summarized separately.

## Fresh evidence and test boundaries

| Evidence | Result | What it proves / does not prove |
|---|---|---|
| Owned MCP lifecycle | Final-source uniform run: 100 sequential + 3 concurrent clients, 103/103, 0 remaining. Separate diagnostic probe 13/13, plus earlier pre-repair 103 run | Exact source hashes and distinct receipts are published. Earlier identity-unavailable attempts remain failed runs. Each successful child exits via EOF; no arbitrary process is killed. This does not establish the cause of desktop lag. |
| EOF staging/publication fault tests | Real stdio fixtures stop staged publication before EOF; already-started rename retains uncertain original UUID | EOF stops observation synchronously before lifecycle I/O. Disconnect does not become mutation cancellation or replay. |
| Async history authority | Executable tests include additions/replacement/deletion, selected same-stat changes, independent process writer, concurrent races, unreadable/malformed records and a real Windows FileShare.None lock | Fresh selected payload/digest authority; observed changes invalidate cursors. No cross-process filesystem transaction or invisible hostile metadata restoration guarantee. |
| Complete native output and copy-cache | Final-bundle live run: 3,544 rows, four pages + final identity recheck, exact independent values/keys/run constant, accuracy/AUC 1 with positiveLabel=1; inherited parent-path mismatch detected read-only; explicit child refresh corrected path | Actual KNIME table and copied executed cache. The unrelated cohort table remained unchanged. Five complete detail references were retrieved through 245 chunks with matching SHA-256; 82 primary tool calls; four owned scoped contexts released; its MCP child exited via EOF, code 0, without killing. A scalar-path fixture does not prove CSV consumption or fresh inference. |
| Canvas inspection | Actual fresh rendered native-preview before/after PNGs inspected at original size; node initially covers instruction text, corrected node sits below it; executed table retained | Whole synthetic overview inspected, not a synchronized live viewport. The receipt's omitted required tiles keep quality coverage incomplete; this repair is not falsely promoted to full visual-quality PASS. |
| Persistence | Final-suite native settings, Unicode/empty/null values, save/close/reopen and fresh project/model identities passed | Clean/acknowledged alone is insufficient. Same-host round trip is separate from export and second-machine portability. |
| Native workflow export | Final-bundle saved Unicode workflow: installed `WorkflowExporter.exportInto`, cached resources included, 51,545 bytes, 13 entries; complete per-entry and archive SHA-256 checked; four negative cases passed | No implicit save, execute or reset. Export SHA `d4a1f3917504bb90f2f313687839b07a864b3601478bd9a2100e0957ddbe1a7f`. Dirty root, byte bound, nested selector and arbitrary output refuse. Installed-API harness additionally checks junctions and directory/temp/content/publication replacement. This is native workflow export, not an ordinary ad hoc ZIP. |
| Native scheduling and faults | Production dispatcher/journal with synthetic KNIME/Eclipse boundaries | A blocked worker retains serialized mutation/cancel ordering while safe telemetry observes queue; overflow and journal/publication failures preserve original outcome and secondary errors. This does not prove real modal/UI/Python interrupt performance. |
| Quality assessment concurrency | Concurrent task changes allocate distinct revisions; final manifest follows awaited context; event digest detects observed equal-revision additions; failure releases queue | Same-store/task serialization, conservative invalidation. Independent processes do not share a universal write lock. |
| Table/metric negatives | Synthetic replacement mid-page rejects; ties receive half credit; reversed positive labels change AUC; nulls/invalid probabilities, duplicates, wrong constants and incomplete bounds cannot pass | Full rows and named semantics are required. Samples, revision equality and settings alone cannot establish metrics. |
| Protected originals | 232 tracked files in original source repositories, 41 protected evidence files and global MCP config hashes unchanged; pre-existing protected process creation identities unchanged | Only owned synthetic native processes were restarted. No analytical runtime dispatch, accepted-model execution or messaging of the analytical chat. Local runtime/raw receipts are excluded from the public package. |

The first uniform lifecycle attempt failed at iteration 56 after 55 successful sequential connections and 3 concurrent clients. Its original harness did not capture sufficient exit diagnostics, so the cause remains **unexplained**. A later uniform pre-receipt-repair run completed 103 and supplies the 100-sample statistics below. Its client SHA is `a3dd5e03f9e9fa47388c0a6f8c126fd6f3658fe15cf8d8cc62bfc626e87d8b0b`, **not the final client**.

The final client SHA is `e89ac014a795e0723b959811da878787de90d2185edca12bfdf06d3fba1d3730`; server SHA is `02dab151a5d515e4a0c66e33ed193be1374291217e69750a018c5d817c59b66a`. Three earlier final-client qualification attempts stopped at sequential iterations 22, 3 and 19 when OS creation identity was unavailable. All failed children received EOF; bounded cleanup reported zero remaining. An instrumented smaller 13/13 probe then passed, with unchanged production identity provider queries taking 399–1,410 ms. A later final-source qualifier completed 103/103 with unchanged deadlines. The underlying earlier failure cause remains unknown. The public failure summary preserves this accounting; a later pass does not explain an earlier failure. Unknown creation identity never authorizes ownership or killing.

## Comparable measurements

Raw sanitized JSON/CSV are in [measurements](measurements/README.md). Clocks are monotonic within each process; timestamps from separate processes are never subtracted to manufacture stage durations. Other host activity and OS disk cache were uncontrolled.

### History: five samples per cell

The synchronous implementation is the retained v0.4 indexed path; the async path uses the same fixture and selected eight records. Cold means a new store instance. The fixture contains 4 KiB unrelated payloads. With five samples nearest-rank p95 equals the maximum.

| Retained records / query | Sync p50 ms | Async p50 ms |
|---|---:|---:|
| 10 / cold | 17.42 | 13.37 |
| 10 / warm | 14.96 | 9.87 |
| 1,000 / cold | 1,556.51 | 727.91 |
| 1,000 / warm | 453.82 | 318.04 |
| 10,000 / cold | 9,440.14 | 5,187.01 |
| 10,000 / warm | 2,371.54 | 2,329.05 |

At 10,000 records, cold p95/max was 20,656.03 → 7,351.52 ms; warm was 4,673.08 → 3,271.20 ms. Maximum observed event-loop delay was 20,669.53 → 18.58 ms cold and 4,676.65 → 16.20 ms warm. Warm throughput was similar; yielding/responsiveness is the main result.

Both cold implementations read 10,000 payloads / 43,046,226 bytes; both warm implementations read only 8 selected payloads / 1,776 bytes. Async performed more stats (50,003 cold / 20,027 warm versus synchronous 20,000 / 10,016) to check concurrent changes. Metadata enumeration/stat is still O(N).

A separate **single-sample 50,000-record stress case** completed in 135.39 s overall. Sync cold/warm took 37.202 / 6.663 s; async took 27.264 / 15.423 s. Maximum event-loop delay was 37,211.87 / 6,664.75 ms sync versus 54.92 / 47.05 ms async. Both cold cases read 50,000 payloads / 215,406,226 bytes; warm read eight / 1,776 bytes. Async warm was slower and performed more stats. This establishes one bounded stress observation, **not latency-percentile confidence or a universal throughput improvement**. The frozen benchmark script's static "50,000 omitted" sentence is corrected by the accompanying qualification metadata.

### Owned lifecycle: 100 sequential samples, pre-receipt-repair client

| Metric | p50 | p95 | Maximum |
|---|---:|---:|---:|
| Connect ms | 933.01 | 1,331.72 | 1,648.98 |
| EOF-to-exit ms | 20.72 | 28.39 | 37.11 |
| End RSS bytes | 78,131,200 | 78,512,128 | 78,733,312 |

The measured end-RSS slope was +1,314.80 bytes/iteration across fresh processes. Initialize bound 10 s; EOF bound 5 s; failed-only cleanup grace 5 s, fixed at the first failure. Resource figures are process-local RSS samples, not additive host physical RAM or unsampled maxima. This is a controlled transport experiment, not an extended live-model soak.

The smaller final-client probe had ten sequential timing samples plus three concurrent clients: connect p50 / p95 / max 965.16 / 2,093.27 / 2,093.27 ms; EOF-to-exit 24.01 / 58.44 / 58.44 ms. These are separate from the later 100-connection qualifier below. The final client adds exact per-call receipt capture, verified by overlapping live IPC response/trace tests; it does not weaken OS identity requirements to pass the harness.

### Owned lifecycle: final-source 100 sequential samples

| Metric | p50 | p95 | Maximum |
|---|---:|---:|---:|
| Connect ms | 873.31 | 1,567.48 | 1,993.75 |
| EOF-to-exit ms | 18.64 | 30.62 | 34.63 |
| End RSS bytes | 79,142,912 | 79,482,880 | 79,704,064 |

All 100 sequential and three intentionally concurrent children exited through EOF, with zero owned children remaining. End-RSS slope was +3,232.41 bytes/iteration across separate fresh processes; it is not a same-process leak measurement. The same 10 s initialize, 5 s EOF and immutable 5 s failed-only cleanup limits apply. The qualifier was run with the final source hashes above. It does not prove UI responsiveness, native cancellation, an extended model soak or explain preceding lookup failures.

### Native production-boundary benchmark: 25 samples per operation

Baseline commit `7cf51b26240511d312c2909861dec36d7ec5e8ed`. Production scheduler/journal and real disk; synthetic KNIME/Eclipse boundary. No filesystem request polling or host rendering included.

| Operation | Baseline p50 / p95 / max ms | Changed p50 / p95 / max ms |
|---|---|---|
| Health | 18.40 / 19.37 / 73.20 | 22.76 / 33.60 / 97.88 |
| operation.get | 19.12 / 31.37 / 43.52 | 23.43 / 34.62 / 35.66 |

Instrumentation added work: total measured response bytes increased from 12,157 to 50,873 for health, and 19,700 to 47,865 for operation.get across the benchmark samples. Benchmark-thread CPU increased from 625 to 859.38 ms. These measurements are **not a native speedup claim**. MCP compact formatting is a separate transport change.

## Dependency and portability scope

The prebuilt bridge requires the installed KNIME bundles; it does not redistribute them. This installation contained `org.knime.core 5.12.0.v202606180846`, `org.knime.base 5.12.0.v202606261225`, `org.knime.gateway.api 5.12.0.v202606171435`, `org.knime.gateway.impl.jsonrpc 5.12.0.v202606010651`, `org.knime.ui.java 5.12.0.v202606150722` and `org.knime.js.cef 5.12.0.v202606161509`. Native workflow export additionally imports installed JNA/JNA Platform 5.17.0 for Windows file identities and Apache Commons Lang 3.18.0's function interface used by the installed exporter. Bundle resolution was checked by the actual loaded process, not merely by a compile classpath.

Synthetic nodes used the installed Table Creator and Table Row to Variable factories. No external Python environment, predictive model, checkpoint, credentials, database or coursework file was needed. Each real workflow still needs its own extension, runtime, external-file and model manifest. The JavaScript lockfile pins MCP SDK 1.30.1, Playwright Core 1.63.0 and Zod 3.25.76; rendering used installed Edge 154.0.4258.53. Rebuilding used JDK 24 targeting Java 21; release packaging used Python 3.12.10. Prebuilt MCP usage needs neither build tool.

## Reproduce

Use a separate extracted folder named `knime-agent-bridge`, runtime/workspace and MCP alias. Do not run native fixtures against real analytical workflows.

```powershell
$env:KNIME_AGENT_RUNTIME = Join-Path (Get-Location) 'runtime'
$env:KNIME_AGENT_JDK = 'C:\Program Files\Java\jdk-24'
node scripts/build.mjs
node scripts/launch.mjs --workspace (Join-Path $env:KNIME_AGENT_RUNTIME 'workspace-w2-v04-test')
node src/cli.mjs health --runtime $env:KNIME_AGENT_RUNTIME
npm run test:beta
node scripts/verify-lifecycle-v05.mjs
node scripts/benchmark-quality-history.mjs
```

The bootstrap pins session/PID/bundle for v0.5 fixtures. The complete suite runs serially because native cases share active-project state. Local raw receipts retain UUIDs, routes, actual images and failed attempts; the public package excludes runtime data, private handovers and real workflows. Published measurements expose generic fixture results only.

## Remaining limits

- Original desktop-lag cause, host frame/rendering delay and real model-training improvement remain unproved.
- OS creation identity was occasionally unavailable in earlier lifecycle attempts; the cause remains unknown despite the later final-source 103/103 qualifier. Unknown identities stay explicit and never grant ownership.
- Live blocked SWT/modal/external Python cancellation stress is not established by the scheduler boundary harness. Cancellation remains serialized.
- Native lock/UI/external durations are unmeasured and explicitly listed as such. Heartbeat is descriptor readiness, not responsive UI proof.
- History metadata scans remain linear. Node free-memory measurements are not the Windows available-memory counter.
- Fresh inference/producer provenance, remote filesystem semantics and every third-party settings validator remain unverified unless separately tested for that workflow.
- Saved, clean, closed, reopened, exported and freshly inferred are distinct. A native preview is not a synchronized live viewport. Partial/offscreen coverage cannot pass visual completion.
- File durability is limited to the exact flush/close/hash checks reported. Directory fsync and a multi-process atomic snapshot are not promised.
- Same-host persistence and package hash verification are not a second-machine portability test. External files/runtimes/models still require their own dependency manifest.

See [diagnosis](DIAGNOSIS-0.5.md), [migration/rollback](MIGRATION-0.5.md) and [operational contracts](OBSERVABILITY-0.5.md).
