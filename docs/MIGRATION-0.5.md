# Migrate to v0.5 with an explicit route

v0.5 adds named connection profiles, bounded native diagnostics, asynchronous history paging, complete-result detail references and full table verification. The MCP catalogue contains **25 tools**. Keep the earlier package, runtime, workspace and MCP entry available while qualifying the new route. A package version, configured Node server and loaded native JAR are separate identities.

Supported deployment target: Windows 11, KNIME Analytics Platform 5.12.0, Node.js 22 or later and the packaged Java 21-targeted native bundle. The lifecycle measurements used Node 24.15.0. Prebuilt release usage does not require a local JDK; rebuilding does. See [SETUP.md](SETUP.md) for installation prerequisites and [VERIFICATION-0.5.md](VERIFICATION-0.5.md) for the actual acceptance scope.

## 1. Keep the existing connection intact

Extract the release ZIP into its own directory, for example `C:\Tools\knime-agent-bridge-v05\knime-agent-bridge`. Use the release attachment containing the compiled JAR; a repository source archive alone is not the installed native bundle.

Inspect the existing Codex entry without changing it:

```powershell
codex mcp get knime-agent --json
```

Record its Node command, server path, arguments and runtime. Preserve that entry and its earlier files. Do not run `register-codex.mjs` as an automatic migration step: it registers the default `knime-agent` name and deliberately refuses an existing entry pointing elsewhere. The trial below uses a separate alias.

## 2. Launch a separate synthetic workspace

Run this in a new PowerShell window. Replace the generic package and KNIME installation paths with your installation paths. These environment assignments affect this shell and its children; they do not rewrite the global MCP configuration.

```powershell
$package = 'C:\Tools\knime-agent-bridge-v05\knime-agent-bridge'
$node = (Get-Command node -ErrorAction Stop).Source
Set-Location -LiteralPath $package
& $node --version
npm ci

$env:KNIME_HOME = 'C:\Tools\KNIME'
$env:KNIME_AGENT_RUNTIME = Join-Path $package 'runtime-v05-trial'
$workspace = Join-Path $env:KNIME_AGENT_RUNTIME 'workspace'
& $node scripts/launch.mjs --workspace $workspace
& $node src/cli.mjs sessions --runtime $env:KNIME_AGENT_RUNTIME
```

The launcher creates a private configuration and runtime. Its existing-process checks may return `alreadyRunning:true`; launching again does not reload a JAR into that process. Never have two KNIME processes writing the same workspace. A parallel trial requires a distinct writable workspace, not a second process opening the earlier workspace.

Wait for the intended descriptor to become ready. An unavailable, stale, stopped or dead descriptor remains visible for diagnosis. Its historical readiness is not authority to dispatch. The trial must not operate an earlier live workspace merely because a session ID is known.

## 3. Pin the observed route and expected bundle

The profile is a small UTF-8 JSON file, at most 64 KiB. It requires `schemaVersion:1` and a `profiles` map. Every profile contains exactly these four nonempty string fields:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "trial-v05": {
      "runtime": "C:\\Tools\\knime-agent-bridge-v05\\knime-agent-bridge\\runtime-v05-trial",
      "session": "SESSION-ID-FROM-DISCOVERY",
      "bridgeVersion": "0.5.0",
      "bundleFingerprint": "SHA256-OF-THE-EXPECTED-LOADED-JAR"
    }
  }
}
```

Profile names are 1–64 characters: letters, digits, dot, underscore and hyphen, beginning with a letter or digit. Relative `runtime` paths resolve against the profile file's directory. A profile's `session` is an ID from that runtime's discovery, never a path. No profile means the legacy explicit `--runtime`/`--session` route remains available without a version/bundle compatibility constraint.

For a fresh trial containing exactly one ready instance, create the file from discovery and independently compare its loaded-bundle fingerprint to the expected package JAR:

```powershell
$discovery = (& $node src/cli.mjs sessions --runtime $env:KNIME_AGENT_RUNTIME) | ConvertFrom-Json
$ready = @($discovery.sessions | Where-Object { $_.alive -eq $true })
if ($ready.Count -ne 1) { throw 'Select and review one intended ready trial session explicitly.' }
$session = $ready[0]
if ($session.bridgeVersion -ne '0.5.0') { throw 'The loaded native bridge is not v0.5.0.' }

$latest = Get-Content -LiteralPath (Join-Path $package 'artifacts\latest.json') -Raw | ConvertFrom-Json
$jar = Join-Path (Join-Path $package 'artifacts') $latest.bundle
$expectedBundle = (Get-FileHash -LiteralPath $jar -Algorithm SHA256).Hash.ToLowerInvariant()
if ($session.bundleFingerprint -ne $expectedBundle) { throw 'Loaded native JAR and expected package JAR differ.' }

$profiles = @{
  schemaVersion = 1
  profiles = @{
    'trial-v05' = @{
      runtime = $env:KNIME_AGENT_RUNTIME
      session = $session.id
      bridgeVersion = '0.5.0'
      bundleFingerprint = $expectedBundle
    }
  }
}
$profileFile = Join-Path $package 'profiles.json'
$profiles | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $profileFile -Encoding UTF8
& $node src/cli.mjs connection --profile trial-v05 --profiles-file $profileFile
& $node src/cli.mjs health --profile trial-v05 --profiles-file $profileFile
```

The ready descriptor should also identify the intended PID/start, KNIME version and synthetic workspace. Native fingerprinting reads the bundle location reported by the loaded OSGi bundle. Comparing it with the expected packaged file is a separate check from the Node source version. A `health` response observes native responsiveness; descriptor readiness alone does not prove it or UI responsiveness.

Before publishing a native request, the client refuses a wrong profile version or bundle with `PROFILE_INCOMPATIBLE`. Conflicting explicit `--runtime` or `--session` values fail with `PROFILE_CONFLICT`. It does not silently select another profile or ready instance. Canonical runtime and process identities remain pinned for each client: replacement links, process restarts or changed identity fields require a new reviewed client.

## 4. Add a separate MCP trial entry

If you choose to register the trial, add an alias without removing or replacing the earlier entry. Use the actual absolute Node path returned by `$node`:

```powershell
codex mcp add knime-v05-trial -- $node (Join-Path $package 'src\server.mjs') --profile trial-v05 --profiles-file $profileFile
```

For a client configured through JSON, add an equivalent separate entry. This example assumes Node is installed at `C:\Tools\nodejs\node.exe`; use your actual executable path.

```json
{
  "mcpServers": {
    "knime-v05-trial": {
      "command": "C:\\Tools\\nodejs\\node.exe",
      "args": [
        "C:\\Tools\\knime-agent-bridge-v05\\knime-agent-bridge\\src\\server.mjs",
        "--profile", "trial-v05",
        "--profiles-file", "C:\\Tools\\knime-agent-bridge-v05\\knime-agent-bridge\\profiles.json"
      ]
    }
  }
}
```

Open a fresh client connection or reload its MCP connection. Confirm the **25-tool** catalogue and read `knime://guide`. Start with `knime_connection {}`; request `{"detail":true}` when the bounded default session summary is insufficient. Then call `knime_health {}` and `knime_diagnostics {}` through the trial alias. Do not operate the earlier alias inadvertently.

Optional server startup flags are `--trace-directory PATH` for client metadata traces and `--lifecycle-file PATH` for a per-instance connection/EOF receipt. See [OBSERVABILITY-0.5.md](OBSERVABILITY-0.5.md). Choose a distinct lifecycle filename for each separately launched server if retaining multiple receipts; one filename is not a shared multi-instance journal.

## 5. Preserve mutation targeting and revision guards

Arguments are strict. `resultMode` is accepted by every MCP tool; routing profile options are server startup options, not tool arguments. A tool's `session` cannot switch the server's runtime. `knime_operation` uses `sessionId`, whereas live native tools generally use `session`.

First discover installed contracts:

```json
{"operation":"core.describe","args":{}}
```

Send that to `knime_core_call`. Discover gateway methods with `knime_describe` and desktop actions with `knime_desktop_call {"operation":"desktop.describe","args":{}}`. Do not infer a node factory, settings path or method schema from another KNIME installation.

For an authorized workflow create/open in the synthetic workspace, bind a session-only context:

```json
{"action":"bind","session":"SESSION-ID-FROM-DISCOVERY"}
```

Send it to `knime_context`, then replace the context placeholder in this installed local-workspace example for `knime_gateway_call`:

```json
{
  "method":"SpaceService.createWorkflow",
  "params":{"spaceProviderId":"local","spaceId":"local","itemId":"root","itemName":"V05 Synthetic Trial"},
  "session":"SESSION-ID-FROM-DISCOVERY",
  "precondition":{"contextId":"RETURNED-WORKSPACE-CONTEXT","expected":{}}
}
```

Use the returned item ID with `knime_desktop_call`:

```json
{
  "operation":"desktop.openProject",
  "args":{"spaceProviderId":"local","spaceId":"local","itemId":"RETURNED-ITEM-ID"},
  "session":"SESSION-ID-FROM-DISCOVERY",
  "precondition":{"contextId":"RETURNED-WORKSPACE-CONTEXT","expected":{}}
}
```

`expected:{}` is intentional for a workspace-only context; `expected:null` is invalid. Opening an editor tab is acknowledgement. Use `knime_wait` with `condition:"opened"` and exact `origin:{providerId:"local",spaceId:"local",itemId:"RETURNED-ITEM-ID"}` to observe a loaded native project, then obtain its actual `projectId`.

Bind a project/scope context, then inspect that same binding before a mutation:

```json
{"action":"bind","session":"SESSION-ID-FROM-DISCOVERY","projectId":"RETURNED-PROJECT-ID","workflowId":"root"}
```

```json
{"action":"inspect","contextId":"RETURNED-PROJECT-CONTEXT"}
```

Use the exact returned `revisions` object as `precondition.expected`. The following `knime_core_call` is an argument template for an already authorized execution of a discovered native node; replace all revision strings with the inspected values:

```json
{
  "operation":"core.execute",
  "args":{"projectId":"RETURNED-PROJECT-ID","workflowId":"root","nodeId":"0:3"},
  "session":"SESSION-ID-FROM-DISCOVERY",
  "precondition":{
    "contextId":"RETURNED-PROJECT-CONTEXT",
    "expected":{"structure":"CURRENT-STRUCTURE","configuration":"CURRENT-CONFIGURATION","layout":"CURRENT-LAYOUT","execution":"CURRENT-EXECUTION"}
  }
}
```

Use IDs actually returned by `knime_workflow`. For a node inside a discovered nested scope such as `0:3`, bind that scope separately and use its native node ID, for example `0:3:7`, with `workflowId:"0:3"`. A root context does not authorize an unrelated nested scope. Gateway IDs such as `root:1`, native IDs and table port indices are different contracts. `knime_table.portIndex` is the native output index: flow-variable output is normally 0, first data output normally 1. Inspect `outputPorts`; do not assume every node follows the same port layout.

Refresh by inspecting, not repeatedly rebinding. Read context usage and release only an owned binding when outstanding operations and later assessments no longer need it. Release does not cancel a native effect already dispatched and does not remove historical evidence.

## 6. Account for response compatibility

MCP results keep the machine-readable payload in `structuredContent`; `content[0].text` is a concise summary, not another full JSON copy. Consumers must stop parsing that text as the complete result.

Default `resultMode:"compact"` stores payloads above 128 KiB as immutable complete-detail records and returns a reference. Explicit `resultMode:"full"` keeps the entire structured payload inline; text remains concise. Use bounded native pages and `knime_detail` when possible. This rendering policy applies to MCP tool responses; the CLI prints the returned JSON directly. It does not turn CLI output into the MCP compact envelope.

History pages now expose metadata, cursors and optional deltas. They are checked against current disk state and are not persisted evidence snapshots or cached successful payloads. See [OBSERVABILITY-0.5.md](OBSERVABILITY-0.5.md) for complete retrieval and invalidation rules.

## 7. Activation, restart and rollback

Installing or rebuilding a bundle does not replace the JAR in an already running KNIME process. For a deliberate activation change: save the work you need, close only the intended owned instance normally, launch the desired package in its intended workspace, discover the new session and regenerate/review the profile. Restart or reload the client connection as well so it reads the new source/profile. Never weaken expected fingerprints to make an unreviewed replacement pass.

Keep the trial route until its functional, visual and persistence evidence is sufficient for your workflow. Native port export is still a separate verification question; these migration instructions make no export-portability claim.

To roll back the trial, select the preserved earlier alias/package and verify its route and native identity. If you choose to remove only the trial Codex entry, use:

```powershell
codex mcp remove knime-v05-trial
```

Close its owned stdio connection and, after saving needed work, its separate KNIME trial process normally. Preserve the trial's runtime, receipts and failed evidence for diagnosis. Do not point an earlier version at the trial workspace without a reviewed compatibility plan, delete evidence to improve timings, or stop unrelated Node/KNIME processes.
