import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { chmod, lstat, readFile, readdir, mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  loadUpstreamSkill,
  skillDirectory,
  skillStatus,
  resolveActiveSkill,
  resolveImageGenScript,
  createSkillProvider,
  checkSkillUpdate,
  loadReviewerManual,
  loadSkillDirectory,
} from '../src/skill/upstream.ts';
import { createHash } from 'node:crypto';
import { delimiter, join, relative, sep } from 'node:path';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => {
    if (!fixture.home) throw new Error('Test HOME must be isolated');
    return fixture.home;
  },
}));

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'oil-upstream-')));
  fixture.home = root;
  vi.stubEnv('DSH_HOME', join(root, '.dsh'));
  vi.stubEnv('DSH_AGENTS_HOME', '');
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('XDG_CONFIG_HOME', join(root, '.config'));
  vi.stubEnv('XDG_STATE_HOME', join(root, '.local/state'));
  vi.stubEnv('APPDATA', join(root, 'AppData/Roaming'));
  vi.stubEnv('OIL_UI_PRO_DIR', '');
  vi.stubEnv('OIL_UI_IMAGE_GEN_SCRIPT', '');
  vi.stubEnv('OIL_TOKEN', '');
  vi.stubEnv('OIL_API', '');
  vi.stubEnv('OIL_NO_UPDATE_CHECK', '1');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function pro(path: string, name = 'oil-ui-pro', rawBody = 'Local instructions\n', version = '9.8.7') {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Local Skill\nmetadata:\n  version: '${version}'\n---\n${rawBody}`,
  );
  return path;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function nextPatchVersion(version: string) {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return `${major}.${minor}.${patch + 1}`;
}

async function installProUpdateShim() {
  const directory = await pro(
    join(root, 'updateable-pro'),
    'oil-ui-pro',
    'Synthetic update body with `--frames` intact.\n',
    '1.0.0',
  );
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const runner = join(root, 'fake-npx.cjs');
  await writeFile(
    runner,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "const pathIndex = args.indexOf('--path');",
      "if (pathIndex < 0 || !args[pathIndex + 1]) throw new Error('Missing --path fixture argument');",
      "const skillPath = path.join(args[pathIndex + 1], 'SKILL.md');",
      "const current = fs.readFileSync(skillPath, 'utf8');",
      'const updated = current.replace("version: \'1.0.0\'", "version: \'1.1.0\'");',
      "if (updated === current) throw new Error('Fixture Pro version was not 1.0.0');",
      'fs.writeFileSync(skillPath, updated);',
    ].join('\n'),
  );
  const executable = join(bin, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  await writeFile(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(runner)} "$@"\n`);
  await chmod(executable, 0o755);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('OIL_NO_UPDATE_CHECK', '0');
  vi.stubEnv('XDG_STATE_HOME', join(root, 'state-update-fixture'));
  const fetcher = vi.fn(async () => Response.json({ skills: { 'oil-ui-pro': { latest: '1.1.0' } } }));
  vi.stubGlobal('fetch', fetcher);
  return { directory, fetcher };
}

async function installLiteUpdateShim() {
  const directory = join(root, '.agents/skills/oil-ui');
  const body = 'Original Lite update fixture keeps `--frames` and `scripts/shoot.mjs` intact.\n';
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: oil-ui\ndescription: Synthetic filesystem Lite\nmetadata:\n  version: '1.0.0'\n---\n${body}`,
  );
  const bin = join(root, 'bin-lite-update');
  await mkdir(bin, { recursive: true });
  const runner = join(root, 'fake-lite-npx.cjs');
  const callLog = join(root, 'lite-update-call.json');
  await writeFile(
    runner,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "const pathIndex = args.indexOf('--path');",
      "if (pathIndex < 0 || !args[pathIndex + 1]) throw new Error('Missing --path fixture argument');",
      "if (args[args.indexOf('update') + 1] !== 'oil-ui') throw new Error('Unexpected Skill identity');",
      `fs.writeFileSync(${JSON.stringify(callLog)}, JSON.stringify(args));`,
      "const skillPath = path.join(args[pathIndex + 1], 'SKILL.md');",
      "const current = fs.readFileSync(skillPath, 'utf8');",
      'const updated = current.replace("version: \'1.0.0\'", "version: \'1.1.0\'");',
      "if (updated === current) throw new Error('Fixture Lite version was not 1.0.0');",
      'fs.writeFileSync(skillPath, updated);',
    ].join('\n'),
  );
  const executable = join(bin, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  await writeFile(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(runner)} "$@"\n`);
  await chmod(executable, 0o755);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('OIL_NO_UPDATE_CHECK', '0');
  vi.stubEnv('XDG_STATE_HOME', join(root, 'state-lite-update-fixture'));
  const fetcher = vi.fn(async () => Response.json({ skills: { 'oil-ui': { latest: '1.1.0' } } }));
  vi.stubGlobal('fetch', fetcher);
  return { directory, body, callLog, fetcher };
}

describe('bundled open-source Skill and local Pro activation', () => {
  it('registers the original open-source body and resource directory unchanged', async () => {
    const manifest = JSON.parse(await readFile(join(skillDirectory, '../oil-ui.manifest.json'), 'utf8'));
    const registered = await loadUpstreamSkill({ preferPro: false });
    const raw = await readFile(join(skillDirectory, 'SKILL.md'), 'utf8');
    expect(manifest.distribution).toBe('original');
    expect(manifest).not.toHaveProperty('transformVersion');
    expect(registered.content).toBe(raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''));
    expect(registered.name).toBe('oil-ui');
    expect(registered.source).toBe('bundled-lite');
    expect(registered.metadata?.version).toBe(manifest.version);
    expect(registered.resourceBase).toEqual({ kind: 'directory', path: skillDirectory });
    expect(registered.invocation).toEqual({ modelInvocable: true, userInvocable: true });
    const manual = await readFile(join(skillDirectory, 'references/reviewer-manual.md'), 'utf8');
    expect(await loadReviewerManual({ preferPro: false })).toBe(manual);
  });

  it('bundles the reviewed public files with matching offline manifest evidence and no Pro tree', async () => {
    const manifest = JSON.parse(await readFile(join(skillDirectory, '../oil-ui.manifest.json'), 'utf8'));
    expect(manifest.name).toBe('oil-ui');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.fileCount).toBeGreaterThan(0);
    const walk = async (directory: string): Promise<string[]> => {
      const paths: string[] = [];
      for (const row of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, row.name);
        const info = await lstat(path);
        expect(info.isSymbolicLink()).toBe(false);
        if (info.isDirectory()) paths.push(...(await walk(path)));
        else paths.push(relative(skillDirectory, path).split(sep).join('/'));
      }
      return paths;
    };
    expect((await walk(skillDirectory)).sort()).toEqual(manifest.files.map((f: { path: string }) => f.path).sort());
    expect(manifest.files).toHaveLength(manifest.fileCount);
    for (const file of manifest.files) {
      expect(file.path).not.toMatch(
        /^(references\/(direction-concept|direction-workspace|cards)\.md|assets\/cards(?:\/|$))/,
      );
      const bytes = await readFile(join(skillDirectory, file.path));
      const info = await lstat(join(skillDirectory, file.path));
      expect(bytes.length).toBe(file.size);
      if (process.platform !== 'win32') {
        expect(`0${(info.mode & 0o777).toString(8).padStart(3, '0')}`).toBe(file.mode);
      }
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    expect((await readdir(join(skillDirectory, '..'))).sort()).toEqual(['oil-ui', 'oil-ui.manifest.json']);
  });

  it('detects Pro and loads its original Markdown and reviewer manual unchanged', async () => {
    const manifest = JSON.parse(await readFile(join(skillDirectory, '../oil-ui.manifest.json'), 'utf8'));
    const rawProBody = 'Pro keeps `--frames` and `scripts/shoot.mjs` unchanged.\n';
    const dir = await pro(join(root, 'explicit'), 'oil-ui-pro', rawProBody);
    await mkdir(join(dir, 'references'), { recursive: true });
    const rawTools = '# Tools\nRun `node scripts/shoot.mjs --frames 3`.\n';
    const rawManual = '# Pro review manual\nKeep `--frames` and `oil_ui_skill_status` verbatim.\n';
    await writeFile(join(dir, 'references/tools.md'), rawTools);
    await writeFile(join(dir, 'references/reviewer-manual.md'), rawManual);
    // Old private-install remnants must be inert, whether absent or malformed.
    await mkdir(join(dir, 'adapters/dsh'), { recursive: true });
    await writeFile(join(dir, 'adapters/dsh/adapter.json'), '{ this is deliberately invalid JSON');
    const options = { proSkillDir: ` ${dir} ` };
    const resolved = await resolveActiveSkill(options);
    expect(resolved).toMatchObject({
      edition: 'pro',
      name: 'oil-ui-pro',
      directory: dir,
      source: 'local-pro',
    });
    expect(resolved.directory).toBe(dir);
    const registration = await loadUpstreamSkill(options);
    expect(registration).toMatchObject({
      name: 'oil-ui-pro',
      content: rawProBody,
      path: join(dir, 'SKILL.md'),
      resourceBase: { kind: 'directory', path: dir },
      metadata: { version: '9.8.7' },
    });
    expect(await readFile(join(dir, 'references/tools.md'), 'utf8')).toBe(rawTools);
    expect(await loadReviewerManual(options)).toBe(rawManual);

    const status = await skillStatus(
      { ...registration, invocation: registration.invocation!, source: registration.source!, provider: 'test' },
      options,
    );
    expect(status).toMatchObject({
      edition: 'pro',
      activeSkillName: 'oil-ui-pro',
      activeVersion: '9.8.7',
      bundledVersion: manifest.version,
      proInstalled: true,
      proSourcePath: dir,
      activeResourceBase: dir,
      skillReady: true,
      nativeSkillReady: true,
      skillLoadState: 'ready',
      visibleMatchesOriginal: true,
    });
    expect(status.note).toContain('All Oil UI instructions are loaded unchanged');
    expect(status).not.toHaveProperty('proAdapterReady');
    expect(status).not.toHaveProperty('proAdapterError');
    expect(status).not.toHaveProperty('transformDiagnostics');
    expect(status).not.toHaveProperty('transformWarning');
  });

  it('falls back with no Pro and allows preferPro=false while still reporting an installed Pro', async () => {
    expect(await resolveActiveSkill()).toMatchObject({ edition: 'lite', source: 'bundled-lite', name: 'oil-ui' });
    expect(await skillStatus(null)).toMatchObject({
      proInstalled: false,
      proSourcePath: null,
      visibleMatchesOriginal: false,
    });
    const dir = await pro(join(root, 'explicit'));
    const options = { proSkillDir: dir, preferPro: false };
    const lite = await loadUpstreamSkill(options);
    const status = await skillStatus({ ...lite, provider: 'oil-ui-provider', invocation: lite.invocation! }, options);
    expect(status).toMatchObject({
      edition: 'lite',
      activeSkillName: 'oil-ui',
      proInstalled: true,
      proSourcePath: dir,
      nativeSkillReady: true,
      skillLoadState: 'ready',
    });
    expect(status.upgradeHint).toContain('已发现本地 Pro');
    expect(status.upgradeHint).toContain('filesystem Skill 目录');
  });

  it('keeps the plugin Skill provider Lite even when Pro is preferred and installed', async () => {
    const dir = await pro(join(root, 'provider-pro'), 'oil-ui-pro', 'Raw Pro body\n');
    const provider = createSkillProvider(
      { proSkillDir: dir, preferPro: true },
      { signal: new AbortController().signal, invalidate: vi.fn() },
    );
    const candidates = await provider.list({});
    if (!Array.isArray(candidates)) throw new Error('Expected a complete bundled Lite catalog');
    expect(candidates.map((candidate) => candidate.name)).toEqual(['oil-ui']);
    expect(candidates[0]).toMatchObject({ provider: 'oil-ui-provider', rank: 20 });
    expect((await provider.get(candidates[0]!, {}))?.name).toBe('oil-ui');
    expect(await provider.get({ ...candidates[0]!, name: 'oil-ui-pro' }, {})).toBeUndefined();
    await expect(lstat(join(root, '.dsh/cache'))).rejects.toThrow();
  });

  it('keeps an installed Pro effective when adapter-era residue is absent or malformed', async () => {
    const dir = await pro(join(root, 'adapter-residue'), 'oil-ui-pro', 'Private synthetic instructions\n');
    const residue = join(dir, 'adapters/dsh');
    await mkdir(residue, { recursive: true });
    await writeFile(join(residue, 'adapter.json'), '{ invalid fixture residue');
    const active = await resolveActiveSkill({ proSkillDir: dir });
    const registration = await loadUpstreamSkill({ proSkillDir: dir });
    expect(active).toMatchObject({ edition: 'pro', name: 'oil-ui-pro', directory: dir });
    expect(registration.content).toBe('Private synthetic instructions\n');
    expect(registration.resourceBase).toEqual({ kind: 'directory', path: dir });
    expect(registration.content).not.toContain('NATIVE_');
    await expect(lstat(join(root, '.dsh/cache'))).rejects.toThrow();
  });

  it('accepts Harness-trimmed Pro body whitespace while rejecting an internal body edit', async () => {
    const rawBody = '\n\n  Keep `--frames` exactly.\n\n';
    const dir = await pro(join(root, 'trimmed-filesystem-pro'), 'oil-ui-pro', rawBody, '1.2.3');
    const originalFile = await readFile(join(dir, 'SKILL.md'), 'utf8');
    const loaded = await loadUpstreamSkill({ proSkillDir: dir });
    expect(loaded.content).toBe(rawBody);

    const filesystemWinner = {
      ...loaded,
      content: loaded.content.trim(),
      provider: 'filesystem',
      invocation: loaded.invocation!,
    };
    expect(await skillStatus(filesystemWinner, { proSkillDir: dir })).toMatchObject({
      nativeSkillReady: true,
      visibleMatchesOriginal: true,
      skillLoadState: 'ready',
    });
    expect(
      await skillStatus(
        { ...filesystemWinner, content: filesystemWinner.content.replace('exactly', 'internally changed') },
        { proSkillDir: dir },
      ),
    ).toMatchObject({ nativeSkillReady: false, visibleMatchesOriginal: false, skillLoadState: 'overridden' });
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(originalFile);
  });

  it('keeps explicit and DeepSeek Harness roots ahead of oil-cli fallback installations', async () => {
    const claude = await pro(join(root, '.claude/skills/oil-ui-pro'));
    expect((await resolveActiveSkill()).directory).toBe(claude);

    const agents = await pro(join(root, '.agents/skills/oil-ui-pro'));
    expect((await resolveActiveSkill()).directory).toBe(agents);

    const dsh = await pro(join(root, '.dsh/skills/oil-ui-pro'));
    expect((await resolveActiveSkill()).directory).toBe(dsh);

    const projectDir = join(root, 'workspace');
    const projectAgents = await pro(join(projectDir, '.agents/skills/oil-ui-pro'));
    expect((await resolveActiveSkill({ cwd: projectDir })).directory).toBe(projectAgents);

    const projectDsh = await pro(join(projectDir, '.dsh/skills/oil-ui-pro'));
    expect((await resolveActiveSkill({ cwd: projectDir })).directory).toBe(projectDsh);

    const env = await pro(join(root, 'env'));
    vi.stubEnv('OIL_UI_PRO_DIR', env);
    expect((await resolveActiveSkill({ cwd: projectDir })).directory).toBe(env);

    const explicit = await pro(join(root, 'explicit'));
    expect((await resolveActiveSkill({ cwd: projectDir, proSkillDir: explicit })).directory).toBe(explicit);
  });

  it.each(['.claude', '.codex', '.cursor', '.workbuddy'])(
    'discovers an oil-cli %s-only installation without changing image-gen roots',
    async (agent) => {
      const directory = await pro(join(root, agent, 'skills/oil-ui-pro'));
      expect(await resolveActiveSkill()).toMatchObject({ edition: 'pro', directory });
      const image = join(root, agent, 'skills/image-gen/scripts/image_gen.py');
      await mkdir(join(image, '..'), { recursive: true });
      await writeFile(image, '# Fixture script');
      expect(await resolveImageGenScript()).toBeNull();
    },
  );

  it('honors oil-cli CODEX_HOME and resolves a Claude installation symlink without copying the source', async () => {
    const custom = await pro(join(root, 'custom-codex/skills/oil-ui-pro'));
    vi.stubEnv('CODEX_HOME', '~/custom-codex');
    expect((await resolveActiveSkill()).directory).toBe(custom);
    const claudeLink = join(root, '.claude/skills/oil-ui-pro');
    await mkdir(join(claudeLink, '..'), { recursive: true });
    await symlink(custom, claudeLink, 'dir');
    expect((await resolveActiveSkill()).directory).toBe(custom);
  });

  it('ignores wrong identity, malformed YAML and SKILL.md symlink escapes', async () => {
    const invalid = await pro(join(root, 'invalid'), 'other');
    expect((await resolveActiveSkill({ proSkillDir: invalid })).edition).toBe('lite');
    await writeFile(join(invalid, 'SKILL.md'), '---\nname: [invalid\n---\n');
    expect((await resolveActiveSkill({ proSkillDir: invalid })).edition).toBe('lite');
    const valid = await pro(join(root, 'valid'));
    await rm(join(invalid, 'SKILL.md'));
    await symlink(join(valid, 'SKILL.md'), join(invalid, 'SKILL.md'));
    expect((await resolveActiveSkill({ proSkillDir: invalid })).edition).toBe('lite');
  });
});

async function imageScript(path: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '# local image script');
  return path;
}
describe('local image-gen discovery', () => {
  it('reports missing image-gen and discovers configured/env scripts without caching', async () => {
    expect(await resolveImageGenScript()).toBe(null);
    expect(await skillStatus(null, { preferPro: false })).toMatchObject({
      imageGenAvailable: false,
      imageGenScriptPath: null,
      imageSource: 'none',
      oilLoggedIn: false,
      oilBalance: null,
    });
    const env = await imageScript(join(root, 'env/image_gen.py'));
    vi.stubEnv('OIL_UI_IMAGE_GEN_SCRIPT', env);
    expect(await resolveImageGenScript()).toBe(env);
    const explicit = await imageScript(join(root, 'explicit/mock.py'));
    expect(await resolveImageGenScript({ imageGenScript: ' ' + explicit + ' ' })).toBe(explicit);
    expect(await skillStatus(null, { preferPro: false, imageGenScript: explicit })).toMatchObject({
      imageGenAvailable: true,
      imageGenScriptPath: explicit,
      imageSource: 'image-gen',
    });
  });

  it('strictly follows DeepSeek Harness image-gen skill roots and ignores non-DSH hosts', async () => {
    for (const nonDshHost of ['.cursor', '.claude', '.codex']) {
      await imageScript(join(root, nonDshHost, 'skills/image-gen/scripts/image_gen.py'));
      expect(await resolveImageGenScript()).toBeNull();
    }
    const projectDir = join(root, 'workspace');
    for (const dir of [
      join(root, '.agents/skills/image-gen/scripts/image_gen.py'),
      join(root, '.dsh/skills/image-gen/scripts/image_gen.py'),
      join(projectDir, '.agents/skills/image-gen/scripts/image_gen.py'),
      join(projectDir, '.dsh/skills/image-gen/scripts/image_gen.py'),
    ]) {
      const path = await imageScript(dir);
      expect(await resolveImageGenScript({ cwd: projectDir })).toBe(path);
    }
  });

  it('ignores directories and rejects escaping script symlinks', async () => {
    const escaped = await imageScript(join(root, 'outside/mock.py'));
    const target = join(root, '.dsh/skills/image-gen/scripts/image_gen.py');
    await mkdir(join(target, '..'), { recursive: true });
    await symlink(escaped, target);
    expect(await resolveImageGenScript()).toBe(null);
    const explicit = join(root, 'links/mock.py');
    await mkdir(join(explicit, '..'), { recursive: true });
    await symlink(escaped, explicit);
    expect(await resolveImageGenScript({ imageGenScript: explicit })).toBe(null);
    expect(await resolveImageGenScript({ imageGenScript: root })).toBe(null);
  });
});

describe('discovery arbitration and update backoff', () => {
  it('discovers project roots from a nested cwd under a Git directory or worktree file', async () => {
    const project = join(root, 'project');
    const nested = join(project, 'src/deep');
    await mkdir(nested, { recursive: true });
    await writeFile(join(project, '.git'), 'gitdir: /not-needed-for-discovery');
    const directory = await pro(join(project, '.agents/skills/oil-ui-pro'));
    expect((await resolveActiveSkill({ cwd: nested })).directory).toBe(directory);
    const script = await imageScript(join(project, '.dsh/skills/image-gen/scripts/image_gen.py'));
    expect(await resolveImageGenScript({ cwd: nested })).toBe(script);
  });

  it('reports detected Pro separately from a scope-specific publisher exposing the matching Lite bundle', async () => {
    const dir = await pro(join(root, 'pro'));
    const lite = await loadUpstreamSkill({ preferPro: false });
    const visible = { ...lite, provider: 'scope-override', invocation: lite.invocation! };
    const status = await skillStatus(visible, { proSkillDir: dir });
    expect(status.detected).toMatchObject({ name: 'oil-ui-pro', version: '9.8.7' });
    expect(status.effective).toMatchObject({
      name: 'oil-ui',
      provider: 'scope-override',
      version: lite.metadata?.version,
    });
    expect(status.activeSkillName).toBe('oil-ui');
    expect(status.visibleMatchesOriginal).toBe(true);
    expect(status).toMatchObject({ nativeSkillReady: true, skillLoadState: 'ready', skillLoadWarning: null });
  });

  it.skipIf(process.platform === 'win32')(
    'rechecks the same filesystem winner after a successful Pro update',
    async () => {
      const { directory, fetcher } = await installProUpdateShim();
      const original = await loadUpstreamSkill({ proSkillDir: directory });
      const visible = { ...original, provider: 'filesystem', invocation: original.invocation! };
      const refreshVisible = vi.fn(async () => {
        const refreshed = await loadUpstreamSkill({ proSkillDir: directory });
        return { ...refreshed, provider: 'filesystem', invocation: refreshed.invocation! };
      });

      const status = await skillStatus(visible, { proSkillDir: directory, update: true }, undefined, refreshVisible);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(refreshVisible).toHaveBeenCalledTimes(1);
      expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toContain("version: '1.1.0'");
      expect(status).toMatchObject({
        updated: true,
        latestVersion: '1.1.0',
        edition: 'pro',
        activeSkillName: 'oil-ui-pro',
        activeVersion: '1.1.0',
        detected: { version: '1.1.0' },
        nativeSkillReady: true,
        visibleMatchesOriginal: true,
        skillLoadState: 'ready',
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'updates an original filesystem Lite and reloads that same directory',
    async () => {
      const { directory, body, callLog, fetcher } = await installLiteUpdateShim();
      const original = await loadSkillDirectory(directory, 'oil-ui', 'filesystem');
      const visible = { ...original, provider: 'filesystem', invocation: original.invocation! };
      const refreshVisible = vi.fn(async () => {
        const refreshed = await loadSkillDirectory(directory, 'oil-ui', 'filesystem');
        return { ...refreshed, provider: 'filesystem', invocation: refreshed.invocation! };
      });

      const status = await skillStatus(
        visible,
        { preferPro: false, cwd: root, update: true },
        undefined,
        refreshVisible,
      );
      const raw = await readFile(join(directory, 'SKILL.md'), 'utf8');

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(refreshVisible).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(callLog, 'utf8'))).toContain('oil-ui');
      expect(raw).toContain("version: '1.1.0'");
      expect(raw).toContain(body);
      expect(status).toMatchObject({
        updated: true,
        latestVersion: '1.1.0',
        edition: 'lite',
        activeSkillName: 'oil-ui',
        activeVersion: '1.1.0',
        effective: { provider: 'filesystem', path: join(directory, 'SKILL.md') },
        activeResourceBase: directory,
        visibleMatchesOriginal: true,
        skillLoadState: 'ready',
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'offers bundled Lite updates without invoking npx or writing the installation',
    async () => {
      vi.stubEnv('OIL_NO_UPDATE_CHECK', '0');
      vi.stubEnv('XDG_STATE_HOME', join(root, 'state-bundled-update-fixture'));
      const manifest = JSON.parse(await readFile(join(skillDirectory, '../oil-ui.manifest.json'), 'utf8')) as {
        version: string;
      };
      const latestVersion = nextPatchVersion(manifest.version);
      const sourcePath = join(skillDirectory, 'SKILL.md');
      const original = await readFile(sourcePath, 'utf8');
      const bin = join(root, 'bin-bundled-update');
      const callLog = join(root, 'bundled-update-call.txt');
      await mkdir(bin, { recursive: true });
      const executable = join(bin, 'npx');
      await writeFile(executable, `#!/bin/sh\nprintf invoked > ${shellQuote(callLog)}\nexit 0\n`);
      await chmod(executable, 0o755);
      vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
      const fetcher = vi.fn(async () => Response.json({ skills: { 'oil-ui': { latest: latestVersion } } }));
      vi.stubGlobal('fetch', fetcher);
      const loaded = await loadUpstreamSkill({ preferPro: false });
      const visible = { ...loaded, provider: 'oil-ui-provider', invocation: loaded.invocation! };

      const status = await skillStatus(visible, { preferPro: false, update: true });

      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(readFile(callLog, 'utf8')).rejects.toThrow();
      expect(await readFile(sourcePath, 'utf8')).toBe(original);
      expect(status).toMatchObject({
        bundledVersion: manifest.version,
        updateAvailable: true,
        updated: false,
        nativeSkillReady: true,
        visibleMatchesOriginal: true,
      });
      expect(status.updateNotice).toContain('Update the dsh-oil-ui plugin');
    },
  );

  it.skipIf(process.platform === 'win32').each(['stale', 'tampered'] as const)(
    'does not infer readiness from updated files when the same-scope winner is %s',
    async (winnerState) => {
      const { directory, fetcher } = await installProUpdateShim();
      const original = await loadUpstreamSkill({ proSkillDir: directory });
      const visible = { ...original, provider: 'filesystem', invocation: original.invocation! };
      const refreshVisible = vi.fn(async () => {
        if (winnerState === 'stale') return visible;
        const refreshed = await loadUpstreamSkill({ proSkillDir: directory });
        return {
          ...refreshed,
          content: `${refreshed.content}\nWinner body was changed by a different scope.`,
          provider: 'filesystem',
          invocation: refreshed.invocation!,
        };
      });

      const status = await skillStatus(visible, { proSkillDir: directory, update: true }, undefined, refreshVisible);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(refreshVisible).toHaveBeenCalledTimes(1);
      expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toContain("version: '1.1.0'");
      expect(status).toMatchObject({
        updated: true,
        nativeSkillReady: false,
        visibleMatchesOriginal: false,
        skillLoadState: 'overridden',
      });
      expect(status.activeVersion).toBe(winnerState === 'stale' ? '1.0.0' : '1.1.0');
    },
  );

  it('backs off unsuccessful checks even without a successful version or writable disk cache', async () => {
    vi.stubEnv('OIL_NO_UPDATE_CHECK', '0');
    const state = join(root, 'unwritable-state');
    await writeFile(state, 'a file, not a directory');
    vi.stubEnv('XDG_STATE_HOME', state);
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const active = await resolveActiveSkill({ preferPro: false });
    await Promise.all([checkSkillUpdate(active, '1.0.0'), checkSkillUpdate(active, '1.0.0')]);
    await checkSkillUpdate(active, '1.0.0');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await checkSkillUpdate(active, '1.0.0', true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains the last successful version and retries only after increasing cooldowns', async () => {
    vi.stubEnv('OIL_NO_UPDATE_CHECK', '0');
    vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            skills: {
              'oil-ui': {
                latest: '2.0.0',
                published_at: '2026-10-28T00:00:00Z',
                history: [{ version: '2.0.0', published_at: '2026-10-28T00:00:00Z', notes: '' }],
              },
            },
          }),
        ),
      )
      .mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const active = await resolveActiveSkill({ preferPro: false });
    expect(await checkSkillUpdate(active, '1.0.0')).toMatchObject({
      latestVersion: '2.0.0',
      updateAvailable: true,
      lastError: null,
    });
    clock.mockReturnValue(now + 600_001);
    expect(await checkSkillUpdate(active, '1.0.0')).toMatchObject({
      latestVersion: '2.0.0',
      lastError: 'offline',
    });
    await checkSkillUpdate(active, '1.0.0');
    expect(fetcher).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(now + 630_002);
    await checkSkillUpdate(active, '1.0.0');
    expect(fetcher).toHaveBeenCalledTimes(3);
    clock.mockReturnValue(now + 660_002);
    await checkSkillUpdate(active, '1.0.0');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reads skills[name].latest from the real API schema, recovers poisoned legacy caches, and surfaces lastError', async () => {
    vi.stubEnv('OIL_NO_UPDATE_CHECK', '0');
    const stateDir = join(root, 'state-latest');
    vi.stubEnv('XDG_STATE_HOME', stateDir);
    await mkdir(join(stateDir, 'oil'), { recursive: true });
    const nowSec = Math.floor(Date.now() / 1000);
    // Simulate a poisoned v0.4.1 cache where `version` was misread (`succeededAt: 0, failures: 3`).
    await writeFile(
      join(stateDir, 'oil', 'oil-ui-pro-update.json'),
      JSON.stringify({ attemptedAt: nowSec, succeededAt: 0, failures: 3, latest: '0.26.0' }),
    );
    const proDir = await pro(join(root, 'pro-latest'));
    const active = await resolveActiveSkill({ proSkillDir: proDir });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            skills: {
              'oil-ui-pro': {
                latest: '0.28.0',
                published_at: '2026-10-30T00:00:00Z',
                history: [{ version: '0.28.0', published_at: '2026-10-30T00:00:00Z', notes: '' }],
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }));
    vi.stubGlobal('fetch', fetcher);

    const first = await checkSkillUpdate(active, '0.27.0');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      latestVersion: '0.28.0',
      updateAvailable: true,
      lastError: null,
    });
    expect(first.updateNotice).toContain('0.27.0 -> 0.28.0');
    const saved = JSON.parse(await readFile(join(stateDir, 'oil', 'oil-ui-pro-update.json'), 'utf8'));
    expect(saved).toMatchObject({
      succeededAt: saved.attemptedAt,
      failures: 0,
      latest: '0.28.0',
      lastError: null,
    });

    // When local Skill is already upgraded past the cached latest and an explicit check fails with HTTP 504:
    const second = await checkSkillUpdate(active, '0.29.0', true);
    expect(second).toMatchObject({
      latestVersion: '0.29.0',
      updateAvailable: false,
      lastError: 'HTTP 504',
    });
  });
});

describe('raw Pro resources and Lite package evidence', () => {
  it('reads the Pro reviewer manual afresh without transforming its native options', async () => {
    const dir = await pro(join(root, 'pro-reviewer'));
    await mkdir(join(dir, 'references'));
    const manual = join(dir, 'references/reviewer-manual.md');
    const first = '# Raw Pro manual\nUse `--frames 3` unchanged.\n';
    const second = '# Updated raw Pro manual\nKeep `--frames 5` unchanged.\n';
    await writeFile(manual, first);
    expect(await loadReviewerManual({ proSkillDir: dir })).toBe(first);
    await writeFile(manual, second);
    expect(await loadReviewerManual({ proSkillDir: dir })).toBe(second);
  });

  it('rejects a Pro reviewer manual symlink that escapes the active Skill root', async () => {
    const dir = await pro(join(root, 'escaped-reviewer-pro'));
    await mkdir(join(dir, 'references'), { recursive: true });
    const outside = join(root, 'outside-reviewer-manual.md');
    await writeFile(outside, '# PRIVATE OUTSIDE MANUAL\n');
    await symlink(outside, join(dir, 'references/reviewer-manual.md'));

    const active = await resolveActiveSkill({ proSkillDir: dir });
    expect(active).toMatchObject({ edition: 'pro', name: 'oil-ui-pro', directory: dir });
    const bundled = await readFile(join(skillDirectory, 'references/reviewer-manual.md'), 'utf8');
    const loaded = await loadReviewerManual({ proSkillDir: dir }, active);
    expect(loaded).toBe(bundled);
    expect(loaded).not.toContain('PRIVATE OUTSIDE MANUAL');
  });
});
