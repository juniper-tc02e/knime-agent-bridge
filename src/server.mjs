#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient, BridgeError } from './client.mjs';
import { toolCatalog, operationGuide, dispatchTool, structuredResult, errorPayload } from './catalog.mjs';
import { VERSION, parseCli } from './cli.mjs';

export function createServer({ client = new BridgeClient() } = {}) {
  const server = new McpServer({ name: 'knime-agent-bridge', version: VERSION }, {
    instructions: 'Read knime://guide. Inspect knime_connection, knime_sessions and knime_health to confirm runtime/PID/workspace, then bind knime_context to the intended project/scope once. Inspect that binding to refresh revisions; release it when no queued/in-flight operation or later quality assessment needs it. Read usage before exhaustion; prune only invalid models. Workspace create/open uses expected:{}, graph changes use current revisions. Preview typed settings with knime_settings_preview before apply; inspect native-resolved model settings and upstream variables with knime_dependencies before reading run-specific data. Discover installed gateway/core contracts. For canvas work, obtain actual PNG images, inspect readable tiles, check geometry and re-render after edits. A screenshot generated, command acknowledged or node executed is not completion. Keep functional, visual and persistence evidence separate. Timeout is unknown: reconcile the original knime_operation ID/session without replay. Do not invoke Kai, Hub, external or paid services merely for context.',
  });
  for (const tool of toolCatalog) {
    const { name, run: _run, ...config } = tool;
    server.registerTool(name, config, async input => {
      try { return structuredResult(await dispatchTool(client, name, input)); }
      catch (error) { return structuredResult(errorPayload(error), true); }
    });
  }
  // The high-level SDK normally strips unknown input keys and renders schema
  // errors as plain text. Validate raw arguments through the shared strict
  // catalogue so a misspelled session key cannot route a call elsewhere, and
  // callers always receive the same structured error envelope as the CLI.
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.task !== undefined) throw new BridgeError('INVALID_ARGUMENT', 'This bridge does not support MCP background tasks.');
      return structuredResult(await dispatchTool(client, request.params.name, request.params.arguments ?? {}));
    } catch (error) { return structuredResult(errorPayload(error), true); }
  });
  const resources = [
    { name: 'guide', uri: 'knime://guide', description: 'Operational guide: capability discovery, complete workflow context, visible editor, validation and safe timeout handling.', read: async () => operationGuide },
    { name: 'sessions', uri: 'knime://sessions', description: 'Local KNIME sessions, workspaces, versions and heartbeat availability.', read: async () => ({ runtime:client.runtime, sessions: await client.listSessions() }) },
    { name:'connection',uri:'knime://connection',description:'Configured runtime and selected process identity; descriptor readiness is distinct from responsiveness.',read:()=>client.connectionDiagnostics() },
    { name: 'capabilities', uri: 'knime://capabilities', description: 'Service and method capabilities from the selected live KNIME bridge. Use an explicit server --session if multiple instances are running.', read: () => client.call('gateway.describe', {}) },
  ];
  for (const resource of resources) {
    server.registerResource(resource.name, resource.uri, { description: resource.description, mimeType: 'application/json' }, async uri => {
      try { return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await resource.read()) }] }; }
      catch (error) { throw new McpError(ErrorCode.InternalError, error.message, errorPayload(error)); }
    });
  }
  return server;
}

export async function startServer(options = {}) {
  const server = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const { clientOptions, values, positionals } = parseCli(process.argv.slice(2));
    if (positionals.length || Object.keys(values).some(key => !['runtime', 'session', 'timeout-ms'].includes(key))) throw new BridgeError('INVALID_ARGUMENT', 'Server accepts only --runtime, --session and --timeout-ms. Use cli.mjs --help for command help.');
    await startServer({ client: new BridgeClient(clientOptions) });
  })().catch(error => { process.stderr.write(`${JSON.stringify(errorPayload(error))}\n`); process.exitCode = 1; });
}
