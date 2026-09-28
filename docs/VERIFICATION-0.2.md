# v0.2 beta verification receipt

**Release: 0.2.0-beta.1 — 28 September 2026.** Full acceptance: **123 passed, 0 failed, 0 skipped**, in 79.8 seconds. This is a bounded beta for the environment below, not a claim that every KNIME operation, custom node or UI surface is covered.

## Tested environment

| Item | Observed value |
|---|---|
| Operating system | Windows 11 |
| KNIME Analytics Platform | `5.12.0.v202606180846`, modern UI |
| KNIME Java runtime | 21.0.9 |
| Node.js | 24.15.0 |
| MCP SDK | 1.30.1, pinned |
| Browser renderer | Installed Microsoft Edge 154.0.4258.37, private temporary profile |
| Browser driver | playwright-core 1.63.0, pinned |
| Bridge bundle | `org.knime.agent.bridge_0.2.0.beta1-327252590586.jar` |
| Bundle SHA-256 | `56b609c6dc872416dd9b5d4c2b1f76e6c23e71b04ae3e315871aca03ce6f7adb` |
| Java bytecode target | 21 |

The loaded bundle fingerprint is checked against the actual JAR. Testing used a separate bridge runtime and disposable workspace containing synthetic workflows. Other KNIME processes and user workflows were preserved.

## Acceptance evidence

The full suite used the actual MCP SDK stdio transport for native tests and controlled transports for targeted failure/race cases. Its result was:

```text
tests 123
pass 123
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 79813.0357
```

After the final guidance changes, a focused adapter plus native visual run passed **47 tests, 0 failures, 0 skips**. The visual fixture supplied an explicit annotation group constraint; the resulting image was inspected and showed the executed Table Creator below the instructional text, inside its annotation. Automatic geometric planning does not infer the meaning of arbitrary instructions.

| Area | Verified behavior |
|---|---|
| Existing workflow control | Create/open, add/configure/connect, execute, read exact typed values, reset/reexecute, native table export, save/close/reopen |
| Session/context identity | Bound session and workflow, changed-session rejection, distinct structure/configuration/layout/execution revisions |
| Native preview | PNG images returned through MCP from a fresh native model preview, plus structured evidence and coordinate transforms; capture preserves model/settings/revisions |
| Visual repair | Real node/text collision detected; constrained node move applied; stale evidence and plan replay rejected; fresh image and geometry checked; exact table rows and executed state preserved; project saved |
| Renderer geometry | Text ranges, node footprints, cubic connector paths, crops/tiles and transforms; unsupported details reported as gaps |
| Mutation guard | Revision and exact-old-value validation for guarded native layout/core paths, one-shot plans, native readback and bounded rollback behavior |
| Operation records | Request identity, durable receipts, duplicate handling, timeout reconciliation and unknown-after-restart states |
| Quality evidence | Task/scope-bound immutable records, separate quality dimensions, full typed table hashing, explicit image review attestation and fail-closed missing coverage |

Native JVM probes exercise 17 internal assertions as part of the suite; those are not 17 additional Node test cases. Discovery exposes 17 MCP tools and 3 resources. Discovery counts do not establish that every advanced native operation was acceptance-tested.

Independent review identified and then rechecked fixes for stale completion scope, cross-task assertion contamination and incomplete capture revision checks. Regression cases now reject those false-success paths. Generated repair coordinates are integers compatible with KNIME.

## Reproduce

Follow [SETUP.md](SETUP.md) using a disposable workspace. From the package directory:

```powershell
npm ci
$env:KNIME_AGENT_RUNTIME = Join-Path (Get-Location) 'runtime\v02'
node scripts/launch.mjs --workspace (Join-Path (Get-Location) 'runtime\workspace-v02')
node src/cli.mjs sessions
node src/cli.mjs health
```

Wait until the intended session is ready and alive, then:

```powershell
node scripts/verify-beta.mjs
```

The verifier first creates a fresh literal fixture through MCP, then supplies its IDs to the complete suite. Native tests run sequentially because the active KNIME project is shared UI state. Plain `npm test` without fixture variables skips native fixture cases and is not full acceptance. Tests create and save disposable workflows; never point them at valuable workspaces.

## Limits and remaining work

- The default image is a preview rendered from the loaded native workflow model. Experimental viewport capture does not certify editor synchronization or complete coordinate mapping. Native dialogs and all third-party node views are not covered.
- Readable images improve visibility but do not prove the agent understood them. Review remains an explicit attestation. The agent must supply meaningful group/pin constraints and inspect the final images.
- List-marker geometry, some rendering details, nested/component fidelity and large-canvas coverage can remain incomplete. Missing coverage must stay visible; zero reported overlaps is not a universal clean-layout certificate.
- Direct layout setters have guarded readback but no gateway undo entry. Generic gateway/lifecycle dispatch has weaker guard coverage than the dedicated native layout/core paths.
- Native visual acceptance directly exercised node movement. Annotation and bendpoint adapters have structural/unit coverage; their complete behavior across arbitrary workflows is not certified.
- Structure/configuration quality dimensions currently support preservation assertions. Persistence cannot be marked passed without trusted saved-artifact verification; the quality tool leaves unsupported proof incomplete even when a separate native save/reopen test passes.
- Arbitrary custom node semantics, opaque ports, concurrent multi-agent stress, crash recovery during every write phase and a clean second-machine installation remain unverified.
- The proposed **20 controlled agent trials have not been run**. The broader visibility/control roadmap is not complete. This release publishes the verified beta scope and retains those evaluation gates for subsequent work.

## Release contents and assumptions

The attached ZIP contains the selected bridge JAR, source, tests, setup/API guides and a per-file SHA-256 manifest. ZIP CRC and all manifest hashes are checked during packaging; the archive has a separate `.sha256` sidecar. Runtime data, credentials, browser profiles, workflow data, Git history and KNIME vendor libraries are excluded.

Windows/KNIME 5.12 is the first supported target; internal APIs require revalidation after upgrades. MCP remains the main agent interface and the CLI calls the same implementation. The guide requires matching server and native bridge versions. v0.1's historical evidence remains in [VERIFICATION.md](VERIFICATION.md); this receipt describes v0.2.
