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
import { isNodeScript, npmInvocation, packageBinEntry } from './lib/portable-cli.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = fileURLToPath(import.meta.url);
const PNPM_VERSION = '10.16.1';
const DSH_PROFILE = process.env.DSH_SMOKE_PROFILE ?? 'web';
invariant(['web', 'headless'].includes(DSH_PROFILE), 'DSH_SMOKE_PROFILE must be web or headless.');
const CHILD_TIMEOUT_MS = 120_000;
const BOOTSTRAP_TIMEOUT_MS = 1_200_000;
const PLUGIN_INSTALL_TIMEOUT_MS = 600_000;
const HOST_TIMEOUT_MS = 90_000;
let smokeStage = 'argument parsing';
let smokeDshLabel = 'existing-installation';
const LITE_PROVIDER = 'oil-ui-provider';
const OIL_UI_TOOLS = ['oil_ui_shoot', 'oil_ui_media', 'oil_ui_image', 'oil_ui_explorer', 'oil_ui_skill_status'];
const LITE_HOST_TOOLS = OIL_UI_TOOLS.slice(0, 4);
const SCENARIOS = [
  { id: 'plugin-lite-only', bundledSkill: true, filesystemLite: false, filesystemPro: false },
  { id: 'filesystem-lite-only', bundledSkill: false, filesystemLite: true, filesystemPro: false },
  { id: 'filesystem-lite-overrides-bundle', bundledSkill: true, filesystemLite: true, filesystemPro: false },
  { id: 'filesystem-pro-with-both-lite-publishers', bundledSkill: true, filesystemLite: true, filesystemPro: true },
];

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
  const npmPrefix = path.join(root, 'npm-prefix');
  const corepackHome = path.join(root, 'corepack-home');
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
    DSH_SMOKE_PROFILE: DSH_PROFILE,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    COREPACK_HOME: corepackHome,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_prefix: npmPrefix,
    NPM_CONFIG_PREFIX: npmPrefix,
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
    rootEnv.HOMEPATH = home.slice(parsed.root.length - 1);
  }
  return {
    env: rootEnv,
    dirs: { home, dshHome, agentsHome, temp, npmCache, npmPrefix, corepackHome, userConfig, globalConfig },
  };
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
      isolated.dirs.npmPrefix,
      isolated.dirs.corepackHome,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
  await writeFile(isolated.dirs.userConfig, '', { mode: 0o600 });
  await writeFile(isolated.dirs.globalConfig, '', { mode: 0o600 });
  return isolated;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeDiagnostic(output) {
  return output.replace(/([?&]token=)[^\s]+/gu, '$1[REDACTED]').trim();
}

async function terminateProcessTree(child, env) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      env,
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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-6000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    let timedOut = false;
    let settled = false;
    let terminationPromise;
    const timer = setTimeout(() => {
      timedOut = true;
      terminationPromise = terminateProcessTree(child, env);
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label} could not start (${error.code ?? error.name}): ${error.message}`));
    });
    child.once('close', async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        await terminationPromise;
        const diagnostic = safeDiagnostic(output);
        reject(
          new Error(
            `${label} exceeded ${timeoutMs} ms and its process group was terminated.${diagnostic ? `\n${diagnostic}` : ''}`,
          ),
        );
      } else if (code !== 0) {
        const diagnostic = safeDiagnostic(output);
        reject(new Error(`${label} failed (exit ${code ?? 'unknown'}${signal ? `, ${signal}` : ''}).\n${diagnostic}`));
      } else {
        resolve();
      }
    });
  });
}

async function findInstalledDsh(explicitPackageDirectory) {
  if (explicitPackageDirectory) return readInstalledDshPackage(explicitPackageDirectory);
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const names = process.platform === 'win32' ? ['dsh', 'dsh.cmd', 'dsh.exe'] : ['dsh'];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const shim = path.join(directory, name);
      if (!(await directoryExists(shim))) continue;
      let resolvedShim = shim;
      try {
        resolvedShim = await realpath(shim);
      } catch {}
      let ancestor = path.dirname(resolvedShim);
      while (ancestor !== path.dirname(ancestor)) {
        const candidates = [
          ancestor,
          path.join(ancestor, 'node_modules', '@deepseek-ai', 'dsh'),
          path.join(ancestor, '..', 'node_modules', '@deepseek-ai', 'dsh'),
        ];
        for (const candidate of candidates) {
          try {
            const manifest = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8'));
            if (manifest.name === '@deepseek-ai/dsh') return readInstalledDshPackage(candidate);
          } catch (error) {
            if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
          }
        }
        ancestor = path.dirname(ancestor);
      }
    }
  }
  throw new Error('The installed DSH CLI was not found in PATH or its npm package directory.');
}

async function readInstalledDshPackage(directory) {
  const packageJsonPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  invariant(manifest.name === '@deepseek-ai/dsh', `${directory} is not an @deepseek-ai/dsh installation.`);
  const cliPath = packageBinEntry(directory, 'dsh');
  const profileBoot = path.join(directory, 'lib', 'profile-boot.js');
  const require = createRequire(packageJsonPath);
  const appBoot = require.resolve('@deepseek-ai/dsh-app-boot');
  await access(profileBoot);
  await access(appBoot);
  return { cliPath, directory: await realpath(directory), version: manifest.version, profileBoot, appBoot };
}

async function selectPnpm(root, isolated) {
  const configuredEntry = process.env.DSH_SMOKE_PNPM_ENTRY;
  if (configuredEntry) {
    invariant(path.isAbsolute(configuredEntry), 'DSH_SMOKE_PNPM_ENTRY must be an absolute Node CLI entry path.');
    const resolved = await realpath(configuredEntry);
    invariant((await stat(resolved)).isFile(), 'DSH_SMOKE_PNPM_ENTRY must point to a file.');
    invariant(isNodeScript(resolved), 'DSH_SMOKE_PNPM_ENTRY must point to pnpm’s Node CLI entry, not a shell wrapper.');
    return { path: resolved, source: 'temporary-install' };
  }

  const configured = process.env.DSH_SMOKE_PNPM;
  if (configured !== undefined && configured !== '') {
    invariant(path.isAbsolute(configured), 'DSH_SMOKE_PNPM must be an absolute pnpm executable path.');
    const resolved = await realpath(configured);
    const file = await stat(resolved);
    invariant(file.isFile(), 'DSH_SMOKE_PNPM must point to a file.');
    if (process.platform !== 'win32') await access(resolved, 1);
    invariant(isNodeScript(resolved), 'DSH_SMOKE_PNPM must point to pnpm’s Node CLI entry, not a shell wrapper.');
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
  const invocation = npmInvocation(npmExecPath, [
    'install',
    '--prefix',
    installPrefix,
    '--no-save',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org',
    `pnpm@${PNPM_VERSION}`,
  ]);
  await runChild(invocation.command, invocation.args, {
    cwd: root,
    env: npmEnvironment,
    timeoutMs: CHILD_TIMEOUT_MS,
    label: `Temporary pnpm ${PNPM_VERSION} download`,
  });
  const resolved = packageBinEntry(path.join(installPrefix, 'node_modules', 'pnpm'), 'pnpm');
  return { path: resolved, source: `temporary-pnpm-${PNPM_VERSION}` };
}

function parseDshOptions(argv) {
  let installMode = false;
  let version;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--install') {
      invariant(!installMode, '--install may be provided only once.');
      installMode = true;
    } else if (argv[index] === '--dsh' || argv[index] === '--dsh-version') {
      invariant(!version && argv[index + 1], `${argv[index]} requires one exact DSH version.`);
      version = argv[index + 1];
      index += 1;
    } else {
      invariant(argv[index] === '--', `Unknown smoke argument: ${argv[index]}`);
    }
  }
  if (version || installMode) {
    version ??= '0.2.2-rc.1';
    invariant(
      /^0\.2\.(?:1-rc\.5|2-rc\.1)$/u.test(version),
      'Supported install smoke versions: 0.2.1-rc.5 and 0.2.2-rc.1.',
    );
  }
  return { installMode: installMode || Boolean(version), version };
}

async function installDshAndPnpm(root, isolated, version) {
  smokeStage = `install DSH ${version} and pnpm ${PNPM_VERSION}`;
  assertRuntimeForDsh(version);
  const npmExecPath = process.env.npm_execpath;
  const invocation = npmInvocation(npmExecPath, [
    'install',
    '--prefix',
    isolated.dirs.npmPrefix,
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org',
    `@deepseek-ai/dsh@${version}`,
    `pnpm@${PNPM_VERSION}`,
  ]);
  await runChild(invocation.command, invocation.args, {
    cwd: root,
    env: isolated.env,
    timeoutMs: BOOTSTRAP_TIMEOUT_MS,
    label: `Temporary DSH ${version} and pnpm ${PNPM_VERSION} installation`,
  });
  const modules = path.join(isolated.dirs.npmPrefix, 'node_modules');
  const dshDirectory = path.join(modules, '@deepseek-ai', 'dsh');
  const pnpmDirectory = path.join(modules, 'pnpm');
  return {
    dsh: await readInstalledDshPackage(dshDirectory),
    pnpm: { path: packageBinEntry(pnpmDirectory, 'pnpm'), source: `temporary-pnpm-${PNPM_VERSION}` },
  };
}

function assertRuntimeForDsh(version) {
  const minimum = version === '0.2.2-rc.1' ? [24, 9, 0] : [22, 19, 0];
  const actual = process.versions.node.split('.').map(Number);
  const supported =
    actual[0] > minimum[0] ||
    (actual[0] === minimum[0] && (actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2])));
  invariant(
    supported,
    `DSH ${version} requires Node >=${minimum.join('.')}; this run uses Node ${process.versions.node}. Select a compatible Node runtime and retry.`,
  );
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

function makeSkillFixture({ name, version, description, body }) {
  const rawBody = `\n${body.trim()}\n`;
  const skill = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'metadata:',
    `  version: "${version}"`,
    '---',
    rawBody,
  ].join('\n');
  return { body: rawBody.trim(), skill: Buffer.from(skill, 'utf8') };
}

function proFixtureFiles() {
  const fixture = makeSkillFixture({
    name: 'oil-ui-pro',
    version: '0.0.0',
    description: 'A fictional raw Pro skill used for the DSH native loader smoke check.',
    body: [
      '# Original Pro fixture',
      '',
      'RAW_PRO_BODY_SENTINEL: this exact instruction text must survive native loading.',
      '',
      'Read `references/reviewer-manual.md` when the task explicitly requests a review.',
    ].join('\n'),
  });
  const reviewerManual = [
    '# Fictional reviewer manual',
    '',
    'RAW_PRO_REFERENCE_SENTINEL: preserve this resource byte for byte.',
    '',
  ].join('\n');
  return { ...fixture, reviewerManual: Buffer.from(reviewerManual, 'utf8') };
}

function filesystemLiteFixtureFiles() {
  return makeSkillFixture({
    name: 'oil-ui',
    version: '9.8.7',
    description: 'A fictional raw filesystem Lite skill used for the DSH native loader smoke check.',
    body: [
      '# Filesystem Lite fixture',
      '',
      'RAW_FILESYSTEM_LITE_BODY_SENTINEL: this exact original text must survive native loading.',
      '',
      '## 宿主工具',
      '',
      ...LITE_HOST_TOOLS.map((name) => `- \`${name}\``),
    ].join('\n'),
  });
}

async function writeFixture(agentsHome, name, fixture) {
  const directory = path.join(agentsHome, 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), fixture.skill, { mode: 0o600 });
  if (name === 'oil-ui-pro') {
    await mkdir(path.join(directory, 'references'), { recursive: true });
    await writeFile(path.join(directory, 'references', 'reviewer-manual.md'), fixture.reviewerManual, {
      mode: 0o600,
    });
  } else {
    await mkdir(path.join(directory, 'references'), { recursive: true });
    const toolsReference = [
      '# Fictional raw Lite tools reference',
      '',
      '## 宿主工具',
      '',
      ...LITE_HOST_TOOLS.map((tool) => `- \`${tool}\``),
      '',
    ].join('\n');
    await writeFile(path.join(directory, 'references', 'tools.md'), toolsReference, { mode: 0o600 });
  }
  return { directory, ...fixture };
}

function skillBodyFromMarkdown(markdown) {
  const boundary = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(markdown);
  invariant(boundary, 'A Skill fixture is missing its YAML frontmatter boundary.');
  return markdown.slice(boundary[0].length);
}

function scenarioById(id) {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  invariant(scenario, `Unknown smoke scenario: ${id ?? '(missing)'}.`);
  return scenario;
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

function assertSameFileTree(before, after, label) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `The ${label} fixture file list changed.`);
  for (const [name, bytes] of before) {
    assert.ok(after.get(name)?.equals(bytes), `The ${label} fixture changed bytes: ${name}`);
  }
}

async function assertSkillSnapshot(definition, result, expected, label) {
  invariant(definition, `${label} was not readable from the Agent view.`);
  invariant(definition.name === expected.name, `${label} definition returned the wrong Skill name.`);
  invariant(definition.provider === expected.provider, `${label} definition returned the wrong provider.`);
  invariant(
    String(definition.metadata?.version) === expected.version,
    `${label} definition returned version ${String(definition.metadata?.version)} instead of ${expected.version}.`,
  );
  invariant(definition.content === expected.body, `${label} definition changed the original Markdown body.`);
  invariant(
    definition.resourceBase?.kind === 'directory' &&
      (await realpath(definition.resourceBase.path)) === (await realpath(expected.directory)) &&
      (await realpath(definition.path)) === (await realpath(path.join(expected.directory, 'SKILL.md'))),
    `${label} definition returned the wrong entry path or resource directory.`,
  );

  invariant(result.name === expected.name, `${label} native tool returned the wrong Skill name.`);
  invariant(result.provider === expected.provider, `${label} native tool returned the wrong provider.`);
  invariant(result.content === expected.body, `${label} native tool changed the original Markdown body.`);
  invariant(
    result.resourceBase?.kind === 'directory' &&
      (await realpath(result.resourceBase.path)) === (await realpath(expected.directory)),
    `${label} native tool returned the wrong resource directory.`,
  );
}

async function bundledLiteFromProfile(dshHome) {
  const profileDirectory = path.join(dshHome, 'profiles', DSH_PROFILE);
  const profileRequire = createRequire(path.join(profileDirectory, 'package.json'));
  const packageJsonPath = profileRequire.resolve('dsh-oil-ui/package.json');
  const packageDirectory = path.dirname(packageJsonPath);
  const directory = path.join(packageDirectory, 'skills', 'oil-ui');
  const [markdown, manifestBytes] = await Promise.all([
    readFile(path.join(directory, 'SKILL.md'), 'utf8'),
    readFile(path.join(packageDirectory, 'skills', 'oil-ui.manifest.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestBytes);
  return {
    name: 'oil-ui',
    body: skillBodyFromMarkdown(markdown),
    version: String(manifest.version),
    provider: LITE_PROVIDER,
    directory,
  };
}

async function assertHostToolsReference(directory, label) {
  const toolsReference = await readFile(path.join(directory, 'references', 'tools.md'), 'utf8');
  invariant(/^## 宿主工具\s*$/mu.test(toolsReference), `${label} is missing the original “## 宿主工具” section.`);
  const missing = LITE_HOST_TOOLS.filter((tool) => !toolsReference.includes(tool));
  invariant(missing.length === 0, `${label} is missing host tool names: ${missing.join(', ')}.`);
}

async function hostMain(args) {
  const [workspace, resultPath, dshDirectory, pnpmPath, scenarioId, patchPath] = args;
  invariant(
    workspace && resultPath && dshDirectory && pnpmPath && scenarioId,
    'The isolated host arguments are incomplete.',
  );
  const scenario = scenarioById(scenarioId);
  let app;
  let handle;
  let summary;
  let failure;
  const expectedPro = scenario.filesystemPro
    ? {
        ...proFixtureFiles(),
        name: 'oil-ui-pro',
        version: '0.0.0',
        provider: 'filesystem',
        directory: path.join(process.env.DSH_AGENTS_HOME, 'skills', 'oil-ui-pro'),
      }
    : null;
  const expectedFilesystemLite = scenario.filesystemLite
    ? {
        ...filesystemLiteFixtureFiles(),
        name: 'oil-ui',
        version: '9.8.7',
        provider: 'filesystem',
        directory: path.join(process.env.DSH_AGENTS_HOME, 'skills', 'oil-ui'),
      }
    : null;
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
      patchFiles: patchPath ? [patchPath] : [],
      args:
        DSH_PROFILE === 'web'
          ? ['--no-open', '--host', '127.0.0.1', '--port', '0']
          : ['Offline smoke fixture; the model runner is disabled by a temporary patch.'],
      packageManager: {
        command: process.execPath,
        args: [pnpmPath],
        env: process.env,
      },
    });

    const sessionId = `oil-ui-dsh-smoke-${randomUUID()}`;
    handle = await app.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace },
      setup: async (scope) => {
        if (DSH_PROFILE === 'web') await app.ctx.agentPresets.mount(scope, 'standard');
      },
    });
    const agent = handle.agent;
    const signal = new AbortController().signal;
    const startupErrors = (app.ctx.logger.buffer ?? []).filter(
      (message) => message.type === 'error' && message.name.includes('dsh-oil-ui'),
    );
    invariant(
      startupErrors.length === 0,
      `Plugin startup failed: ${startupErrors.map((message) => message.args.map(String).join(' ')).join('; ')}`,
    );
    const assembly = await app.ctx.systemPrompt.assemble({ scope: agent, signal });
    invariant(
      assembly.sections.some((section) => section.name === 'oil-ui'),
      'Oil UI system prompt is missing.',
    );
    for (const toolName of ['read', 'write', 'edit', 'bash', 'skill']) {
      invariant(app.ctx.tools.get(toolName, agent), `Built-in tool is missing: ${toolName}.`);
    }
    const nativeProbe = path.join(workspace, 'native-read-probe.txt');
    await writeFile(nativeProbe, 'OIL_DSH_NATIVE_READ_SENTINEL');
    const nativeRead = await app.ctx.tools.get('read', agent).execute({ file_path: nativeProbe }, { agent, signal });
    invariant(JSON.stringify(nativeRead).includes('OIL_DSH_NATIVE_READ_SENTINEL'), 'Built-in read failed.');
    const skillTool = app.ctx.tools.get('skill', agent);
    invariant(skillTool, 'The standard Agent preset does not expose the native skill tool.');

    const globalCatalog = await app.ctx.skills.list();
    const pluginLiteCandidates = globalCatalog.filter(
      (skill) => skill.name === 'oil-ui' && skill.provider === LITE_PROVIDER,
    );
    const globalPros = globalCatalog.filter((skill) => skill.name === 'oil-ui-pro');
    const agentCatalog = await app.ctx.skills.list({ cwd: workspace, scope: agent });
    const agentPro = agentCatalog.filter((skill) => skill.name === 'oil-ui-pro');
    const agentPluginPros = agentPro.filter((skill) => skill.provider !== 'filesystem');
    const pluginProCandidates = globalPros.filter((skill) => skill.provider !== 'filesystem');
    invariant(
      pluginProCandidates.length === 0 && agentPluginPros.length === 0,
      'The plugin provider unexpectedly publishes oil-ui-pro in the global registry.',
    );
    invariant(
      agentPro.length === Number(scenario.filesystemPro) &&
        (!scenario.filesystemPro || agentPro[0]?.provider === 'filesystem'),
      'The Agent view exposed the wrong number or owner of filesystem oil-ui-pro definitions.',
    );

    invariant(
      scenario.bundledSkill ? pluginLiteCandidates.length === 1 : pluginLiteCandidates.length === 0,
      `The bundled Lite Provider registration did not match scenario ${scenario.id}.`,
    );

    const agentToolNames =
      typeof app.ctx.tools.schemas === 'function'
        ? app.ctx.tools.schemas(agent).map((tool) => tool.name)
        : app.ctx.tools.definitions(agent).map((tool) => tool.name);
    const missingTools = OIL_UI_TOOLS.filter((name) => !agentToolNames.includes(name));
    invariant(missingTools.length === 0, `Missing Oil UI tools in the Agent view: ${missingTools.join(', ')}.`);

    const bundledLite = scenario.bundledSkill ? await bundledLiteFromProfile(process.env.DSH_HOME) : null;
    const liteDefinition = await app.ctx.skills.get('oil-ui', { cwd: workspace, scope: agent, signal });
    // Headless has no scoped web preset; both Lite providers share the global layer.
    const expectedLite =
      DSH_PROFILE === 'headless' && liteDefinition?.provider === LITE_PROVIDER
        ? bundledLite
        : (expectedFilesystemLite ?? bundledLite);
    invariant(expectedLite, `Scenario ${scenario.id} has no expected Lite publisher.`);
    await assertHostToolsReference(expectedLite.directory, `Lite Skill in ${scenario.id}`);
    const liteResult = await skillTool.execute({ name: 'oil-ui' }, { agent, signal });
    await assertSkillSnapshot(liteDefinition, liteResult, expectedLite, 'Lite Skill');

    let proResult;
    let proDefinition;
    if (expectedPro) {
      proDefinition = await app.ctx.skills.get('oil-ui-pro', { cwd: workspace, scope: agent, signal });
      proResult = await skillTool.execute({ name: 'oil-ui-pro' }, { agent, signal });
      await assertSkillSnapshot(proDefinition, proResult, expectedPro, 'Pro Skill');
    }

    const statusTool = app.ctx.tools.get('oil_ui_skill_status', agent);
    invariant(statusTool, 'The standard Agent preset does not expose oil_ui_skill_status.');
    const status = await statusTool.execute({}, { agent, signal });
    const expectedActive = expectedPro ?? expectedLite;
    const activeResult = expectedPro ? proResult : liteResult;
    const expectedEdition = expectedPro ? 'pro' : 'lite';
    invariant(
      status.activeSkillName === expectedActive.name &&
        status.edition === expectedEdition &&
        status.activeVersion === expectedActive.version &&
        status.effective?.name === expectedActive.name &&
        status.effective.provider === expectedActive.provider &&
        String(status.effective.version) === expectedActive.version,
      `Skill status did not describe the actual ${expectedEdition} definition loaded by the native skill tool.`,
    );
    invariant(
      status.effective.resourceBase?.kind === 'directory' &&
        (await realpath(status.effective.resourceBase.path)) === (await realpath(expectedActive.directory)) &&
        (await realpath(status.effective.path)) === (await realpath(path.join(expectedActive.directory, 'SKILL.md'))) &&
        (await realpath(status.activeResourceBase)) === (await realpath(expectedActive.directory)) &&
        activeResult.content === expectedActive.body,
      'Skill status resource paths or its native skill body did not match the selected original Skill.',
    );
    invariant(status.skillReady === true, 'oil_ui_skill_status did not report skillReady=true.');
    invariant(status.nativeSkillReady === true, 'oil_ui_skill_status did not report nativeSkillReady=true.');
    invariant(
      status.visibleMatchesOriginal === true,
      'oil_ui_skill_status did not report visibleMatchesOriginal=true.',
    );
    invariant(status.skillLoadState === 'ready', 'oil_ui_skill_status did not report skillLoadState=ready.');
    invariant(
      status.proVisible === scenario.filesystemPro && status.proInstalled === scenario.filesystemPro,
      'Skill status reported the wrong Pro visibility or installation state.',
    );
    summary = {
      dshVersion:
        (await readFile(path.join(dshDirectory, 'package.json'), 'utf8')).match(/"version"\s*:\s*"([^"]+)"/u)?.[1] ??
        'unknown',
      profile: DSH_PROFILE,
      agentPreset: DSH_PROFILE === 'web' ? 'standard' : null,
      scenario: scenario.id,
      bundledSkillEnabled: scenario.bundledSkill,
      bundledLiteProviderPresent: pluginLiteCandidates.length === 1,
      liteProvider: liteDefinition.provider,
      liteVersion: String(liteDefinition.metadata?.version),
      liteDirectory: await realpath(liteDefinition.resourceBase.path),
      liteBodyMatchesOriginal: liteDefinition.content === expectedLite.body,
      liteHostToolsSectionPresent: true,
      globalProProviders: globalPros.map((skill) => skill.provider),
      pluginProAbsent: pluginProCandidates.length === 0 && agentPluginPros.length === 0,
      agentFilesystemProCount: agentPro.length,
      ...(proResult
        ? {
            proVersion: String(proDefinition.metadata?.version),
            proDirectory: await realpath(proDefinition.resourceBase.path),
            originalProBodyUnchanged: proDefinition.content === expectedPro.body,
          }
        : {}),
      oilUiToolCount: OIL_UI_TOOLS.length,
      pluginStartupErrors: startupErrors.length,
      systemPromptPresent: true,
      nativeReadPassed: true,
      statusSkillName: status.activeSkillName,
      statusProvider: status.effective.provider,
      activeVersion: status.activeVersion,
      skillReady: status.skillReady,
      nativeSkillReady: status.nativeSkillReady,
      visibleMatchesOriginal: status.visibleMatchesOriginal,
      skillLoadState: status.skillLoadState,
    };
  } catch (error) {
    failure = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
  } finally {
    try {
      if (handle) await handle.dispose();
    } catch (error) {
      failure ??= {
        name: 'CleanupError',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
    }
    try {
      if (app?.shutdown) await app.shutdown.shutdown(0);
    } catch (error) {
      failure ??= {
        name: 'ShutdownError',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
    }
  }
  await writeFile(resultPath, JSON.stringify(failure ? { ok: false, failure } : { ok: true, summary }), {
    mode: 0o600,
  });
  process.exit(failure ? 1 : 0);
}

async function main() {
  if (process.argv[2] === '--host') return hostMain(process.argv.slice(3));
  const { installMode, version: requestedDshVersion } = parseDshOptions(process.argv.slice(2));
  smokeDshLabel = requestedDshVersion ?? 'existing-installation';

  // macOS /var aliases /private/var. Mixed spellings make pnpm encode an
  // unnecessarily long relative tarball path into one store filename.
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-oil-ui-smoke-')));
  try {
    const bootstrapRoot = path.join(tempRoot, 'bootstrap');
    await mkdir(bootstrapRoot, { recursive: true });
    const bootstrap = await createIsolation(bootstrapRoot);
    const requestedInstall = installMode ? await installDshAndPnpm(tempRoot, bootstrap, requestedDshVersion) : null;
    smokeStage = 'resolve the DSH installation';
    const installedDsh = requestedInstall?.dsh ?? (await findInstalledDsh());
    smokeStage = `install or resolve pnpm ${PNPM_VERSION}`;
    const pnpm = requestedInstall?.pnpm ?? (await selectPnpm(tempRoot, bootstrap));
    const pnpmBin = await exposePnpmOnPath(tempRoot, pnpm.path);
    const npmExecPath = process.env.npm_execpath;
    const archive = path.join(tempRoot, 'plugin.tgz');
    const packInvocation = npmInvocation(npmExecPath, ['run', 'pack:plugin', '--', archive]);
    smokeStage = 'build and package the Oil UI plugin';
    await runChild(packInvocation.command, packInvocation.args, {
      cwd: projectRoot,
      env: {
        ...bootstrap.env,
        DSH_SMOKE_PNPM_ENTRY: pnpm.path,
        PATH: `${pnpmBin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      },
      timeoutMs: CHILD_TIMEOUT_MS,
      label: 'Temporary Oil UI plugin package build',
    });
    await access(archive);

    const scenarioResults = [];
    for (const scenario of SCENARIOS) {
      smokeStage = `isolate scenario ${scenario.id}`;
      const scenarioRoot = path.join(tempRoot, scenario.id);
      await mkdir(scenarioRoot, { recursive: true });
      const isolated = await createIsolation(scenarioRoot);
      const workspace = path.join(scenarioRoot, 'workspace');
      await mkdir(workspace, { recursive: true });

      const fixtures = [];
      if (scenario.filesystemLite) {
        const fixture = await writeFixture(isolated.dirs.agentsHome, 'oil-ui', filesystemLiteFixtureFiles());
        fixtures.push({
          name: 'filesystem Lite',
          directory: fixture.directory,
          before: await readTreeBytes(fixture.directory),
        });
      }
      if (scenario.filesystemPro) {
        const fixture = await writeFixture(isolated.dirs.agentsHome, 'oil-ui-pro', proFixtureFiles());
        fixtures.push({
          name: 'filesystem Pro',
          directory: fixture.directory,
          before: await readTreeBytes(fixture.directory),
        });
      }

      const commandEnv = {
        ...isolated.env,
        DSH_SMOKE_PNPM_ENTRY: pnpm.path,
        PATH: `${pnpmBin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      };
      smokeStage = `install plugin for ${DSH_PROFILE}/${scenario.id}`;
      await runChild(process.execPath, [installedDsh.cliPath, 'plugin', '--profile', DSH_PROFILE, 'add', archive], {
        cwd: workspace,
        env: commandEnv,
        timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS,
        label: `Isolated DSH ${DSH_PROFILE} plugin install (${scenario.id})`,
      });

      let patchPath = '';
      const patches = [];
      if (!scenario.bundledSkill) {
        patches.push('- id: dsh-oil-ui\n  config:\n    bundledSkill: false\n');
      }
      if (DSH_PROFILE === 'headless') {
        // Mount the real headless services without submitting a model task.
        patches.push('- id: headless-runner\n  disabled: true\n');
      }
      if (patches.length) {
        patchPath = path.join(scenarioRoot, 'smoke-only.patch.yml');
        await writeFile(patchPath, patches.join('\n'), { mode: 0o600 });
      }

      const resultPath = path.join(scenarioRoot, 'host-result.json');
      try {
        smokeStage = `start Host for ${DSH_PROFILE}/${scenario.id}`;
        await runChild(
          process.execPath,
          [scriptPath, '--host', workspace, resultPath, installedDsh.directory, pnpm.path, scenario.id, patchPath],
          {
            cwd: workspace,
            env: isolated.env,
            timeoutMs: HOST_TIMEOUT_MS,
            label: `Isolated DSH Host smoke (${scenario.id})`,
          },
        );
      } catch (error) {
        if (await directoryExists(resultPath)) {
          const hostResult = JSON.parse(await readFile(resultPath, 'utf8'));
          if (hostResult.ok === false) {
            throw new Error(
              `Isolated DSH Host smoke (${scenario.id}) failed: ${hostResult.failure?.name ?? 'Error'}: ${hostResult.failure?.message ?? 'unknown error'}${hostResult.failure?.stack ? `\n${hostResult.failure.stack}` : ''}`,
            );
          }
        }
        throw error;
      }

      const hostResult = JSON.parse(await readFile(resultPath, 'utf8'));
      if (!hostResult.ok) {
        throw new Error(
          `Isolated DSH Host smoke (${scenario.id}) failed: ${hostResult.failure?.name ?? 'Error'}: ${hostResult.failure?.message ?? 'unknown error'}${hostResult.failure?.stack ? `\n${hostResult.failure.stack}` : ''}`,
        );
      }
      for (const fixture of fixtures) {
        const after = await readTreeBytes(fixture.directory);
        assertSameFileTree(fixture.before, after, fixture.name);
      }
      const proCache = path.join(isolated.dirs.dshHome, 'cache', 'dsh-oil-ui');
      const proCacheCreated = await directoryExists(proCache);
      invariant(!proCacheCreated, `The ${scenario.id} run created an Oil UI Pro compilation cache.`);
      scenarioResults.push({
        ...hostResult.summary,
        rawFilesystemFixturesUnchanged: true,
        proCacheCreated,
      });
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          dshVersion: installedDsh.version,
          installSmoke: installMode,
          profile: DSH_PROFILE,
          nodeVersion: process.version,
          platform: process.platform,
          pnpmSource: pnpm.source,
          scenarios: scenarioResults,
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
  process.stderr.write(
    `DSH smoke failed (dsh=${smokeDshLabel}, profile=${DSH_PROFILE}, node=${process.version}, platform=${process.platform}, stage=${smokeStage}): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
