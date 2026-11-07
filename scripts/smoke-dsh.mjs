#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = fileURLToPath(import.meta.url);
const PNPM_VERSION = '10.16.1';
const DSH_PROFILE = 'web';
const CHILD_TIMEOUT_MS = 120_000;
const HOST_TIMEOUT_MS = 90_000;

function invariant(condition, message) {
  assert.ok(condition, message);
}

function isolatedEnvironment(root) {
  const home = path.join(root, 'home');
  const dshHome = path.join(root, 'dsh-home');
  const agentsHome = path.join(home, '.agents');
  const xdgConfig = path.join(root, 'xdg-config');
  const xdgCache = path.join(root, 'xdg-cache');
  const xdgData = path.join(root, 'xdg-data');
  const xdgState = path.join(root, 'xdg-state');
  const temp = path.join(root, 'tmp');
  const npmCache = path.join(root, 'npm-cache');
  const userConfig = path.join(root, 'empty.npmrc');
  const globalConfig = path.join(root, 'empty-global.npmrc');
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const inherited = { PATH: pathValue };
  for (const name of ['LANG', 'LC_ALL']) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
      if (process.env[name] !== undefined) inherited[name] = process.env[name];
    }
  }
  const rootEnv = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_globalconfig: globalConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    npm_config_registry: 'https://registry.npmjs.org',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    DSH_TELEMETRY_DISABLED: '1',
    OIL_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    CI: '1',
  };
  if (process.platform === 'win32') {
    const parsed = path.parse(home);
    rootEnv.HOMEDRIVE = parsed.root.replace(/[\\/]$/, '');
    rootEnv.HOMEPATH = home.slice(parsed.root.length);
  }
  return { env: rootEnv, dirs: { home, dshHome, agentsHome, temp, npmCache, userConfig, globalConfig } };
}

async function createIsolation(root) {
  const isolated = isolatedEnvironment(root);
  await Promise.all(
    [
      isolated.dirs.home,
      isolated.dirs.dshHome,
      isolated.dirs.agentsHome,
      isolated.env.XDG_CONFIG_HOME,
      isolated.env.XDG_CACHE_HOME,
      isolated.env.XDG_DATA_HOME,
      isolated.env.XDG_STATE_HOME,
      isolated.dirs.temp,
      isolated.dirs.npmCache,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
  await writeFile(isolated.dirs.userConfig, '', { mode: 0o600 });
  await writeFile(isolated.dirs.globalConfig, '', { mode: 0o600 });
  return isolated;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolve) => {
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  await wait(1000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
}

function runChild(command, args, { cwd, env, timeoutMs = CHILD_TIMEOUT_MS, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    let terminationPromise;
    const timer = setTimeout(() => {
      timedOut = true;
      terminationPromise = terminateProcessTree(child);
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label} could not start (${error.code ?? error.name}).`));
    });
    child.once('close', async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        await terminationPromise;
        reject(new Error(`${label} exceeded ${timeoutMs} ms and its process group was terminated.`));
      } else if (code !== 0) {
        reject(new Error(`${label} failed (exit ${code ?? 'unknown'}${signal ? `, ${signal}` : ''}).`));
      } else {
        resolve();
      }
    });
  });
}

async function findInstalledDsh() {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const lookupEnv = { PATH: process.env.PATH ?? process.env.Path ?? '' };
  for (const name of ['LANG', 'LC_ALL']) {
    if (process.env[name] !== undefined) lookupEnv[name] = process.env[name];
  }
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
      if (process.env[name] !== undefined) lookupEnv[name] = process.env[name];
    }
  }
  const child = spawn(lookup, ['dsh'], {
    env: lookupEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const lines = Buffer.concat(chunks)
    .toString('utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  invariant(result === 0 && lines.length > 0, 'The installed DSH CLI was not found by which dsh.');
  const cliPath = await realpath(lines[0]);
  let directory = path.dirname(cliPath);
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === '@deepseek-ai/dsh') {
        const profileBoot = path.join(directory, 'lib', 'profile-boot.js');
        const require = createRequire(path.join(directory, 'package.json'));
        const appBoot = require.resolve('@deepseek-ai/dsh-app-boot');
        await access(profileBoot);
        await access(appBoot);
        return { cliPath, directory, version: manifest.version, profileBoot, appBoot };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error('which dsh resolved a CLI outside an @deepseek-ai/dsh installation.');
}

async function selectPnpm(root, isolated) {
  const configured = process.env.DSH_SMOKE_PNPM;
  if (configured !== undefined && configured !== '') {
    invariant(path.isAbsolute(configured), 'DSH_SMOKE_PNPM must be an absolute pnpm executable path.');
    const resolved = await realpath(configured);
    const file = await stat(resolved);
    invariant(file.isFile(), 'DSH_SMOKE_PNPM must point to a file.');
    if (process.platform !== 'win32') await access(resolved, 1);
    return { path: resolved, source: 'provided' };
  }

  const installPrefix = path.join(root, 'temporary-pnpm');
  await mkdir(installPrefix, { recursive: true });
  const npmExecPath = process.env.npm_execpath;
  invariant(
    npmExecPath && path.isAbsolute(npmExecPath),
    'Run this script through npm so it can use the active npm CLI.',
  );
  await access(npmExecPath);
  const npmEnvironment = {
    ...isolated.env,
    PATH: process.env.PATH ?? process.env.Path ?? '',
  };
  await runChild(
    process.execPath,
    [
      npmExecPath,
      'install',
      '--prefix',
      installPrefix,
      '--no-save',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
      `pnpm@${PNPM_VERSION}`,
    ],
    {
      cwd: root,
      env: npmEnvironment,
      timeoutMs: CHILD_TIMEOUT_MS,
      label: `Temporary pnpm ${PNPM_VERSION} download`,
    },
  );
  const command = path.join(installPrefix, 'node_modules', '.bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  const resolved = await realpath(command);
  return { path: resolved, source: `temporary-pnpm-${PNPM_VERSION}` };
}

async function exposePnpmOnPath(root, pnpmPath) {
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  if (process.platform === 'win32') {
    const command = path.join(bin, 'pnpm.cmd');
    const nodeScript = path.extname(pnpmPath).toLowerCase() === '.cmd' ? pnpmPath : '';
    if (nodeScript) {
      await writeFile(command, `@call "${nodeScript}" %*\r\n`, { mode: 0o700 });
    } else {
      await writeFile(command, `@"${process.execPath}" "${pnpmPath}" %*\r\n`, { mode: 0o700 });
    }
    return bin;
  }
  const command = path.join(bin, 'pnpm');
  await symlink(pnpmPath, command);
  return bin;
}

function fixtureFiles() {
  const rawBody = [
    '',
    '# Original Pro fixture',
    '',
    'RAW_PRO_BODY_SENTINEL: this exact instruction text must survive native loading.',
    '',
    'Read `references/reviewer-manual.md` when the task explicitly requests a review.',
    '',
  ].join('\n');
  // DSH's filesystem provider trims the parsed body; keep the fixture itself realistic.
  const body = rawBody.trim();
  const skill = [
    '---',
    'name: oil-ui-pro',
    'description: A fictional raw Pro skill used for the DSH native loader smoke check.',
    'metadata:',
    '  version: "0.0.0"',
    '---',
    rawBody,
  ].join('\n');
  const reviewerManual = [
    '# Fictional reviewer manual',
    '',
    'RAW_PRO_REFERENCE_SENTINEL: preserve this resource byte for byte.',
    '',
  ].join('\n');
  return {
    body,
    skill: Buffer.from(skill, 'utf8'),
    reviewerManual: Buffer.from(reviewerManual, 'utf8'),
  };
}

async function writeFixture(agentsHome) {
  const fixture = fixtureFiles();
  const directory = path.join(agentsHome, 'skills', 'oil-ui-pro');
  await mkdir(path.join(directory, 'references'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), fixture.skill, { mode: 0o600 });
  await writeFile(path.join(directory, 'references', 'reviewer-manual.md'), fixture.reviewerManual, { mode: 0o600 });
  return { directory, ...fixture };
}

async function readTreeBytes(root) {
  const files = new Map();
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      const key = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in smoke fixture: ${key}`);
      if (entry.isDirectory()) await visit(item, key);
      else if (entry.isFile()) files.set(key, await readFile(item));
    }
  }
  await visit(root);
  return files;
}

async function directoryExists(directory) {
  try {
    await lstat(directory);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertSameFileTree(before, after) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'The raw Pro fixture file list changed.');
  for (const [name, bytes] of before) {
    assert.ok(after.get(name)?.equals(bytes), `The raw Pro fixture changed bytes: ${name}`);
  }
}

async function hostMain(args) {
  const [workspace, resultPath, dshDirectory, pnpmPath, npmrcPath, npmGlobalConfigPath, packageCachePath] = args;
  invariant(workspace && resultPath && dshDirectory && pnpmPath, 'The isolated host arguments are incomplete.');
  const isolated = {
    env: process.env,
    dirs: {
      userConfig: npmrcPath,
      globalConfig: npmGlobalConfigPath,
      npmCache: packageCachePath,
      dshHome: process.env.DSH_HOME,
    },
  };
  let app;
  let handle;
  let summary;
  let failure;
  const expectedFixture = {
    ...fixtureFiles(),
    directory: path.join(process.env.DSH_AGENTS_HOME, 'skills', 'oil-ui-pro'),
  };
  try {
    process.chdir(workspace);
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? input : input.url;
      const url = new URL(rawUrl);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error('Outbound network is disabled during the DSH smoke Host.');
      }
      return nativeFetch(input, init);
    };
    const require = createRequire(path.join(dshDirectory, 'package.json'));
    const appBoot = require.resolve('@deepseek-ai/dsh-app-boot');
    const { loadLayeredEnv } = await import(pathToFileURL(appBoot).href);
    const environment = loadLayeredEnv('dsh');
    const { runProfile } = await import(pathToFileURL(path.join(dshDirectory, 'lib', 'profile-boot.js')).href);
    app = await runProfile({
      environment,
      profile: DSH_PROFILE,
      patchFiles: [],
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
      packageManager: {
        command: pnpmPath,
        env: isolated.env,
      },
    });

    const sessionId = `oil-ui-dsh-smoke-${randomUUID()}`;
    handle = await app.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace },
      setup: async (scope) => {
        await app.ctx.agentPresets.mount(scope, 'standard');
      },
    });
    const agent = handle.agent;
    const signal = new AbortController().signal;
    const skillTool = app.ctx.tools.get('skill', agent);
    invariant(skillTool, 'The standard Agent preset does not expose the native skill tool.');

    const globalCatalog = await app.ctx.skills.list();
    const globalPros = globalCatalog.filter((skill) => skill.name === 'oil-ui-pro');
    const globalPluginProCount = globalPros.filter((skill) => skill.provider !== 'filesystem').length;
    const agentCatalog = await app.ctx.skills.list({ cwd: workspace, scope: agent });
    const agentPro = agentCatalog.filter((skill) => skill.name === 'oil-ui-pro');
    invariant(
      globalPluginProCount === 0,
      'The plugin provider unexpectedly publishes oil-ui-pro in the global registry.',
    );
    invariant(
      agentPro.length === 1 && agentPro[0].provider === 'filesystem',
      'The Agent view must expose exactly one filesystem-owned oil-ui-pro.',
    );

    const pro = await skillTool.execute({ name: 'oil-ui-pro' }, { agent, signal });
    invariant(
      pro.name === 'oil-ui-pro' && pro.provider === 'filesystem',
      'The native skill tool did not load the isolated HOME Pro fixture from filesystem.',
    );
    invariant(
      Buffer.from(pro.content, 'utf8').equals(Buffer.from(expectedFixture.body, 'utf8')),
      'The native skill tool changed the original Pro instruction bytes.',
    );
    invariant(
      pro.resourceBase?.kind === 'directory' &&
        path.resolve(pro.resourceBase.path) === path.resolve(expectedFixture.directory),
      'The native skill tool returned a mismatched Pro resource directory.',
    );

    const oilTools = ['oil_ui_shoot', 'oil_ui_media', 'oil_ui_image', 'oil_ui_explorer', 'oil_ui_skill_status'];
    const missingTools = oilTools.filter((name) => app.ctx.tools.get(name, agent) === undefined);
    invariant(missingTools.length === 0, `Missing Oil UI tools in the Agent view: ${missingTools.join(', ')}.`);

    const liteDefinition = await app.ctx.skills.get('oil-ui', { cwd: workspace, scope: agent, signal });
    invariant(liteDefinition, 'The packaged Lite Skill is not readable from the Agent view.');
    const liteResult = await skillTool.execute({ name: 'oil-ui' }, { agent, signal });
    invariant(
      liteResult.name === 'oil-ui' && liteResult.content === liteDefinition.content,
      'The native skill tool could not read the Lite Skill body.',
    );
    invariant(
      liteDefinition.resourceBase?.kind === 'directory',
      'The readable Lite Skill has no filesystem resource directory.',
    );
    const manifestPath = path.resolve(liteDefinition.resourceBase.path, '..', 'oil-ui.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    invariant(
      String(liteDefinition.metadata?.version) === String(manifest.version),
      'The readable Lite Skill version does not match its installed manifest.',
    );

    const statusTool = app.ctx.tools.get('oil_ui_skill_status', agent);
    const status = await statusTool.execute({}, { agent, signal });
    invariant(
      status.activeSkillName === 'oil-ui-pro' &&
        status.edition === 'pro' &&
        status.activeVersion === '0.0.0' &&
        status.effective?.name === 'oil-ui-pro' &&
        status.effective.provider === 'filesystem' &&
        status.effective.version === '0.0.0',
      'Skill status did not describe the filesystem Pro fixture actually loaded by the native skill tool.',
    );
    invariant(
      status.effective.resourceBase?.kind === 'directory' &&
        (await realpath(status.effective.resourceBase.path)) === (await realpath(expectedFixture.directory)) &&
        (await realpath(status.effective.path)) ===
          (await realpath(path.join(expectedFixture.directory, 'SKILL.md'))) &&
        (await realpath(status.activeResourceBase)) === (await realpath(expectedFixture.directory)),
      'Skill status returned a mismatched Pro entry path or resource directory.',
    );
    invariant(status.nativeSkillReady === true, 'oil_ui_skill_status did not report nativeSkillReady=true.');
    invariant(
      status.visibleMatchesOriginal === true,
      'oil_ui_skill_status did not report visibleMatchesOriginal=true.',
    );
    invariant(status.skillLoadState === 'ready', 'oil_ui_skill_status did not report skillLoadState=ready.');
    summary = {
      dshVersion:
        (await readFile(path.join(dshDirectory, 'package.json'), 'utf8')).match(/"version"\s*:\s*"([^"]+)"/u)?.[1] ??
        'unknown',
      profile: DSH_PROFILE,
      agentPreset: 'standard',
      globalProProviders: globalPros.map((skill) => skill.provider),
      pluginProAbsent: globalPluginProCount === 0,
      agentFilesystemProCount: agentPro.length,
      originalProVisibleMatchesBytes: pro.content === expectedFixture.body,
      originalProResourceDirectoryMatches:
        path.resolve(pro.resourceBase.path) === path.resolve(expectedFixture.directory),
      oilUiToolCount: oilTools.length,
      liteVersionMatchesManifest: String(liteDefinition.metadata?.version) === String(manifest.version),
      statusSkillName: status.activeSkillName,
      statusProvider: status.effective.provider,
      proVersion: status.activeVersion,
      liteVersion: String(liteDefinition.metadata?.version),
      nativeSkillReady: status.nativeSkillReady,
      visibleMatchesOriginal: status.visibleMatchesOriginal,
      skillLoadState: status.skillLoadState,
    };
  } catch (error) {
    failure = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      if (handle) await handle.dispose();
    } catch (error) {
      failure ??= { name: 'CleanupError', message: error instanceof Error ? error.message : String(error) };
    }
    try {
      if (app?.shutdown) await app.shutdown.shutdown(0);
    } catch (error) {
      failure ??= { name: 'ShutdownError', message: error instanceof Error ? error.message : String(error) };
    }
  }
  await writeFile(resultPath, JSON.stringify(failure ? { ok: false, failure } : { ok: true, summary }), {
    mode: 0o600,
  });
  process.exit(failure ? 1 : 0);
}

async function main() {
  if (process.argv[2] === '--host') return hostMain(process.argv.slice(3));

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-oil-ui-smoke-'));
  try {
    const isolated = await createIsolation(tempRoot);
    const workspace = path.join(tempRoot, 'workspace');
    await mkdir(workspace, { recursive: true });
    const expectedFixture = await writeFixture(isolated.dirs.agentsHome);
    const rawFixtureBefore = await readTreeBytes(expectedFixture.directory);
    const installedDsh = await findInstalledDsh();
    const pnpm = await selectPnpm(tempRoot, isolated);
    const pnpmBin = await exposePnpmOnPath(tempRoot, pnpm.path);
    const npmExecPath = process.env.npm_execpath;
    invariant(npmExecPath && path.isAbsolute(npmExecPath), 'Run this script with npm run smoke:dsh.');
    await access(npmExecPath);
    const commandEnv = {
      ...isolated.env,
      PATH: `${pnpmBin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
    };
    const archive = path.join(tempRoot, 'plugin.tgz');
    await runChild(process.execPath, [npmExecPath, 'run', 'pack:plugin', '--', archive], {
      cwd: projectRoot,
      env: commandEnv,
      timeoutMs: CHILD_TIMEOUT_MS,
      label: 'Temporary Oil UI plugin package build',
    });
    await access(archive);

    await runChild(installedDsh.cliPath, ['plugin', '--profile', DSH_PROFILE, 'add', archive], {
      cwd: workspace,
      env: commandEnv,
      timeoutMs: CHILD_TIMEOUT_MS,
      label: `Isolated DSH ${DSH_PROFILE} plugin install`,
    });

    const resultPath = path.join(tempRoot, 'host-result.json');
    const hostEnv = isolated.env;
    try {
      await runChild(
        process.execPath,
        [
          scriptPath,
          '--host',
          workspace,
          resultPath,
          installedDsh.directory,
          pnpm.path,
          isolated.dirs.userConfig,
          isolated.dirs.globalConfig,
          isolated.dirs.npmCache,
        ],
        {
          cwd: workspace,
          env: hostEnv,
          timeoutMs: HOST_TIMEOUT_MS,
          label: 'Isolated DSH Host smoke',
        },
      );
    } catch (error) {
      if (await directoryExists(resultPath)) {
        const hostResult = JSON.parse(await readFile(resultPath, 'utf8'));
        if (hostResult.ok === false) {
          throw new Error(
            `Isolated DSH Host smoke failed: ${hostResult.failure?.name ?? 'Error'}: ${hostResult.failure?.message ?? 'unknown error'}`,
          );
        }
      }
      throw error;
    }

    const hostResult = JSON.parse(await readFile(resultPath, 'utf8'));
    if (!hostResult.ok) {
      throw new Error(
        `Isolated DSH Host smoke failed: ${hostResult.failure?.name ?? 'Error'}: ${hostResult.failure?.message ?? 'unknown error'}`,
      );
    }
    const rawFixtureAfter = await readTreeBytes(expectedFixture.directory);
    assertSameFileTree(rawFixtureBefore, rawFixtureAfter);
    const proCache = path.join(isolated.dirs.dshHome, 'cache', 'dsh-oil-ui');
    const proCacheCreated = await directoryExists(proCache);
    invariant(!proCacheCreated, 'The smoke run created an Oil UI Pro compilation cache.');

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          pnpmSource: pnpm.source,
          rawProBytesUnchanged: true,
          proCacheCreated,
          ...hostResult.summary,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`DSH smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
