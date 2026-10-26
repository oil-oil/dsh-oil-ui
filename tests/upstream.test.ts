import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { lstat, readFile, readdir, mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'node:fs/promises';
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
} from '../src/skill/upstream.ts';
import { TRANSFORM_VERSION, isHarnessNativeSkillMarkdown, transformSkillMarkdown } from '../src/skill/transform.ts';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => fixture.home,
}));

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'oil-upstream-')));
  fixture.home = root;
  vi.stubEnv('DSH_HOME', join(root, '.dsh'));
  vi.stubEnv('DSH_AGENTS_HOME', '');
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

async function pro(path: string, name = 'oil-ui-pro', rawBody = 'Local instructions\n') {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Local Skill\nmetadata:\n  version: '9.8.7'\n---\n${rawBody}`,
  );
  return path;
}

describe('bundled open-source Skill and local Pro activation', () => {
  it('registers the compiled native Harness open-source body and resource directory', async () => {
    const manifest = JSON.parse(await readFile(join(skillDirectory, '../oil-ui.manifest.json'), 'utf8'));
    const registered = await loadUpstreamSkill({ preferPro: false });
    const raw = await readFile(join(skillDirectory, 'SKILL.md'), 'utf8');
    expect(isHarnessNativeSkillMarkdown(raw)).toBe(true);
    expect(raw).not.toContain('check_update.sh');
    expect(raw).toContain('oil_ui_shoot');
    expect(registered.content).toBe(raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''));
    expect(registered.name).toBe('oil-ui');
    expect(registered.metadata?.version).toBe(manifest.version);
    expect(registered.resourceBase).toEqual({ kind: 'directory', path: skillDirectory });
    expect(registered.invocation).toEqual({ modelInvocable: true, userInvocable: true });

    const toolsMd = await readFile(join(skillDirectory, 'references/tools.md'), 'utf8');
    expect(toolsMd).toContain('oil_ui_shoot');
    expect(toolsMd).not.toContain('node scripts/shoot.mjs');
    const uxDispatch = await readFile(join(skillDirectory, 'references/ux-review.md'), 'utf8');
    expect(uxDispatch).toContain('子 Agent 启动时系统提示词中已自动注入本目录');
    expect(uxDispatch).not.toContain('模板路径换成本 Skill 目录下的绝对路径');
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
      expect(`0${(info.mode & 0o777).toString(8).padStart(3, '0')}`).toBe(file.mode);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    expect((await readdir(join(skillDirectory, '..'))).sort()).toEqual(['oil-ui', 'oil-ui.manifest.json']);
  });

  it('detects explicit Pro, compiles raw Pro Markdown into native Harness tools, and reports both versions', async () => {
    const manifest = JSON.parse(await readFile(join(skillDirectory, '../oil-ui.manifest.json'), 'utf8'));
    const rawProBody =
      '启动时后台静默运行更新检查（`bash "<skill-dir>/scripts/check_update.sh" >/dev/null 2>&1 &`）\n用 `scripts/shoot.mjs` 截图\n';
    const dir = await pro(join(root, 'explicit'), 'oil-ui-pro', rawProBody);
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(
      join(dir, 'references/tools.md'),
      '# 工具参考\n`node scripts/shoot.mjs http://localhost:3000 --out ./shots`\n',
    );
    const options = { proSkillDir: ` ${dir} ` };
    const resolved = await resolveActiveSkill(options);
    expect(resolved).toMatchObject({
      edition: 'pro',
      name: 'oil-ui-pro',
      sourceDirectory: dir,
      source: 'local-pro',
    });
    expect(resolved.directory).toContain(join(root, '.dsh/cache/dsh-oil-ui/oil-ui-pro-'));
    const registration = await loadUpstreamSkill(options);
    expect(registration.resourceBase).toEqual({ kind: 'directory', path: resolved.directory });
    expect(registration.content).toContain('oil_ui_skill_status');
    expect(registration.content).toContain('oil_ui_shoot');
    expect(registration.content).not.toContain('check_update.sh');
    const compiledTools = await readFile(join(resolved.directory, 'references/tools.md'), 'utf8');
    expect(compiledTools).toContain('oil_ui_shoot');
    expect(compiledTools).not.toContain('node scripts/shoot.mjs');

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
      activeResourceBase: resolved.directory,
      visibleMatchesOriginal: true,
    });
    expect(status.note).toContain('No hash gate is enforced during loading or execution.');
    expect(status.transformDiagnostics?.sourceDirectory).toBe(dir);
    expect(status.transformDiagnostics?.unmatchedRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'skill.compatibility', file: 'SKILL.md', required: true }),
        expect.objectContaining({ id: 'media.sheet', file: 'references/media.md', required: true }),
      ]),
    );
    expect(status.transformDiagnostics?.unmatchedRules.some((rule) => rule.id === 'skill.pro-notice')).toBe(false);
  });

  it('uses already-compiled Pro directory directly without re-caching', async () => {
    const nativeBody = transformSkillMarkdown(
      'SKILL.md',
      '---\nname: oil-ui-pro\ndescription: Native Pro\n---\nCall `oil_ui_skill_status` and `oil_ui_shoot`.\n',
      { edition: 'pro', mode: 'lenient' },
    ).markdown;
    const dir = join(root, 'native-pro');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), nativeBody);
    const resolved = await resolveActiveSkill({ proSkillDir: dir });
    expect(resolved.directory).toBe(dir);
    expect(resolved.sourceDirectory).toBe(dir);
  });

  it('falls back with no Pro and allows preferPro=false while still reporting an installed Pro', async () => {
    expect(await resolveActiveSkill()).toMatchObject({ edition: 'lite', source: 'bundled-lite', name: 'oil-ui' });
    expect(await skillStatus(null)).toMatchObject({
      proInstalled: false,
      proSourcePath: null,
      visibleMatchesOriginal: false,
    });
    const dir = await pro(join(root, 'explicit'));
    const status = await skillStatus(null, { proSkillDir: dir, preferPro: false });
    expect(status).toMatchObject({
      edition: 'lite',
      activeSkillName: 'oil-ui',
      proInstalled: true,
      proSourcePath: dir,
    });
    expect(status.upgradeHint).toContain('npx github:oil-oil/oil-cli install oil-ui-pro');
  });

  it('strictly follows DeepSeek Harness skill roots in priority order and ignores non-DSH hosts', async () => {
    for (const nonDshHost of ['.cursor', '.codex', '.claude']) {
      await pro(join(root, nonDshHost, 'skills/oil-ui-pro'));
    }
    expect((await resolveActiveSkill()).edition).toBe('lite');

    const agents = await pro(join(root, '.agents/skills/oil-ui-pro'));
    expect((await resolveActiveSkill()).sourceDirectory).toBe(agents);

    const dsh = await pro(join(root, '.dsh/skills/oil-ui-pro'));
    expect((await resolveActiveSkill()).sourceDirectory).toBe(dsh);

    const projectDir = join(root, 'workspace');
    const projectAgents = await pro(join(projectDir, '.agents/skills/oil-ui-pro'));
    expect((await resolveActiveSkill({ cwd: projectDir })).sourceDirectory).toBe(projectAgents);

    const projectDsh = await pro(join(projectDir, '.dsh/skills/oil-ui-pro'));
    expect((await resolveActiveSkill({ cwd: projectDir })).sourceDirectory).toBe(projectDsh);

    const env = await pro(join(root, 'env'));
    vi.stubEnv('OIL_UI_PRO_DIR', env);
    expect((await resolveActiveSkill({ cwd: projectDir })).sourceDirectory).toBe(env);

    const explicit = await pro(join(root, 'explicit'));
    expect((await resolveActiveSkill({ cwd: projectDir, proSkillDir: explicit })).sourceDirectory).toBe(explicit);
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

describe('discovery snapshots, arbitration and update backoff', () => {
  it('discovers project roots from a nested cwd under a Git directory or worktree file', async () => {
    const project = join(root, 'project');
    const nested = join(project, 'src/deep');
    await mkdir(nested, { recursive: true });
    await writeFile(join(project, '.git'), 'gitdir: /not-needed-for-discovery');
    const directory = await pro(join(project, '.agents/skills/oil-ui-pro'));
    expect((await resolveActiveSkill({ cwd: nested })).sourceDirectory).toBe(directory);
    const script = await imageScript(join(project, '.dsh/skills/image-gen/scripts/image_gen.py'));
    expect(await resolveImageGenScript({ cwd: nested })).toBe(script);
  });

  it('lists metadata without compiling Pro and reuses the header snapshot until it changes', async () => {
    const dir = await pro(join(root, 'raw-pro'));
    await mkdir(join(dir, 'references'));
    await writeFile(join(dir, 'references/tools.md'), '# 工具\nnode scripts/shoot.mjs <target>');
    const provider = createSkillProvider(
      { proSkillDir: dir },
      { signal: new AbortController().signal, invalidate: vi.fn() },
    );
    const first = (await provider.list({}))[0]!;
    expect(first.rank).toBe(10);
    await expect(lstat(join(root, '.dsh/cache'))).rejects.toThrow();
    const snapshot = (await provider.refresh()).snapshot;
    expect((await provider.refresh()).snapshot.header).toBe(snapshot.header);
    expect((await provider.refresh()).changed).toBe(false);
    const loaded = await provider.get(first, {});
    expect(loaded?.resourceBase).not.toEqual(first.resourceBase);
    await writeFile(join(dir, 'SKILL.md'), '---\nname: oil-ui-pro\ndescription: Changed\n---\nNew');
    expect((await provider.refresh()).changed).toBe(true);
  });

  it('reports detected Pro separately from a scope override that is actually effective', async () => {
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
    expect(status.visibleMatchesOriginal).toBe(false);
  });

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: { 'oil-ui': { version: '2.0.0' } } })))
      .mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const active = await resolveActiveSkill({ preferPro: false });
    expect(await checkSkillUpdate(active, '1.0.0')).toMatchObject({ latestVersion: '2.0.0', updateAvailable: true });
    clock.mockReturnValue(now + 600_001);
    expect(await checkSkillUpdate(active, '1.0.0')).toMatchObject({ latestVersion: '2.0.0' });
    await checkSkillUpdate(active, '1.0.0');
    expect(fetcher).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(now + 630_002);
    await checkSkillUpdate(active, '1.0.0');
    expect(fetcher).toHaveBeenCalledTimes(3);
    clock.mockReturnValue(now + 660_002);
    await checkSkillUpdate(active, '1.0.0');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('atomic versioned Pro compilation and review fallback', () => {
  it('merges concurrent compiles, includes every Markdown input, and recovers incomplete trees', async () => {
    const dir = await pro(join(root, 'pro'));
    await mkdir(join(dir, 'references/deep'), { recursive: true });
    await writeFile(join(dir, 'references/tools.md'), 'node scripts/shoot.mjs <target>');
    await writeFile(join(dir, 'references/deep/extra.md'), 'first version');
    const first = await Promise.all(Array.from({ length: 8 }, () => resolveActiveSkill({ proSkillDir: dir })));
    expect(new Set(first.map((s) => s.directory)).size).toBe(1);
    const compiled = first[0]!.directory;
    expect(await readFile(join(compiled, '.complete'), 'utf8')).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(compiled, 'references/deep/extra.md'), 'utf8')).toBe('first version');
    await rm(join(compiled, '.complete'));
    await writeFile(join(compiled, 'references/deep/extra.md'), 'partial');
    expect((await resolveActiveSkill({ proSkillDir: dir })).directory).toBe(compiled);
    expect(await readFile(join(compiled, 'references/deep/extra.md'), 'utf8')).toBe('first version');
    await writeFile(join(dir, 'references/deep/extra.md'), 'second version');
    const second = await resolveActiveSkill({ proSkillDir: dir });
    expect(second.directory).not.toBe(compiled);
    expect(await readFile(join(compiled, 'references/deep/extra.md'), 'utf8')).toBe('first version');
    const cache = await readdir(join(root, '.dsh/cache/dsh-oil-ui'));
    expect(cache.some((name) => name.startsWith('.oil-ui-pro-'))).toBe(false);
  });

  it('falls back to bundled review on compile failure and refreshes manuals after a version change', async () => {
    const dir = await pro(join(root, 'pro'));
    await mkdir(join(dir, 'references'));
    await writeFile(join(dir, 'references/tools.md'), 'node scripts/shoot.mjs <target>');
    await symlink(root, join(dir, 'references/escape'));
    expect(await loadReviewerManual({ proSkillDir: dir })).toContain('# 视觉与交互评审手册');
    await rm(join(dir, 'references/escape'));
    await writeFile(join(dir, 'references/reviewer-manual.md'), '# Version one');
    expect(await loadReviewerManual({ proSkillDir: dir })).toBe('# Version one');
    await writeFile(join(dir, 'references/reviewer-manual.md'), '# Version two');
    expect(await loadReviewerManual({ proSkillDir: dir })).toBe('# Version two');
  });

  it('keeps native docs free of CLI remnants and describes thumbnail scaling without narrowing the viewport', async () => {
    const manual = await readFile(join(skillDirectory, 'references/reviewer-manual.md'), 'utf8');
    expect(manual).not.toContain('size: "480x300"');
    expect(manual).toMatch(/原比例缩放到 480px 或 180px/);
    for (const [file, flag] of [
      ['layout-and-viewport', '--compare'],
      ['media', '--sheet'],
      ['style-explorer', '--help'],
    ]) {
      expect(await readFile(join(skillDirectory, `references/${file}.md`), 'utf8')).not.toContain(flag);
    }
    const tools = await readFile(join(skillDirectory, 'references/tools.md'), 'utf8');
    expect(tools).toContain('默认 `1440x900`');
    expect(tools).toContain('https://example.org/image.jpg');
    expect(TRANSFORM_VERSION.length).toBeGreaterThan(0);
  });
});
