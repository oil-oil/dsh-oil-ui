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
const DSH_PROFILE = process.env.DSH_SMOKE_PROFILE ?? 'web';
invariant(['web', 'headless'].includes(DSH_PROFILE), 'DSH_SMOKE_PROFILE must be web or headless.');
const CHILD_TIMEOUT_MS = 120_000;
const HOST_TIMEOUT_MS = 90_000;
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
        const diagnostic = output.replace(/([?&]token=)[^\s]+/gu, '$1[REDACTED]').trim();
        reject(new Error(`${label} failed (exit ${code ?? 'unknown'}${signal ? `, ${signal}` : ''}).\n${diagnostic}`));
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
        command: pnpmPath,
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

  // macOS /var aliases /private/var. Mixed spellings make pnpm encode an
  // unnecessarily long relative tarball path into one store filename.
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-oil-ui-smoke-')));
  try {
    const bootstrapRoot = path.join(tempRoot, 'bootstrap');
    await mkdir(bootstrapRoot, { recursive: true });
    const bootstrap = await createIsolation(bootstrapRoot);
    const installedDsh = await findInstalledDsh();
    const pnpm = await selectPnpm(tempRoot, bootstrap);
    const pnpmBin = await exposePnpmOnPath(tempRoot, pnpm.path);
    const npmExecPath = process.env.npm_execpath;
    invariant(npmExecPath && path.isAbsolute(npmExecPath), 'Run this script with npm run smoke:dsh.');
    await access(npmExecPath);
    const archive = path.join(tempRoot, 'plugin.tgz');
    await runChild(process.execPath, [npmExecPath, 'run', 'pack:plugin', '--', archive], {
      cwd: projectRoot,
      env: {
        ...bootstrap.env,
        PATH: `${pnpmBin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      },
      timeoutMs: CHILD_TIMEOUT_MS,
      label: 'Temporary Oil UI plugin package build',
    });
    await access(archive);

    const scenarioResults = [];
    for (const scenario of SCENARIOS) {
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
        PATH: `${pnpmBin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      };
      await runChild(installedDsh.cliPath, ['plugin', '--profile', DSH_PROFILE, 'add', archive], {
        cwd: workspace,
        env: commandEnv,
        timeoutMs: CHILD_TIMEOUT_MS,
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
              `Isolated DSH Host smoke (${scenario.id}) failed: ${hostResult.failure?.name ?? 'Error'}: ${hostResult.failure?.message ?? 'unknown error'}`,
            );
          }
        }
        throw error;
      }

      const hostResult = JSON.parse(await readFile(resultPath, 'utf8'));
      if (!hostResult.ok) {
        throw new Error(
          `Isolated DSH Host smoke (${scenario.id}) failed: ${hostResult.failure?.name ?? 'Error'}: ${hostResult.failure?.message ?? 'unknown error'}`,
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
  process.stderr.write(`DSH smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
