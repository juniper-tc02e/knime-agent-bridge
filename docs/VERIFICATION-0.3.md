# v0.3 verification receipt

Current release: `0.3.1`, 29 September 2026. Windows 11, KNIME Analytics Platform `5.12.0.v202606180846`, modern UI; Java 21 target, Node 24.15 and JDK 24 used locally. Full native acceptance: **139 passed, 0 failed, cancelled or skipped**.

## v0.3.1 restart-readiness correction

The final local restart check after publishing v0.3.0 exposed one additional issue: KNIME's application state can contain restored tabs whose native workflow models are not loaded. The open wait formerly accepted the tab alone. v0.3.1 requires a successful native snapshot of the exact matched project before returning `settled`.

Two regressions first failed, then passed after the correction. A real restored tab reproduced the false `settled` result before the fix and returned `timeout` with `completed:false` after it. Unrelated native errors remain visible; no mutation is replayed.

Full v0.3.1 suite: **139/139**, zero failures, cancellations or skips, **141.036 seconds**, plus fixture bootstrap. The native visual result was inspected again. Tested bundle: `org.knime.agent.bridge_0.3.1-15a0bc0c133b.jar`, SHA-256 `be703131122f9e63db356e662303ba60767e4e1201aeb9b9280dae0920c7f0b7`; live health matches. Local log: `runtime/v031-verification/full-suite.log`.

v0.3.0 remains available as historical release evidence. The following table records its initial 137-test acceptance; every case was included again in the 139-test corrective run.

## Fixed behavior

This release includes all fixes described in the [Workshop 2 diagnosis](RELIABILITY-0.2.0-beta.2.md): model serialization/validation checks and typed repair; resilient Windows file publication and operation-event recovery; explicit pre-dispatch versus uncertain outcome reporting; successful native result recovery after final-journal failure; visible Workflow Load details and guarded acknowledgement; read-only completion waits; effective dead/stale session status; and corrected agent guidance for arguments and opaque clipboard content.

Additionally, `knime_wait` treats an expired queued observation as `timeout`, preserving the original code in `lastError`. It never retries the originating mutation and never turns an expired observation into completion evidence.

The earlier canvas image, curved-wire/text checks, constrained layout edits, data-preservation checks and stale/cross-task evidence safeguards remain part of v0.3.

## Evidence and deployment

| Check | Measured evidence |
|---|---|
| Build | 18 Java sources compiled, Java 21 target |
| Full native suite | `node scripts/verify-beta.mjs`: 137 passed; 122.075 seconds; zero failures/cancellations/skips, plus fixture bootstrap |
| Settings round trip | Random Forest invalid defaults rejected on core and gateway paths; typed repair executed, saved and reopened; repeated inspection did not add swallowed serializer errors |
| File and receipt recovery | Real Windows sharing/exclusive locks; full event recovery; invalid identity/missing evidence rejected; created item ID retained after final journal failure |
| Warning recovery | Actual intentionally broken synthetic workflow produced readable details and guarded acknowledgement; stale/unrelated confirmations rejected |
| Asynchronous observations | Exact target/session waits; queued expiry and transport timeout remain unknown outcomes and never replay commands |
| Canvas | Actual MCP PNGs before/after repair inspected: node and label moved below the instruction text; independent table values and execution preserved; save verified |
| Prior review defects | Semantic capture freshness, changed scope during assessment and cross-task evidence contamination regressions passed |
| Independent review | No material or release-blocking finding; reviewer separately ran 30 focused tests, all passing |

Original v0.3.0 tested immutable bundle: `org.knime.agent.bridge_0.3.0-a3ef6e3bdec3.jar`.
SHA-256: `0c55f945ce606ae6900095e66a2c5554c498afb5ae94a6e6f0572f2a31571f85`.
Live health reported this exact fingerprint. Local acceptance log: `runtime/v03-verification/full-suite.log` (excluded from distribution).

Distribution checks use the extracted package's own installed dependencies and MCP server against the tested native session, then compare downloaded GitHub assets with the local archive/checksum. Publication results accompany the release notes. The ZIP includes a per-file SHA-256 manifest and the compiled JAR; GitHub's automatic source ZIP does not include the JAR.

## Supported scope and limits

This is a version-specific integration for the tested Windows/KNIME build. Passing model validation cannot certify every third-party view serializer. A clean live save state is weaker than reopening and inspecting the persisted artifact. Recovery actions cover the inspected Workflow Load dialog, not arbitrary native/browser prompts. Generic gateway operations retain their documented guard limits.

Native-model previews have provenance; experimental viewport synchronization and universal coordinate mapping remain unverified. Geometry gaps remain visible. Image review is an agent attestation, not proof of comprehension. The broader roadmap's controlled agent trials, arbitrary custom-node/nested fidelity, universal saved-artifact quality adapter and clean second-machine validation remain unverified; v0.3 does not claim those results.

## Reproduce

Use a dedicated disposable workspace; do not run the suite against coursework:

```powershell
npm ci
$env:KNIME_AGENT_RUNTIME = Join-Path (Get-Location) 'runtime\v03-verification'
node scripts/launch.mjs --workspace (Join-Path (Get-Location) 'runtime\workspace-w2-v03-verification')
node src/cli.mjs sessions
node src/cli.mjs health
# Wait for ready/alive health before running:
node scripts/verify-beta.mjs
```

The `workspace-w2-*` safety prefix is required by the reliability regressions. The suite creates synthetic data and an intentionally invalid closed workflow copy to exercise the real warning. JVM probes require JDK 21+ and installed KNIME libraries; running the prebuilt MCP package does not require a JDK.

For installation and upgrade steps, see [SETUP.md](SETUP.md). Both MCP and CLI must use the same intended runtime. Refresh the MCP connection after upgrading; discovery exposes 18 tools.
