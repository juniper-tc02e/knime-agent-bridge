# Workshop 2 reliability diagnosis — 0.2.0-beta.2

Local maintenance update, 29 September 2026. Publication of a new GitHub release is separate from this local fix.

## Diagnosis

| Report | Finding | Resolution |
|---|---|---|
| Random Forest executed but warned on reload | Reproduced on installed KNIME 5.12. Incomplete defaults can leave `splitCriterion` null. KNIME catches the model serialization exception, logs it and returns a partial envelope; the bridge previously could not distinguish that from complete settings. | Inspect native model serialization/validation, expose `settingsValidation`, block known-invalid execution/save, keep a typed repair path. |
| Hundreds of save-model errors during inspection | Revision reads repeatedly called the KNIME wrapper which swallowed and logged the same exception. | Read stored envelopes and generate missing defaults through the pinned serializer adapter, observing failures directly without repeated wrapper logging. |
| AccessDeniedException replacing metadata | Confirmed in the operation/session records. The precise external lock holder is unknown. A Windows handle opened without delete sharing reproduces the same failure. | Unique temporary files, file flush, bounded publication retries; immutable full operation events remain authoritative when aggregate replacement is delayed. Never retry a KNIME mutation automatically. |
| Ambiguous failed operation | Before beta.2 a pre-dispatch journal write error and an error after native dispatch could look similar. | Report `nativeDispatch`; preserve native result/error and explicit journal uncertainty when final recording fails. |
| Load warning not readable/recoverable | Initial shell-title-only inspection omitted the message and collapsed details. | Bounded native text read, reveal-details action and acknowledgement scoped to an inspected Workflow Load warning, guarded by stable ID and content fingerprint. |
| Accepted versus completed | Expected asynchronous API behavior; too easy for agents to misinterpret. | `knime_wait` observes exact session/target postconditions and reports settled/failed/blocked/timeout without replay. |
| Ready descriptor after restart | Recorded historical status was correct only when written; effective liveness already rejected the session. | Expose `reportedStatus` separately and set effective status to dead/stale/unavailable as appropriate. |
| Copy/paste envelope and argument mistakes | Native clipboard content is opaque; parsing it changes the expected envelope. `nodeId`/`nodeIds`/`portIndex` differences are real API contracts. | Explicit passthrough example, guide updates and clearer core argument hints; strict targeting remains enforced. |

Both contributors matter: the agent skipped successful configuration and final reload verification, while the bridge failed to surface incomplete serialization clearly. More visibility helps, but reliable settings validation and completion checks are equally necessary. A screenshot cannot establish that settings reload correctly.

## Verification scope

Regression tests cover real Windows file sharing contention, recovering a durable event behind a stale/missing/exclusively locked aggregate, effective session state, refusal before native dispatch, successful native creation followed by final journal failure, incomplete Random Forest defaults, typed repair, actual execution, save/close/reopen, stable revision inspection without repeated save errors, quality coverage, and bounded wait behavior.

The native load-dialog test creates a deliberately invalid **closed synthetic copy**, then exercises the actual KNIME warning. No coursework or user workflow is modified. Standalone SWT tests cover warning text, password-field omission, stale fingerprint rejection and refusal to expose arbitrary confirmation actions.

Final journal errors include `nativeResult` for successful results up to 64 KiB. Larger results report their size, SHA-256 and explicit omission; agents must inspect the target before any retry. Aggregate lock recovery validates event identity and size, and preserves the filesystem error when no valid event can establish an outcome.

Final acceptance on Windows 11 / KNIME `5.12.0.v202606180846`, 29 September 2026:

| Check | Observed result |
|---|---|
| `node scripts/build.mjs` | Compiled 18 Java sources, Java 21 target |
| `node scripts/verify-beta.mjs` in the dedicated verification runtime | **136 passed; 0 failed, cancelled or skipped**, 110.7 seconds for the full suite |
| Random Forest regression | Incomplete settings blocked before execution/save; typed repair executed and saved; reopen validated; actual load-warning details readable in the intentionally broken copy |
| Windows journal regression | Real sharing/exclusive locks recovered; missing events and mismatched identity failed closed; created workflow ID survived final-journal failure |
| Native visual regression | Layout overlap detected and repaired; exact executed table rows preserved; saved successfully |
| Manual image inspection | Inspected both generated overview PNGs: the repaired node and label sit below the instruction text without overlap |
| Review | Both journal edge-case findings corrected and rechecked |

Tested bundle: `org.knime.agent.bridge_0.2.0.beta2-0ed75ffab368.jar`.
SHA-256: `b15deaafc3725787382b0e24f8ddc7ba2c25d13dce2a6d725932f28f74f4cfd6`.
The local full-run log is `runtime/w2-verified/full-suite-awake.log`; runtime data is excluded from packages.

An earlier run was interrupted by Windows sleep during the canvas test (confirmed by system power events). The full suite was rerun after resume; the results above are that completed run.

## How to use the update

1. Save any work and close the KNIME instance you intend to upgrade.
2. From the bridge folder, run `node scripts/launch.mjs` for that workspace, using the updated `artifacts/latest.json` bundle.
3. Reload the MCP connection or start a fresh chat. Confirm `knime_health` reports `0.2.0-beta.2` and the intended workspace. There are now 18 tools, including `knime_wait`.
4. Read `knime://guide`; use current context/revision preconditions as before.

The regular KNIME shortcut does not load the bridge. Building a new JAR does not replace code in an already-running process. Test workspaces are separate from your working workspace; do not point your regular MCP registration at a disposable test runtime.

## Reproduce in a disposable workspace

```powershell
npm ci
node scripts/build.mjs
$env:KNIME_AGENT_RUNTIME = Join-Path (Get-Location) 'runtime\w2-verification'
node scripts/launch.mjs --workspace (Join-Path (Get-Location) 'runtime\workspace-w2-verification')
node src/cli.mjs sessions
node src/cli.mjs health
```

After ready/alive health:

```powershell
node scripts/verify-beta.mjs
```

The reliability test refuses workspaces outside the dedicated `runtime/workspace-w2-*` pattern. It creates synthetic workflows and one intentionally invalid copy to exercise the native warning. JDK 21+ and the installed KNIME libraries are required for JVM probes; Node 24 and JDK 24 are the tested build tools.

## Remaining limits

This is a KNIME 5.12-specific model-settings adapter. Passing model validation does not certify every third-party view serializer or all persisted artifacts. A clean-save wait remains weaker than reopening and checking saved results. Generic expert gateway operations retain their documented weaker guard coverage. Only Workflow Load details/acknowledgement are automated; unrelated dialogs, authentication, confirmations and progress cancellation remain outside the adapter. Filesystem failures beyond the bounded retry window remain visible rather than being reported as success. Broader canvas fidelity and controlled agent-trial work from beta.1 remain open.
