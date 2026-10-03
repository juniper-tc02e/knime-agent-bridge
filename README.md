# KNIME Agent Bridge

**Local MCP + CLI access to the running KNIME Analytics Platform.**

Inspect workflows and node settings, edit native graphs, run nodes, read outputs, and save projects from a local AI client. MCP is the agent interface; the CLI uses the same native bridge for scripts and diagnosis.

**Current package: 0.4.0.** Independent integration; not an official KNIME product. No Business Hub subscription or hosted bridge is required. AI-client and external workflow-service costs are separate.

v0.4 provides 21 MCP tools: context usage/release/pruning, pinned runtime and process diagnostics, detached typed settings preview with native validation, and variable-resolved dependency inspection. Filtered evidence lookup avoids repeatedly parsing unrelated retained history while preserving fresh selected-record integrity checks. It preserves known operation outcomes after retention expiry and exposes original-UUID reconciliation without automatic replay. Native graph editing, execution, paged data, canvas previews and guarded visual quality checks remain available.

## Get started

1. Install KNIME Analytics Platform 5.12 on Windows 11 and Node.js 22+.
2. Download the attached package from [Releases](https://github.com/juniper-tc02e/knime-agent-bridge/releases). The attached ZIP includes the compiled JAR; GitHub's automatic source ZIP does not.
3. Extract it, open PowerShell in its `knime-agent-bridge` folder, and run:

```powershell
npm ci
node scripts/launch.mjs
node src/cli.mjs sessions
node src/cli.mjs health
node scripts/register-codex.mjs
```

Wait for KNIME readiness before connecting. v0.2 canvas rendering also needs the installed Microsoft Edge browser. Keep a separate folder/runtime for each version.

**[Full setup, MCP configuration, upgrades and troubleshooting](docs/SETUP.md)**

## Versions

| Release | Focus |
|---|---|
| [v0.4](https://github.com/juniper-tc02e/knime-agent-bridge/releases/tag/v0.4.0) | Context lifecycle, runtime identity, settings preflight, effective dependencies and operation reconciliation |
| [v0.3](https://github.com/juniper-tc02e/knime-agent-bridge/releases/tag/v0.3.1) | Settings reliability, Windows recovery, readable load warnings and completion polling |
| [v0.1 beta](https://github.com/juniper-tc02e/knime-agent-bridge/releases/tag/v0.1.0-beta.1) | Native workflow editing, configuration, execution and output inspection |
| [v0.2 beta](https://github.com/juniper-tc02e/knime-agent-bridge/releases/tag/v0.2.0-beta.1) | Canvas visibility, layout checks and guarded quality workflow |

[Read the exact verification evidence](docs/VERIFICATION-0.4.md) before relying on a capability. Internal KNIME APIs are version-specific; other platforms/builds need verification. v0.1/v0.2 remain available as historical prereleases.

## Agent workflow

Discover the correct runtime, session and workspace. Read `knime://guide`. Bind the intended scope once, inspect to refresh it, preview settings changes and inspect effective variable bindings. Verify execution and full output data independently, inspect readable canvas images, verify the saved artifact, then release the context. A command acknowledgement or generated screenshot does not by itself establish completion.

Native advanced calls can invoke workflow side effects. Use the same authorization you would require when operating KNIME yourself. Session/revision guards prevent specific targeting mistakes; they are not a sandbox for arbitrary workflow code.

## Documentation

- [Setup and upgrade guide](docs/SETUP.md)
- [Native settings/data API](docs/CORE_API.md)
- [Gateway discovery and graph commands](docs/GATEWAY_API.md)
- [Verified behavior and limits](docs/VERIFICATION-0.4.md)
- [Canvas and context API](docs/VISUAL_API.md)
- [Quality evidence contract](docs/QUALITY_CONTRACT.md)
- [Context lifecycle](docs/CONTEXT_LIFECYCLE.md)
- [Connections and recovery](docs/CONNECTIONS.md)
- [Settings preflight](docs/SETTINGS_PREFLIGHT.md)
- [Effective dependencies](docs/DEPENDENCIES.md)
- [Diagnosis and migration limits](docs/DIAGNOSIS-0.4.md)
