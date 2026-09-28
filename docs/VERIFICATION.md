# Beta verification receipt

**Release:** 0.1.0-beta.1, 28 September 2026. **Acceptance result: 62 passed, 0 failed, 0 skipped.** A separate real-MCP fixture bootstrap also passed before the full suite. The final suite completed in 25.1 seconds against a freshly launched native KNIME instance.

## Tested environment and artifact

| Item | Observed value |
|---|---|
| OS | Windows 11 |
| KNIME | Analytics Platform `5.12.0.v202606180846`, modern UI |
| Java in KNIME | 21.0.9 |
| Node.js | 24.15.0; package requires 22+ |
| MCP SDK | `@modelcontextprotocol/sdk` 1.30.1, pinned lockfile |
| Bundle | `org.knime.agent.bridge_0.1.0.beta1-c45bd1c56965.jar` |
| Bundle SHA-256 | `a5df56e35dbaf84a4edd4158bc985760833719ab090e8ea35536dc9f91fdec36` |
| Java bytecode target | 21 |
| Workspace | This repository's `runtime/workspace`, synthetic test workflows only |
| Session at acceptance | `84bfbf74-bcb9-4b0f-94f8-5ee6afd0592c`, PID 23144 |

The session/process identifiers are historical evidence, not stable connection settings. Discover the current session before use. Rebuilding the JAR does not change a running process. The immutable release JAR was selected in a fresh launch before the acceptance run; the package script verifies that the ZIP contains those same JAR bytes.

## Reproduce acceptance

From the project directory, with compatible KNIME and Node installed:

```powershell
npm ci
node scripts/launch.mjs
node src/cli.mjs sessions
node src/cli.mjs health
```

Wait until `sessions` shows the intended disposable workspace with `status: ready` and `alive: true`; startup can take one to two minutes. Then:

```powershell
npm run test:beta
```

`verify-beta.mjs` first runs the actual MCP workflow test to create a fresh literal fixture. It reads `runtime/native-fixture.json`, sets `KNIME_CORE_TEST_PROJECT`, `KNIME_CORE_TEST_NODE`, and `KNIME_CORE_TABLE_FIXTURE=1`, and runs every test file. Native files execute sequentially because KNIME's current editable project is shared UI state. Plain `npm test` without those variables skips fixture-dependent core cases and is not sufficient for release acceptance.

Final observed suite summary:

```text
tests 62
pass 62
fail 0
cancelled 0
skipped 0
todo 0
```

Adapter/launcher checks account for 46 of those checks. They use controlled temporary transports/processes where appropriate. The remaining 16 checks contact real KNIME, including two health checks registered through the shared native helper. The comprehensive workflow test uses an actual MCP SDK stdio client connected to `src/server.mjs`; its engine calls are not mocked.

## What the native MCP round trip proved

1. Create and open a new local workflow through KNIME's space and desktop APIs.
2. Add a real Table Creator, change its label and position, undo and redo, then inspect the native graph.
3. Apply a typed settings envelope containing the independently specified rows `['alpha',1]`, `['',2]`, and `[null,3]`.
4. Execute and read exact rows, preserving missing versus empty values. Read a selected column and a middle page independently.
5. Add a Column Filter, connect real native ports, configure its included/excluded columns, and verify output `[[1],[2],[3]]` with schema `value`.
6. Compare the core graph with KNIME's UI workflow snapshot. Disconnect a connection and undo it. Collapse the filter into a metanode, inspect its child graph, and undo the collapse.
7. Attempt an out-of-scope settings change from inside that metanode and prove the root source settings remain unchanged.
8. Reset the source, verify output is unavailable, reexecute the downstream filter, and verify exact values again.
9. Export a nonempty native KNIME table archive.
10. Save through the desktop callback, observe root `dirty:false`, close, reopen, and verify both nodes, their connection, label, settings-dependent behavior and persisted output.

The final persisted example is **MCP Beta 1790581186838** in the disposable workspace. IDs and paths for the most recent run are written to `runtime/native-fixture.json`. Additional synthetic examples from development remain local; none is coursework.

## Review findings and regression evidence

| Finding | Resolution and evidence |
|---|---|
| Nested node lookup could fall back to a root node | Strict containment; real nested-settings rejection leaves the root envelope unchanged |
| Misspelled/null target arguments could broaden reset/execute to the workflow | Allowed names, types and required arguments checked before lookup; observed failing test before fix; malformed commands now reject and preserve executed table data |
| Primitive-array patches could replace an arbitrary settings subtree | Only compatible native array groups can be replaced; rejected group replacement preserves the envelope |
| Generic gateway save acknowledged without saving in desktop mode | Gateway method blocked; desktop callback and dirty-state polling verified through close/reopen |
| Table ports do not use the generic port serializer | Native table archive path; explicit nonempty export and no-overwrite checks |
| Concurrent launches could start before the first descriptor existed | Exclusive preparation lock and live launch PID record; race/spawn/record-failure tests |
| UI initialization and first-run dialogs could block opening | Workbench/modern-UI readiness gate, modal diagnostics, private workspace preference initialization |
| Native tests raced while switching active projects | Sequential native test files; final complete suite passed |

A final independent read-only review found the target-validation issue above. The reviewer rechecked its fix and reported no remaining material finding. This is review evidence for the beta, not a guarantee about every possible workflow or third-party node.

## Discovered breadth versus verified behavior

The installed build exposes **12 gateway services / 68 methods**, of which **65 are invocable** through advanced calls. The three blocked methods are the two UI event-subscription methods and desktop-inappropriate `WorkflowService.saveProject`. There are **12 core operations**, **6 desktop operations**, **10 MCP tools**, and **3 MCP resources**. The installed node catalogue contains **662 visible entries**, or **1,038 including hidden/deprecated entries**. These counts describe discovery, not a test of every entry.

| Capability | Beta status |
|---|---|
| Session identity, readiness, stale/dead/ambiguous session rejection | Verified |
| Live graph, node state, messages, positions, nested metanode contents | Verified on synthetic fixtures |
| Installed node search and native documentation/port discovery | Verified; catalogue breadth discovered |
| Add, label, move, connect/disconnect, undo/redo, metanode collapse | Verified through actual MCP |
| Typed settings, native validation, reset and asynchronous execution | Verified on Table Creator and Column Filter |
| Missing/empty cells, paging, column selection, 64-bit integer precision | Verified using independent expected rows |
| Native table export, no overwrite, read-only port inspection | Verified; exported archive reimport not separately tested |
| Save, clean-state check, close and reopen with persisted output | Verified for local-origin projects |
| Expired queued mutation, timeout with no automatic replay | Verified |
| Cancellation request | Acceptance verified; long-running interruption/stress behavior unverified |
| Other discovered canvas/component/node/view/service calls | Exposed where permitted; not individually acceptance-tested |
| Arbitrary third-party settings, dynamic factories and opaque ports | Implementation-dependent; no universal compatibility claim |
| Large workflows/tables, crash recovery during writes, long-term multi-agent use | Not stress-tested |
| Pixel screenshots or arbitrary native/custom-dialog automation through MCP | Not implemented |
| Universal JSON representation of arbitrary Java port objects | Not implemented; metadata/native export where supported |
| Credential editing/extraction, remote Save As/upload, extension installation | Outside this beta's supported adapters |
| Other KNIME builds, Linux/macOS, clean second-machine installation | Not verified |

## Connection and release checks

`Codex mcp get knime-agent --json` confirmed an enabled stdio entry using the installed Node executable and this project's absolute `src/server.mjs` path. Protocol initialize/list/call/resource behavior was verified through the SDK, independently of the desktop host's tool refresh. An already-running chat may need a new chat or MCP reload before the entry appears in its tool list. The CLI is immediately usable.

`python scripts/package.py` creates the versioned ZIP, checks every archive member against `SHA256SUMS.json`, checks ZIP integrity, and writes the archive's `.zip.sha256` sidecar. Only source, docs, tests, scripts, package manifests and the selected bridge JAR are included. Runtime/workflow data, user settings, `node_modules`, KNIME vendor JARs and Git metadata are excluded. Moving the package to another directory requires registering that new absolute server path after installing its locked npm dependencies.

The ZIP was also extracted into a fresh directory on this machine. `npm ci --offline --ignore-scripts` installed all 94 locked dependency packages from the local cache, and the extracted CLI reported `0.1.0-beta.1`. An SDK client started the extracted MCP server, discovered its 10 tools and 3 resources, and obtained ready health from the live release process. This smoke check explicitly set the child's `KNIME_AGENT_RUNTIME` to the running release instance; SDK clients do not necessarily inherit custom environment variables automatically. This is same-machine package validation, not a second-machine compatibility claim.

## Assumptions for review

- Local Windows/KNIME 5.12 was chosen as the first supported target because it is the user's installed environment.
- MCP is primary, and the CLI is retained for the same operations without a second implementation.
- The bridge uses internal native APIs, so version upgrades require the acceptance suite before routine use.
- The two-node source/filter fixture plus native output export replaces a separate writer-node fixture in the initial plan. This verifies actual transformation, execution, data access and persistence with literal expected results.
- The beta is a broad native control interface, not a promise of tested access to every custom node dialog or opaque data type. Further coverage is planned in `DESIGN.md`.
