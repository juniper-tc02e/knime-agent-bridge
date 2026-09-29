# Setup guide — Windows

This is an independent local MCP integration for KNIME Analytics Platform. It does not require KNIME Business Hub, an account token, or a hosted bridge. Your chosen AI client and any external services used by your workflows have their own requirements.

## 1. Install the prerequisites

| Dependency | Requirement |
|---|---|
| Windows | Windows 11, validated target |
| KNIME Analytics Platform | 5.12 modern UI; validated build is recorded in the release receipt |
| Node.js | 22 or newer; Node 24 was used for release testing |
| Microsoft Edge | Required for v0.2 canvas rasterization; runs with a separate temporary profile |
| MCP client | A local client supporting stdio tools; image support is needed for visual inspection |

Get KNIME from [the official download page](https://www.knime.com/downloads) and Node from [nodejs.org](https://nodejs.org/en/download). Install KNIME's required extensions for your own workflows separately. Do not assume a different KNIME build is compatible: this bridge calls version-specific native APIs.

## 2. Download the release package

Open [GitHub Releases](https://github.com/juniper-tc02e/knime-agent-bridge/releases). Download the attached `knime-agent-bridge-<version>.zip` and its `.sha256` file. Use the attached package, **not GitHub's automatically generated Source code ZIP**: the attached package includes the compiled bridge JAR.

Keep v0.1 and v0.2 in separate folders. Extract the selected package to a writable local directory, for example:

```text
C:\Tools\knime-agent-bridge-v02\knime-agent-bridge
```

Compare the downloaded archive hash with the published checksum:

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\knime-agent-bridge-0.3.0.zip" -Algorithm SHA256
Get-Content "$env:USERPROFILE\Downloads\knime-agent-bridge-0.3.0.zip.sha256"
```

Use `0.1.0-beta.1` or `0.2.0-beta.1` in those filenames for an older release.

v0.3 includes the previously local beta.2 reliability fixes. Read [the v0.3 verification receipt](VERIFICATION-0.3.md). Save and close the KNIME instance being upgraded before relaunching; new bridge code cannot replace a JAR already loaded in KNIME. Start a fresh MCP client connection to discover all 18 tools.

## 3. Install the JavaScript dependencies

Open PowerShell in the extracted `knime-agent-bridge` directory:

```powershell
node --version
npm ci
node src/cli.mjs --version
```

The prebuilt package does not require a JDK or Python. `npm ci` downloads the exact dependencies in the lockfile; no API keys are needed. v0.2 uses the installed Edge browser and does not require a Playwright browser download.

## 4. Start KNIME with the bridge

The default KNIME installation location is `%LOCALAPPDATA%\Programs\KNIME`. If yours differs, set its path in the same PowerShell window:

```powershell
$env:KNIME_HOME = 'C:\Program Files\KNIME'
```

Then launch:

```powershell
node scripts/launch.mjs
node src/cli.mjs sessions
node src/cli.mjs health
```

Startup can take one to two minutes. Wait for `status: "ready"` and `alive: true`. The default workspace is the extracted package's `runtime\workspace`, and the launcher creates a private KNIME configuration. The regular KNIME shortcut does not load this bridge.

If KNIME reports a dialog, finish the dialog in its window and retry health. Keep the KNIME application running while using MCP. Acknowledgement from the launcher means a process was started; readiness comes from the bridge health result.

To use an existing workspace, save and close any KNIME process already using that workspace first, then launch with its full path:

```powershell
node scripts/launch.mjs --workspace 'C:\Users\YourName\knime-workspace'
```

KNIME allows only one writer to a workspace. Do not run v0.1 and v0.2 against the same workspace simultaneously. For a second independent instance, use a separate `KNIME_AGENT_RUNTIME` and workspace and pass that same runtime to the MCP client.

## 5. Connect an MCP client

For Codex with its CLI available on PATH, from the package directory:

```powershell
node scripts/register-codex.mjs
```

The script registers `knime-agent` using absolute Node/server paths and preserves unrelated MCP entries. If the Codex executable is elsewhere, set `CODEX_BIN` to its absolute path first. An existing `knime-agent` entry pointing at another installation is reported rather than silently replaced; see the upgrade section.

For another local stdio MCP client, use its equivalent of this configuration, replacing both paths with yours:

```json
{
  "mcpServers": {
    "knime-agent": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Tools\\knime-agent-bridge-v02\\knime-agent-bridge\\src\\server.mjs"]
    }
  }
}
```

If you selected a custom runtime, append `"--runtime", "C:\\Your\\Runtime"` to `args`. Do not put a KNIME workspace path there; a runtime contains the bridge's `sessions` directory.

Start a fresh chat or reload the client's MCP connection to discover the tools. Ask the agent:

> List the KNIME sessions and confirm the workspace. Inspect the available tools and read knime://guide. Do not modify a workflow yet.

For v0.2, the tool list includes `knime_context` and `knime_canvas_view`. Ask the agent to bind an open workflow and return a readable canvas image. Image-capable hosts should display an actual image, not just a file path. A preview is not proof of completed visual review.

## 6. Upgrade or return to v0.1

1. Save the workflows you need and close the old bridge-enabled KNIME instance.
2. Extract the other release into its own folder and run `npm ci` there.
3. Launch the desired workspace with that release's launcher.
4. Inspect the existing MCP registration before replacing it:

```powershell
codex mcp get knime-agent --json
```

5. If it is the old bridge installation you intend to replace:

```powershell
codex mcp remove knime-agent
node scripts/register-codex.mjs
```

6. Reload the MCP connection or start a fresh chat. Confirm `health` reports the intended bridge version and workspace.

v0.2 adds context/revision preconditions to mutations. Existing v0.1 scripts that edit workflows need to bind a context and supply the expected revisions; read the release's API guide. Do not reuse native context, project or node IDs across restarts without rediscovery.

## Troubleshooting

| Symptom | Action |
|---|---|
| `NO_LIVE_SESSION` | Start KNIME with this package's launcher; wait for readiness; confirm the client and launcher use the same runtime. |
| `AMBIGUOUS_SESSION` | Inspect `sessions` and supply `--session ID` or the tool's `session` argument. |
| Old tools/version | Reload MCP; confirm its absolute server path. Rebuilding a JAR does not update a running KNIME process. |
| Workspace locked | Save and close the process already using it, or select a different workspace. |
| Bundle missing/invalid | Use the attached release ZIP, or build the source as described below. Do not rename a mismatched JAR. |
| Canvas renderer unavailable | Confirm Edge is installed; inspect the reported browser compatibility error. Do not treat a missing image as a successful review. |
| `CONTEXT_CHANGED` / `REVISION_CONFLICT` | Inspect current state, bind the intended scope again and replan. Do not retry an old mutation blindly. |
| Request timed out | Inspect the operation receipt and actual workflow. A timeout does not cancel KNIME or prove failure. |

Logs and session descriptors live under `runtime`. They may contain local paths or workflow content; share only the relevant redacted diagnostics in a GitHub issue.

## Building from source

The Git source includes no KNIME vendor libraries. Install compatible KNIME plus JDK 21 or newer, then set the two local paths before compiling:

```powershell
$env:KNIME_HOME = 'C:\Path\To\KNIME'
$env:KNIME_AGENT_JDK = 'C:\Program Files\Java\jdk-24'
npm ci
node scripts/build.mjs
node scripts/launch.mjs
```

The build targets Java 21 bytecode. Native acceptance tests create disposable workflows; read the verification receipt before running them. They must never target production/coursework workspaces. Python 3 is needed only for `python scripts/package.py` when creating a release archive.
