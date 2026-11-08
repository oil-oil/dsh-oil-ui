import { expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { SkillCandidate } from '@deepseek-ai/dsh-skill';
import type { createSkillProvider } from '../src/skill/upstream.ts';
import YAML from 'yaml';

const exec = promisify(execFile);

it('adds only its own bundle entry without overriding or disabling the host', async () => {
  const patch = YAML.parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  expect(patch).toEqual([{ insert: [{ id: 'dsh-oil-ui', name: 'dsh-oil-ui' }] }]);
});
const isolatedHome = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => {
    if (!isolatedHome.path) throw new Error('Test HOME must be isolated');
    return isolatedHome.path;
  },
}));

it('rebuilds stale lib and runs Lite, status, explorer and shoot from the unpacked archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oil-package-contract-'));
  const repository = process.cwd();
  const bundledManifest = JSON.parse(await readFile(join(repository, 'skills/oil-ui.manifest.json'), 'utf8')) as {
    version: string;
  };
  const disposers: (() => void | Promise<void>)[] = [];
  const previousEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    APPDATA: process.env.APPDATA,
    OIL_NO_UPDATE_CHECK: process.env.OIL_NO_UPDATE_CHECK,
    OIL_TOKEN: process.env.OIL_TOKEN,
    OIL_API: process.env.OIL_API,
    OIL_UI_PRO_DIR: process.env.OIL_UI_PRO_DIR,
    OIL_UI_IMAGE_GEN_SCRIPT: process.env.OIL_UI_IMAGE_GEN_SCRIPT,
  };
  const childEnv = {
    ...process.env,
    HOME: root,
    DSH_HOME: join(root, '.dsh'),
    DSH_AGENTS_HOME: '',
    CODEX_HOME: '',
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_STATE_HOME: join(root, '.local/state'),
    APPDATA: join(root, 'AppData/Roaming'),
    OIL_NO_UPDATE_CHECK: '1',
    OIL_TOKEN: '',
    OIL_API: '',
    OIL_UI_PRO_DIR: '',
    OIL_UI_IMAGE_GEN_SCRIPT: '',
  };
  try {
    for (const entry of ['src', 'scripts', 'skills', 'tsdown.config.ts', 'tsconfig.json', 'package.json', 'LICENSE']) {
      await cp(join(repository, entry), join(root, entry), { recursive: true });
    }
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'lib/index.js'), 'throw new Error("STALE_BUILD_SENTINEL");');
    const archive = join(root, 'result.tgz');
    const result = await exec(process.execPath, ['scripts/package-plugin.mjs', archive], { cwd: root, env: childEnv });
    expect(result.stdout).toContain('Build complete');
    const unpack = join(root, 'unpacked');
    await mkdir(unpack);
    await exec('tar', ['-xzf', archive, '-C', unpack], { env: childEnv });
    const bundled = await readFile(join(unpack, 'package/lib/index.js'), 'utf8');
    expect(bundled).not.toContain('STALE_BUILD_SENTINEL');
    expect(bundled).toContain('oil-ui-subagent-reviewer');
    expect(bundled).toBe(await readFile(join(root, 'lib/index.js'), 'utf8'));

    isolatedHome.path = root;
    process.env.DSH_HOME = join(root, '.dsh');
    process.env.DSH_AGENTS_HOME = '';
    process.env.CODEX_HOME = '';
    process.env.XDG_CONFIG_HOME = join(root, '.config');
    process.env.XDG_STATE_HOME = join(root, '.local/state');
    process.env.APPDATA = join(root, 'AppData/Roaming');
    process.env.OIL_NO_UPDATE_CHECK = '1';
    process.env.OIL_TOKEN = '';
    process.env.OIL_API = '';
    process.env.OIL_UI_PRO_DIR = '';
    process.env.OIL_UI_IMAGE_GEN_SCRIPT = '';
    const { apply } = await import(pathToFileURL(join(unpack, 'package/lib/index.js')).href);
    const tools = new Map<string, ToolDefinition>();
    const pending: Promise<unknown>[] = [];
    let provider: ReturnType<typeof createSkillProvider> | undefined;
    let candidate: SkillCandidate | undefined;
    const ctx = {
      effect(register: () => () => void | Promise<void>) {
        disposers.push(register());
      },
      on() {
        return () => {};
      },
      inject(services: string[], register: (ctx: unknown) => unknown) {
        const child = Object.create(ctx);
        if (services.includes('tools')) {
          child.tools = {
            register(tool: ToolDefinition) {
              tools.set(tool.name, tool);
            },
          };
        }
        if (services.includes('commands')) child.commands = { register: () => () => {} };
        if (services.includes('skills')) {
          child.skills = {
            get: async (name: string) => (candidate?.name === name ? provider?.get(candidate, {}) : undefined),
            registerProvider: ctx.skills.registerProvider,
          };
        }
        if (services.includes('systemPrompt')) child.systemPrompt = { section: () => () => {} };
        pending.push(Promise.resolve(register(child)));
      },
      skills: {
        registerProvider(create: (control: { signal: AbortSignal; invalidate: () => void }) => typeof provider) {
          provider = create({ signal: new AbortController().signal, invalidate() {} });
          return () => {};
        },
      },
    };
    apply(ctx, { preferPro: true, previewPort: 0 });
    await Promise.all(pending);
    if (!provider) throw new Error('Packaged Skill provider was not registered');
    const candidates = await provider.list({});
    if (!Array.isArray(candidates)) throw new Error('Expected a complete packaged Lite catalog');
    expect(candidates).toHaveLength(1);
    candidate = candidates[0];
    if (!candidate) throw new Error('Packaged Lite candidate is missing');
    expect(candidate.name).toBe('oil-ui');
    const skill = await provider.get(candidate, {});
    if (!skill) throw new Error('Packaged Lite Skill could not be loaded');
    expect(skill.name).toBe('oil-ui');
    expect(skill.resourceBase).toEqual({ kind: 'directory', path: join(unpack, 'package/skills/oil-ui') });
    const packagedSkillMarkdown = await readFile(join(unpack, 'package/skills/oil-ui/SKILL.md'), 'utf8');
    expect(skill.content).toBe(packagedSkillMarkdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''));

    const cwd = join(root, 'workspace');
    await mkdir(join(cwd, 'explore'), { recursive: true });
    for (const name of ['a', 'b', 'c']) {
      await writeFile(join(cwd, `explore/${name}.html`), `<title>${name}</title><main>Direction ${name}</main>`);
    }
    const run = {
      agent: { session: { id: 'package-smoke', header: { cwd } } },
      signal: new AbortController().signal,
    } as unknown as ToolRunContext;
    expect(await tools.get('oil_ui_skill_status')!.execute({}, run)).toMatchObject({
      edition: 'lite',
      activeSkillName: 'oil-ui',
      bundledVersion: bundledManifest.version,
      manifestPath: join(unpack, 'package/skills/oil-ui.manifest.json'),
      visibleMatchesOriginal: true,
    });
    expect(await tools.get('oil_ui_explorer')!.execute({ out: 'style-explorer.html' }, run)).toMatchObject({
      ok: true,
    });
    expect(
      await tools
        .get('oil_ui_shoot')!
        .execute({ target: 'style-explorer.html', out: 'shots/explorer.png', dryRun: true }, run),
    ).toMatchObject({ ok: true, outputFiles: [] });

    // Installing a raw Pro does not turn the packaged Lite provider into a second Pro publisher.
    const proDir = join(root, '.dsh/skills/oil-ui-pro');
    await mkdir(join(proDir, 'references'), { recursive: true });
    await mkdir(join(proDir, 'adapters/dsh'), { recursive: true });
    await writeFile(join(proDir, 'adapters/dsh/adapter.json'), '{ stale adapter residue');
    await writeFile(
      join(proDir, 'SKILL.md'),
      '---\nname: oil-ui-pro\ndescription: Packaged Pro\nmetadata:\n  version: "0.29.1"\n---\nUse `scripts/shoot.mjs`\n',
    );
    await writeFile(join(proDir, 'references/tools.md'), '# 工具\n`node scripts/shoot.mjs index.html`\n');
    const proCandidates = await provider.list({});
    if (!Array.isArray(proCandidates)) throw new Error('Expected a complete packaged Lite catalog');
    expect(proCandidates).toHaveLength(1);
    candidate = proCandidates[0];
    expect(candidate?.name).toBe('oil-ui');
    expect(await tools.get('oil_ui_skill_status')!.execute({}, run)).toMatchObject({
      edition: 'lite',
      activeSkillName: 'oil-ui',
      activeVersion: bundledManifest.version,
      bundledVersion: bundledManifest.version,
      manifestPath: join(unpack, 'package/skills/oil-ui.manifest.json'),
      proInstalled: true,
      nativeSkillReady: true,
      skillLoadState: 'ready',
      visibleMatchesOriginal: true,
    });
  } finally {
    await Promise.all(disposers.map((dispose) => dispose()));
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    isolatedHome.path = '';
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
