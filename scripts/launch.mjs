import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { BridgeClient } from '../src/client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseWorkspace(argv, runtime) {
  const { values, tokens } = parseArgs({ args: argv, allowPositionals: false, strict: true, tokens: true, options: { workspace: { type: 'string' } } });
  if (tokens.filter(token => token.name === 'workspace').length > 1) throw new Error('The --workspace option must occur only once.');
  if (values.workspace !== undefined && !values.workspace.trim()) throw new Error('--workspace must be a nonempty path.');
  return path.resolve(values.workspace ?? path.join(runtime, 'workspace'));
}

function running(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function workspacePath(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try { return path.resolve(value.startsWith('file:') ? fileURLToPath(value) : value).toLowerCase(); }
  catch { return undefined; }
}

async function atomicJson(target, value) {
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function acquireRuntimeLock(runtime) {
  await fs.mkdir(runtime, { recursive: true });
  const target = path.join(runtime, 'launch.lock');
  const token = randomUUID();
  let handle;
  try { handle = await fs.open(target, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('KNIME launch preparation is already locked: ' + target + '. If a previous launcher crashed, verify its process and any KNIME launch have exited before removing this lock.');
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })); }
  catch (error) { await handle.close(); await fs.unlink(target).catch(() => {}); throw error; }
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    const current = JSON.parse(await fs.readFile(target, 'utf8'));
    if (current.token !== token) throw new Error('Runtime launch lock changed ownership; refusing to remove another launcher lock.');
    await fs.unlink(target);
    released = true;
  };
}

async function existingLaunch(runtime, workspace) {
  const sessions = await new BridgeClient({ runtime }).listSessions();
  let record;
  try { record = JSON.parse(await fs.readFile(path.join(runtime, 'launch.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot validate the prior launch record: ' + error.message); }
  const live = [...sessions.map(session => ({ ...session, session: session.id })), ...(record ? [record] : [])].filter(item => running(item.pid));
  // A published session is preferred, but launch.json guards the interval before
  // the activator publishes its first descriptor. Check every live record first.
  if (live.some(item => workspacePath(item.workspace) !== workspacePath(workspace))) {
    throw new Error('This runtime already has a running KNIME instance for another or unknown workspace. Set KNIME_AGENT_RUNTIME to another directory for an additional workspace.');
  }
  if (!live.length) return null;
  const item = live[0];
  return { alreadyRunning: true, pid: item.pid, ...(item.session ? { session: item.session } : {}), workspace, runtime };
}

export async function seedTelemetryDecline(workspace) {
  const target = path.join(workspace, '.metadata', '.plugins', 'org.eclipse.core.runtime', '.settings', 'org.knime.workbench.core.prefs');
  let original = '';
  try { original = await fs.readFile(target, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Leave every existing choice byte-for-byte intact, including partial choices.
  const keyPresent = key => original.replace(/^\uFEFF/, '').split(/\r?\n/).some(line => {
    const property = line.trimStart();
    return !property.startsWith('#') && !property.startsWith('!') && new RegExp('^' + key.replaceAll('.', '\\.') + '[\\t ]*(?:[:=]|[\\t ])').test(property);
  });
  if (keyPresent('knime.askedToSendStatistics') || keyPresent('knime.sendAnonymousStatistics')) return;
  const additions = [];
  if (!keyPresent('eclipse.preferences.version')) additions.push('eclipse.preferences.version=1');
  additions.push('knime.askedToSendStatistics=true', 'knime.sendAnonymousStatistics=false');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, original + (original && !original.endsWith('\n') ? '\n' : '') + additions.join('\n') + '\n');
}

export async function seedModernUi(config) {
  const directory=path.join(config,'.settings');
  await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,'org.knime.ui.java.prefs');
  let preferences=await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  if(!/^eclipse.preferences.version=/m.test(preferences))preferences+='\neclipse.preferences.version=1\n';
  if(/^startWithWebUI=/m.test(preferences))preferences=preferences.replace(/^startWithWebUI=.*$/m,'startWithWebUI=true');
  else preferences+='\nstartWithWebUI=true\n';
  await fs.writeFile(file,preferences);
}

export async function launchKnime({ argv = process.argv.slice(2), env = process.env, spawnProcess = spawn } = {}) {
  const knime = env.KNIME_HOME || path.join(env.LOCALAPPDATA, 'Programs', 'KNIME');
  const runtime = path.resolve(env.KNIME_AGENT_RUNTIME || path.join(root, 'runtime'));
  const workspace = parseWorkspace(argv, runtime);
  const release = await acquireRuntimeLock(runtime);
  let childStarted = false, recorded = false;
  try {
    const existing = await existingLaunch(runtime, workspace);
    if (existing) return existing;
    const config = path.join(runtime, 'configuration');
    await fs.mkdir(path.join(config, 'org.eclipse.equinox.simpleconfigurator'), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const originalConfig = await fs.readFile(path.join(knime, 'configuration', 'config.ini'), 'utf8');
    const originalBundles = await fs.readFile(path.join(knime, 'configuration', 'org.eclipse.equinox.simpleconfigurator', 'bundles.info'), 'utf8');
    const lines = originalBundles.split(/\r?\n/).filter(Boolean).map(line => {
      if (line.startsWith('#')) return line;
      const fields = line.split(',');
      if (!fields[2].startsWith('file:')) fields[2] = pathToFileURL(path.resolve(knime, fields[2])).href;
      return fields.join(',');
    });
    let bundleName='org.knime.agent.bridge_0.2.0.beta1.jar';
    try {
      const latest=JSON.parse(await fs.readFile(path.join(root,'artifacts','latest.json'),'utf8'));
      if(!/^org\.knime\.agent\.bridge_0\.2\.0\.beta1-[a-f0-9]{12}\.jar$/.test(latest.bundle))throw new Error('Invalid built bundle name in artifacts/latest.json');
      bundleName=latest.bundle;
    } catch(error) {if(error.code!=='ENOENT')throw error;}
    const bundle = path.join(root, 'artifacts', bundleName);
    await fs.access(bundle);
    lines.push(['org.knime.agent.bridge', '0.2.0.beta1', pathToFileURL(bundle).href, '4', 'true'].join(','));
    await fs.writeFile(path.join(config, 'org.eclipse.equinox.simpleconfigurator', 'bundles.info'), lines.join('\n') + '\n');
    // p2 does not URL-decode this location. Retain the config-relative form and
    // private profile copy so paths containing spaces remain valid.
    try { await fs.access(path.join(runtime, 'p2', 'org.eclipse.equinox.p2.engine', 'profileRegistry')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.cp(path.join(knime, 'p2'), path.join(runtime, 'p2'), { recursive: true });
    }
    const updated = originalConfig.replace(/^eclipse.p2.data.area=.*$/m, 'eclipse.p2.data.area=@config.dir/../p2/');
    await fs.writeFile(path.join(config, 'config.ini'), updated);
    await seedModernUi(config);
    const ini = await fs.readFile(path.join(knime, 'knime.ini'), 'utf8');
    const iniLines = ini.split(/\r?\n/);
    const vmArgs = iniLines.slice(iniLines.indexOf('-vmargs') + 1).filter(Boolean).map(value => value.startsWith('-Xmx') ? '-Xmx4g' : value);
    await seedTelemetryDecline(workspace);
    const logPath = path.join(runtime, 'knime.log');
    const log = await fs.open(logPath, 'a');
    let child;
    try {
      const launchArgs = ['-clean', '-nosplash', '-consoleLog', '-configuration', config, '-data', workspace, '-vmargs', ...vmArgs, '-Dknime.agent.runtime=' + runtime];
      child = spawnProcess(path.join(knime, 'knime.exe'), launchArgs, { cwd: knime, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });
      childStarted = true;
      child.unref();
    } finally { await log.close(); }
    await atomicJson(path.join(runtime, 'launch.json'), { pid: child.pid, workspace, config, startedAt: new Date().toISOString() });
    recorded = true;
    return { pid: child.pid, workspace, runtime, log: logPath };
  } finally {
    // If the process started but recording failed, keep the lock: an unknown
    // launch outcome must never permit a second writer into its configuration.
    if (!childStarted || recorded) await release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchKnime().then(result => { process.stdout.write(JSON.stringify(result) + '\n'); }).catch(error => {
    process.stderr.write(JSON.stringify({ error: { code: 'LAUNCH_ERROR', message: error.message } }) + '\n');
    process.exitCode = 1;
  });
}

