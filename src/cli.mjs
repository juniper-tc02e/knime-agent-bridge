#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BridgeClient, BridgeError } from './client.mjs';
import { dispatchTool, errorPayload } from './catalog.mjs';

export const VERSION = '0.1.0-beta.1';
const HELP = `KNIME Agent Bridge ${VERSION}

Usage: knime-agent <command> [arguments] [options]

Commands:
  sessions                           List live and unavailable local sessions
  health                             Inspect the selected KNIME instance
  describe [Service [method]]        Discover installed methods and schemas
  call Service.method                Invoke a discovered gateway method
  core core.operation                Invoke a documented native core operation
  desktop desktop.operation          Invoke a discovered visible editor action
  mcp                                Start the MCP stdio server

Options:
  --runtime PATH                     IPC runtime directory (or KNIME_AGENT_RUNTIME)
  --session ID                       Explicit session; required if several are live
  --params JSON                      Named object or positional array for gateway call
  --args JSON                        Named object for core/desktop call
  --args-file PATH                    UTF-8 JSON file for call/core/desktop arguments
  --service NAME --method NAME        Optional describe filters
  --entity NAME                      Describe an installed command/entity schema
  --timeout-ms N                     Response timeout (default 30000)
  --json                             JSON output (default for every data command)
  -h, --help                         Show this help
  -v, --version                      Show version

Use describe before advanced calls. Timed-out requests are never retried or
cancelled: inspect workflow state before deciding to retry a mutation.
`;

export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      runtime: { type: 'string' }, session: { type: 'string' }, params: { type: 'string' }, args: { type: 'string' },
      'args-file': { type: 'string' }, service: { type: 'string' }, method: { type: 'string' }, entity: { type: 'string' },
      'timeout-ms': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    } });
  } catch (error) { throw new BridgeError('INVALID_ARGUMENT', error.message); }
  const { values, positionals } = parsed;
  const timeoutMs = values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)) throw new BridgeError('INVALID_ARGUMENT', '--timeout-ms must be an integer between 1 and 3600000.');
  return { values, positionals, clientOptions: { runtime: values.runtime, session: values.session, timeoutMs } };
}

async function jsonArgs(values, command) {
  const inline = command === 'call' ? values.params : values.args;
  if (values['args-file'] !== undefined && inline !== undefined) throw new BridgeError('INVALID_ARGUMENT', 'Use either --args-file or the inline JSON option, not both.');
  let raw = inline;
  if (values['args-file'] !== undefined) {
    try { raw = (await readFile(values['args-file'], 'utf8')).replace(/^\uFEFF/, ''); }
    catch (error) { throw new BridgeError('INVALID_ARGUMENT', `Cannot read --args-file: ${error.message}`); }
  }
  if (raw === undefined) return command === 'call' ? [] : {};
  try { return JSON.parse(raw); }
  catch (error) { throw new BridgeError('INVALID_ARGUMENT', `Invalid JSON arguments: ${error.message}`); }
}

export async function runCli(argv = process.argv.slice(2)) {
  const { values, positionals, clientOptions } = parseCli(argv);
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (values.help || positionals.length === 0) { process.stdout.write(HELP); return; }
  const [command, ...rest] = positionals;
  const client = new BridgeClient(clientOptions);
  const allowed = {
    sessions: [], health: [], describe: ['service', 'method', 'entity'], call: ['params', 'args-file'], core: ['args', 'args-file'], desktop: ['args', 'args-file'], mcp: [],
  };
  if (!(command in allowed)) throw new BridgeError('INVALID_ARGUMENT', `Unknown command '${command}'. Use --help.`);
  for (const key of ['params', 'args', 'args-file', 'service', 'method', 'entity']) {
    if (values[key] !== undefined && !allowed[command].includes(key)) throw new BridgeError('INVALID_ARGUMENT', `--${key} is not valid for ${command}.`);
  }
  if (rest.length > (command === 'describe' ? 2 : ['call', 'core', 'desktop'].includes(command) ? 1 : 0)) throw new BridgeError('INVALID_ARGUMENT', `Too many positional arguments for ${command}.`);
  if (command === 'mcp') { const { startServer } = await import('./server.mjs'); await startServer({ client }); return; }
  let name, input;
  if (command === 'sessions') { name = 'knime_sessions'; input = {}; }
  if (command === 'health') { name = 'knime_health'; input = {}; }
  if (command === 'describe') { name = 'knime_describe'; input = { service: values.service ?? rest[0], method: values.method ?? rest[1], entity: values.entity }; }
  if (command === 'call') { name = 'knime_gateway_call'; input = { method: rest[0], params: await jsonArgs(values, command) }; }
  if (command === 'core') { name = 'knime_core_call'; input = { operation: rest[0], args: await jsonArgs(values, command) }; }
  if (command === 'desktop') { name = 'knime_desktop_call'; input = { operation: rest[0], args: await jsonArgs(values, command) }; }
  const result = await dispatchTool(client, name, input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(error => { process.stderr.write(`${JSON.stringify(errorPayload(error))}\n`); process.exitCode = 1; });
}
