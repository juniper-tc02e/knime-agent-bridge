# v0.5 measurement artifacts

These files contain controlled synthetic measurements, not private workflows or raw host process dumps.

| Files | Boundary |
|---|---|
| `acceptance-v05.json`, `canvas-v05-before.png`, `canvas-v05-after.png` | Final exact-bundle acceptance counts, full-table/copy-path/detail/context/EOF checks, native export manifest and original-size inspected synthetic canvas overviews. No private runtime paths or analytical data. Native preview and complete visual-quality coverage remain separate. |
| `history-v05.json`, `.csv` | Five samples for each 10/1,000/10,000 × cold/warm × sync/async cell. Exact benchmark/store source hashes, CPU/RSS/event-loop counters and selected payload read counts. Cold means new store instance, not cold OS cache. |
| `lifecycle-v05.json`, `.csv` | One uniform pre-receipt-repair client/server run, 100 sequential plus 3 concurrent MCP processes, all exiting via EOF. The recorded client hash differs from the final release; this is not final-client 103 qualification. Numeric PID plus creation identity is evidence for those owned children only. |
| `lifecycle-final-client-v05.json`, `.csv` | Final client/server hashes; 10 sequential plus 3 concurrent MCP processes, all exiting via EOF. A smaller instrumented diagnostic probe, not a 100-connection stress qualification. |
| `lifecycle-final-stress-v05.json`, `.csv` | A later uniform final-client/server run, 100 sequential plus 3 concurrent processes, all exiting via EOF with 0 remaining. This supplies the final-source lifecycle statistics. Earlier unknown identity failures remain separately disclosed. |
| `lifecycle-failures-v05.json` | Sanitized accounting for three final-client identity-unavailable attempts. All owned failed children received EOF, with zero remaining after bounded cleanup. Underlying cause unknown. |
| `native-stages-v05.json`, `.csv` | Baseline public v0.4 commit versus instrumented v0.5 production dispatcher/journal on real disk with synthetic KNIME/Eclipse boundaries; 25 samples. Added instrumentation costs are visible. No live/UI performance claim. |
| `history-50000-v05.json`, `.csv`, `.metadata.json` | One cold/warm observation per implementation at 50,000 retained records. No percentile confidence; async warm is slower. Metadata explicitly corrects the frozen script's static omission sentence. |

Nearest-rank p95 with five samples equals max. Timings, CPU and memory are specific to the recorded machine/runtime and uncontrolled background activity. Source hashes name the measured implementation, not a claim that every packaged document existed during the run. Native exporter additions do not change the measured dispatch/telemetry implementation. Full release verification is [VERIFICATION-0.5.md](../VERIFICATION-0.5.md).
