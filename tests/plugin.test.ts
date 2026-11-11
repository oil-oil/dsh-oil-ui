import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import SkillRegistry, { type SkillCandidate, type SkillRegistration } from '@deepseek-ai/dsh-skill';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { apply } from '../src/index.ts';
import { skillStatus, loadSkillDirectory, loadUpstreamSkill, skillDirectory } from '../src/skill/upstream.ts';

const localHome = vi.hoisted(() => ({ path: '' }));
function nextPatchVersion(version: string) {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return `${major}.${minor}.${patch + 1}`;
}

vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return {
    ...os,
    homedir: () => {
      if (!localHome.path) throw new Error('Test HOME must be isolated');
      return localHome.path;
    },
  };
});

let isolatedHome = '';
beforeEach(async () => {
  isolatedHome = await mkdtemp(join(tmpdir(), 'oil-plugin-home-'));
  localHome.path = isolatedHome;
  vi.stubEnv('OIL_NO_UPDATE_CHECK', '1');
  vi.stubEnv('OIL_TOKEN', 'test-oil-token');
  vi.stubEnv('OIL_API', '');
  vi.stubEnv('OIL_UI_IMAGE_GEN_SCRIPT', '');
  vi.stubEnv('DSH_HOME', join(isolatedHome, '.dsh'));
  vi.stubEnv('DSH_AGENTS_HOME', '');
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('OIL_UI_PRO_DIR', '');
  vi.stubEnv('XDG_CONFIG_HOME', join(isolatedHome, '.config'));
  vi.stubEnv('XDG_STATE_HOME', join(isolatedHome, '.local/state'));
  vi.stubEnv('APPDATA', join(isolatedHome, 'AppData/Roaming'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/credits')) return Response.json({ balance: 42 });
      throw new Error(`Unexpected test fetch: ${url}`);
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localHome.path = '';
  await rm(isolatedHome, { recursive: true, force: true });
});

it('declares agents before accessing it in the system-prompt injection', () => {
  const sections: string[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  const list = vi.fn(() => []);
  const ctx = {
    effect(register: () => () => void | Promise<void>) {
      disposers.push(register());
    },
    inject(services: string[], register: (ctx: unknown) => unknown) {
      if (!services.includes('systemPrompt')) return;
      register(
        new Proxy(
          {
            ...ctx,
            systemPrompt: {
              section: ({ name }: { name: string }) => {
                sections.push(name);
                return () => {};
              },
            },
            agents: { list },
          },
          {
            get(target, property, receiver) {
              if ((property === 'agents' || property === 'systemPrompt') && !services.includes(property)) {
                throw new Error(`cannot get property "${property}" without inject`);
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
      );
    },
    on() {
      return () => {};
    },
  };
  try {
    expect(() => apply(ctx as unknown as Context, { previewPort: 0, preferPro: false })).not.toThrow();
    expect(sections).toEqual(['oil-ui']);
    expect(list).toHaveBeenCalledOnce();
  } finally {
    for (const dispose of disposers) void dispose();
  }
});

it('presents all five tools with native call views and declares explorer/image deliverable paths', async () => {
  const tools = new Map<string, ToolDefinition>();
  const disposers: (() => void | Promise<void>)[] = [];
  const ctx = {
    effect(fn: () => () => void | Promise<void>) {
      disposers.push(fn());
    },
    inject(services: string[], fn: (value: unknown) => unknown) {
      if (services.includes('tools')) fn(ctx);
    },
    tools: {
      register(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
    },
  };
  try {
    apply(ctx as unknown as Context, { previewPort: 0, preferPro: false });
    expect(tools.size).toBe(5);
    for (const tool of tools.values()) expect(tool.presentCall).toBeTypeOf('function');
    const present = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.presentCall!(args);

    // Generic edit locations are the host's producedPaths contract for deliverable links.
    expect(present('oil_ui_explorer')).toEqual({
      card: 'generic',
      title: '生成风格对比页',
      kind: 'edit',
      locations: [{ path: 'style-explorer.html' }],
    });
    expect(present('oil_ui_explorer', { out: 'review/comparison.html' })).toMatchObject({
      card: 'generic',
      kind: 'edit',
      locations: [{ path: 'review/comparison.html' }],
    });
    expect(present('oil_ui_image', { prompt: 'A ceramic vase' })).toEqual({
      card: 'generic',
      title: '生成图片',
      kind: 'edit',
      locations: [{ path: 'assets/generated.png' }],
    });
    expect(
      present('oil_ui_image', {
        prompt: 'Change the color',
        images: ['assets/source.png'],
        out: 'assets/variant.webp',
      }),
    ).toEqual({
      card: 'generic',
      title: '编辑图片',
      kind: 'edit',
      locations: [{ path: 'assets/variant.webp' }],
    });
    expect(present('oil_ui_image', { prompt: 'Generate', mode: 'generate', images: ['source.png'] })?.title).toBe(
      '生成图片',
    );
    expect(present('oil_ui_shoot')).toEqual({
      card: 'generic',
      title: '截图与交互取证',
      kind: 'execute',
      locations: [{ path: 'index.html' }],
    });
    expect(present('oil_ui_shoot', { target: 'explore/a.html', out: 'shots/a.png' })).toMatchObject({
      card: 'generic',
      kind: 'execute',
      locations: [{ path: 'explore/a.html' }, { path: 'shots/a.png' }],
    });
    expect(present('oil_ui_media', { query: 'wood' })).toEqual({
      card: 'generic',
      title: '搜索并下载素材',
      kind: 'fetch',
      locations: [{ path: 'assets/media' }],
    });
    expect(present('oil_ui_media', { action: 'search', query: 'wood', dir: 'candidates' })).toEqual({
      card: 'generic',
      title: '搜索素材',
      kind: 'search',
      locations: [{ path: 'candidates' }],
    });
    expect(present('oil_ui_media', { action: 'preview', refs: ['T1'], out: 'shots/candidates.png' })).toEqual({
      card: 'generic',
      title: '预览素材候选',
      kind: 'read',
      locations: [{ path: 'shots/candidates.png' }],
    });
    expect(present('oil_ui_media', { refs: ['T1'], dir: 'assets', out: 'assets/wood.jpg' })).toEqual({
      card: 'generic',
      title: '下载素材',
      kind: 'fetch',
      locations: [{ path: 'assets/wood.jpg' }],
    });
    expect(present('oil_ui_skill_status')).toEqual({ card: 'generic', title: '查看 Oil UI Skill 状态', kind: 'read' });
    expect(present('oil_ui_skill_status', { update: true })).toEqual({
      card: 'generic',
      title: '更新 Oil UI Skill',
      kind: 'read',
    });

    // Replay may contain malformed/older arguments; defineTool must degrade safely.
    expect(present('oil_ui_explorer', { out: 123 })).toBeUndefined();
    expect(present('oil_ui_image', {})).toBeUndefined();
  } finally {
    await Promise.all(disposers.map((dispose) => dispose()));
  }
});

it('does not publish the bundled Lite when configured for filesystem-only Skill discovery', async () => {
  const skills = {
    register: vi.fn(),
    registerProvider: vi.fn(),
    get: vi.fn(async () => undefined),
  };
  const pending: Promise<unknown>[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  const ctx: any = {
    effect(register: () => () => void | Promise<void>) {
      disposers.push(register());
    },
    on() {
      return () => {};
    },
    inject(services: string[], register: (ctx: unknown) => unknown) {
      const child = Object.create(ctx);
      if (services.includes('skills')) child.skills = skills;
      if (services.includes('tools')) child.tools = { register: () => {} };
      if (services.includes('commands')) child.commands = { register: () => () => {} };
      if (services.includes('systemPrompt')) child.systemPrompt = { section: () => () => {} };
      pending.push(Promise.resolve(register(child)));
    },
  };
  try {
    apply(ctx as Context, { previewPort: 0, preferPro: false, bundledSkill: false });
    await Promise.all(pending);
    expect(skills.registerProvider).not.toHaveBeenCalled();
    expect(skills.register).not.toHaveBeenCalled();
  } finally {
    await Promise.all(disposers.map((dispose) => dispose()));
  }
});

it('registers 5 native Harness tools, validates their schemas and operates directly in session cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oil-plugin-'));
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<
    string,
    {
      name: string;
      handler: (inv: unknown) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string };
    }
  >();
  const pending: Promise<unknown>[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  let registration: SkillRegistration | undefined;
  let prompt = '';
  const ctx = {
    effect(fn: () => () => void | Promise<void>) {
      disposers.push(fn());
    },
    inject(_services: string[], fn: (ctx: unknown) => unknown) {
      pending.push(Promise.resolve(fn(ctx)));
    },
    tools: {
      register(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
    },
    commands: {
      register(cmd: {
        name: string;
        handler: (inv: unknown) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string };
      }) {
        commands.set(cmd.name, cmd);
        return () => {
          commands.delete(cmd.name);
        };
      },
    },
    skills: {
      register(skill: SkillRegistration) {
        registration = skill;
      },
      get: async () => registration,
    },
    systemPrompt: {
      section(section: { text: string }) {
        prompt = section.text;
      },
    },
  };
  const followupMessages: unknown[] = [];
  const exec = {
    agent: {
      session: { id: 'alice', header: { cwd: root } },
      followup(msg: unknown) {
        followupMessages.push(msg);
      },
    },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
  const run = async (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, exec);
  try {
    apply(ctx as unknown as Context, { previewPort: 0, preferPro: false });
    await Promise.all(pending);
    expect([...tools.keys()].sort()).toEqual(
      ['oil_ui_explorer', 'oil_ui_image', 'oil_ui_media', 'oil_ui_shoot', 'oil_ui_skill_status'].sort(),
    );
    expect([...commands.keys()].sort()).toEqual(['oil-ui-explore', 'oil-ui-review', 'oil-ui-status']);
    const statusCmd = await commands.get('oil-ui-status')!.handler({
      agent: exec.agent,
      rawInput: '',
      attachments: [],
      signal: exec.signal,
    });
    expect(statusCmd).toMatchObject({ kind: 'success' });
    expect(statusCmd.text).toContain('模型可见 Skill：oil-ui（Lite）');
    const exploreCmd = await commands.get('oil-ui-explore')!.handler({
      agent: exec.agent,
      rawInput: ' Hero landing page',
      attachments: [],
      signal: exec.signal,
    });
    expect(exploreCmd).toMatchObject({ kind: 'success' });
    expect(followupMessages).toHaveLength(1);
    expect(registration?.name).toBe('oil-ui');
    expect(prompt).toContain('Use this host status tool instead of running check_update.sh or check_update.py');
    expect(prompt).toContain('When skillReady is true, load activeSkillName');
    expect(prompt).toContain('Bundled Skill updates require updating the plugin');
    expect(prompt).not.toContain('nativeSkillReady');
    expect(prompt).not.toContain('ADAPTER.md');
    expect(prompt).not.toContain('shoot.mjs');
    expect(await run('oil_ui_skill_status', {})).toMatchObject({
      edition: 'lite',
      activeSkillName: 'oil-ui',
      visibleMatchesOriginal: true,
      imageSource: 'oiloil',
      oilBalance: 42,
    });
    expect(tools.get('oil_ui_skill_status')!.isConcurrencySafe?.({})).toBe(true);
    expect(tools.get('oil_ui_media')!.isConcurrencySafe?.({ action: 'search', query: 'ceramic' })).toBe(true);
    expect(
      tools.get('oil_ui_media')!.isConcurrencySafe?.({ action: 'search', query: 'ceramic', out: 'res.json' }),
    ).toBe(false);
    expect(tools.get('oil_ui_media')!.isConcurrencySafe?.({ action: 'fetch', refs: '1,2' })).toBe(false);
    for (const name of ['oil_ui_explorer', 'oil_ui_shoot', 'oil_ui_image']) {
      expect(tools.get(name)!.isConcurrencySafe?.({}) ?? false).toBe(false);
    }

    for (const tool of tools.values()) {
      for (const field of Object.values(tool.parameters.properties ?? {})) {
        expect(field.description).toMatch(/[\u4e00-\u9fff]/);
      }
    }
    expect(tools.get('oil_ui_image')!.parameters.properties).not.toHaveProperty('quality');
    expect(tools.get('oil_ui_image')!.description).not.toMatch(/quality|画质|图片生成质量/i);
    for (const [name, args] of [
      ['oil_ui_shoot', { states: { invalid: true } }],
      ['oil_ui_shoot', { stitch: [{ label: 'missing path' }] }],
      ['oil_ui_shoot', { record: {} }],
      ['oil_ui_media', { refs: [1] }],
      ['oil_ui_media', { maps: false }],
      ['oil_ui_explorer', { manifest: [] }],
    ] as const)
      await expect(run(name, args)).rejects.toThrow();

    await expect(run('oil_ui_image', {})).rejects.toThrow();
    await expect(run('oil_ui_image', { prompt: '' })).rejects.toThrow('prompt');

    await mkdir(join(root, 'explore'), { recursive: true });
    for (const direction of ['a', 'b', 'c']) {
      await writeFile(join(root, `explore/${direction}.html`), `<title>${direction}</title>`);
    }
    expect(await run('oil_ui_explorer', { title: 'Native explorer', request: 'Compare designs' })).toMatchObject({
      ok: true,
      explorerPath: 'style-explorer.html',
    });

    await expect(run('oil_ui_shoot', { viewport: 'invalid' })).rejects.toThrow('viewport');
    await expect(run('oil_ui_media', { query: '' })).rejects.toThrow('query');
    await expect(run('oil_ui_media', {})).rejects.toThrow('query');
    await expect(tools.get('oil_ui_explorer')!.execute({}, { signal: exec.signal } as ToolRunContext)).rejects.toThrow(
      'session-owned',
    );
  } finally {
    await Promise.all(disposers.map((dispose) => dispose()));
    await rm(root, { recursive: true, force: true });
  }
});

it('reads the injected registry and reports the filesystem Pro as ready from its original body', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-injected-context-')));
  localHome.path = root;
  vi.stubEnv('DSH_HOME', join(root, '.dsh'));
  vi.stubEnv('OIL_UI_PRO_DIR', '');
  const proDir = join(root, '.dsh/skills/oil-ui-pro');
  await mkdir(join(proDir, 'references'), { recursive: true });
  await writeFile(
    join(proDir, 'SKILL.md'),
    '---\nname: oil-ui-pro\ndescription: Pro\nmetadata:\n  version: 9.9.9\n---\nPro keeps `--frames` unchanged.',
  );
  await writeFile(
    join(proDir, 'references/reviewer-manual.md'),
    '# 视觉与交互评审手册 (Pro Injected Context)\nUse `--frames 3` verbatim.\n',
  );
  const disposers: (() => void | Promise<void>)[] = [];
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<
    string,
    {
      name: string;
      handler: (inv: unknown) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string };
    }
  >();
  const createdListeners: ((payload: { agent: unknown }) => Promise<void> | void)[] = [];
  const pending: Promise<unknown>[] = [];
  let registration: SkillRegistration | undefined;
  const ctx: any = {
    effect(fn: () => () => void | Promise<void>) {
      disposers.push(fn());
    },
    on(event: string, listener: (payload: { agent: unknown }) => Promise<void> | void) {
      if (event === 'agent/created') createdListeners.push(listener);
      return () => {};
    },
    inject(services: string[], fn: (ctx: unknown) => unknown) {
      const child = Object.create(ctx);
      if (services.includes('tools')) {
        Object.defineProperty(child, 'tools', {
          value: {
            register(tool: ToolDefinition) {
              tools.set(tool.name, tool);
            },
          },
        });
      }
      if (services.includes('commands')) {
        Object.defineProperty(child, 'commands', {
          value: {
            register(cmd: {
              name: string;
              handler: (inv: unknown) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string };
            }) {
              commands.set(cmd.name, cmd);
              return () => {};
            },
          },
        });
      }
      if (services.includes('skills')) {
        Object.defineProperty(child, 'skills', {
          value: {
            register(skill: SkillRegistration) {
              registration = skill;
            },
            get: async (name: string) =>
              name === 'oil-ui-pro'
                ? loadUpstreamSkill({ proSkillDir: proDir })
                : registration?.name === name
                  ? registration
                  : undefined,
          },
        });
      }
      if (services.includes('systemPrompt')) {
        Object.defineProperty(child, 'systemPrompt', {
          value: {
            section() {
              return () => {};
            },
          },
        });
      }
      pending.push(Promise.resolve(fn(child)));
    },
  };
  Object.defineProperty(ctx, 'skills', {
    get() {
      throw new Error('cannot get property "skills" without inject');
    },
  });
  try {
    apply(ctx as unknown as Context, { previewPort: 0, preferPro: true });
    await Promise.all(pending);
    const exec = {
      agent: { session: { id: 'alice', header: { cwd: root } } },
      signal: new AbortController().signal,
    } as unknown as ToolRunContext;
    await expect(tools.get('oil_ui_skill_status')!.execute({}, exec)).resolves.toMatchObject({
      activeSkillName: 'oil-ui-pro',
      edition: 'pro',
      skillReady: true,
      nativeSkillReady: true,
      skillLoadState: 'ready',
      visibleMatchesOriginal: true,
    });
    await expect(
      commands.get('oil-ui-status')!.handler({
        agent: exec.agent,
        rawInput: '',
        attachments: [],
        signal: exec.signal,
      }),
    ).resolves.toMatchObject({
      kind: 'success',
      text: expect.stringContaining('模型可见 Skill：oil-ui-pro（Pro）v9.9.9'),
    });
    const subSections: { name: string; text: string }[] = [];
    for (const listener of createdListeners) {
      await listener({
        agent: {
          session: { id: 'sub-1', header: { cwd: root, origin: 'subagent' } },
          ctx: {
            systemPrompt: {
              section(sec: { name: string; text: string }) {
                subSections.push(sec);
                return () => {};
              },
            },
          },
        },
      });
    }
    await vi.waitFor(() => expect(subSections).toHaveLength(1), { timeout: 5000 });
    expect(subSections[0]!.text).toContain('Pro Injected Context');
  } finally {
    await Promise.all(disposers.map((dispose) => dispose()));
    localHome.path = '';
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes only Lite with preferPro enabled and recognizes the sole raw filesystem Pro publisher', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-provider-')));
  const pro = join(root, 'home/.agents/skills/oil-ui-pro');
  vi.stubEnv('DSH_HOME', join(root, 'home/.dsh'));
  localHome.path = join(root, 'home');
  const registry = new SkillRegistry(new Context());
  const tools = new Map<string, ToolDefinition>();
  const pending: Promise<unknown>[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  const ctx = {
    effect(fn: () => () => void | Promise<void>) {
      disposers.push(fn());
    },
    inject(_services: string[], fn: (ctx: unknown) => unknown) {
      pending.push(Promise.resolve(fn(ctx)));
    },
    tools: {
      register(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
    },
    skills: {
      register: vi.fn(),
      get: registry.get.bind(registry),
      registerProvider(create: Parameters<SkillRegistry['registerProvider']>[0]) {
        const dispose = registry.registerProvider(create);
        disposers.push(dispose);
        return dispose;
      },
    },
    systemPrompt: { section() {} },
  };
  try {
    apply(ctx as unknown as Context, { previewPort: 0, preferPro: true });
    await Promise.all(pending);
    await mkdir(join(pro, 'references'), { recursive: true });
    await writeFile(
      join(pro, 'SKILL.md'),
      '---\nname: oil-ui-pro\ndescription: Synthetic Pro\nmetadata:\n  version: fixture\n---\nRAW_FIXTURE_BODY',
    );
    await mkdir(join(pro, 'adapters/dsh'), { recursive: true });
    await writeFile(join(pro, 'adapters/dsh/adapter.json'), '{ invalid stale adapter residue');
    await writeFile(join(pro, 'references/tools.md'), '# Fixture tools');
    const exec = {
      agent: { session: { id: 'alice', header: { cwd: root } } },
      signal: new AbortController().signal,
    } as ToolRunContext;
    expect((await registry.list()).map((skill) => skill.name)).toEqual(['oil-ui']);
    expect(await registry.get('oil-ui-pro')).toBeUndefined();
    expect(await tools.get('oil_ui_skill_status')!.execute({}, exec)).toMatchObject({
      edition: 'lite',
      activeSkillName: 'oil-ui',
      proInstalled: true,
      nativeSkillReady: true,
      skillLoadState: 'ready',
      visibleMatchesOriginal: true,
    });
    disposers.push(
      registry.registerProvider(() => ({
        name: 'filesystem',
        async list() {
          return [
            {
              name: 'oil-ui-pro',
              description: 'Raw filesystem fixture',
              source: 'user-agents',
              provider: 'filesystem',
              rank: 500,
              locator: pro,
              path: join(pro, 'SKILL.md'),
              resourceBase: { kind: 'directory' as const, path: pro },
              invocation: { modelInvocable: true, userInvocable: true },
            },
          ];
        },
        async get(candidate) {
          return { ...candidate, content: 'RAW_FIXTURE_BODY', metadata: { version: 'fixture' } };
        },
      })),
    );
    expect(await tools.get('oil_ui_skill_status')!.execute({}, exec)).toMatchObject({
      edition: 'pro',
      activeSkillName: 'oil-ui-pro',
      effective: { provider: 'filesystem' },
      nativeSkillReady: true,
      skillLoadState: 'ready',
      visibleMatchesOriginal: true,
    });
    expect((await registry.list()).filter((skill) => skill.name === 'oil-ui-pro')).toHaveLength(1);
    expect(await tools.get('oil_ui_skill_status')!.execute({}, exec)).toMatchObject({
      activeSkillName: 'oil-ui-pro',
      effective: { provider: 'filesystem' },
      nativeSkillReady: true,
      skillLoadState: 'ready',
      skillLoadWarning: null,
    });
    expect(JSON.stringify(await tools.get('oil_ui_skill_status')!.execute({}, exec))).not.toMatch(
      /proAdapter|transformDiagnostics|transformWarning/,
    );
  } finally {
    await Promise.all(disposers.map((dispose) => dispose()));
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')(
  'updates the scoped filesystem Pro through the status tool and reloads the same winner',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-status-update-wiring-')));
    localHome.path = root;
    vi.stubEnv('OIL_TOKEN', '');
    vi.stubEnv('OIL_NO_UPDATE_CHECK', '0');
    const proDir = join(root, '.agents/skills/oil-ui-pro');
    const cwd = join(root, 'workspace');
    await mkdir(join(proDir, 'references'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(proDir, 'SKILL.md'),
      "---\nname: oil-ui-pro\ndescription: Synthetic filesystem Pro\nmetadata:\n  version: '1.0.0'\n---\nRaw Pro keeps `--frames` unchanged.\n",
    );
    await writeFile(join(proDir, 'references/tools.md'), '# Synthetic filesystem tools\n');

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
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const executable = join(bin, 'npx');
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} "$@"\n`);
    await chmod(executable, 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);

    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/store/versions')) {
        return Response.json({ skills: { 'oil-ui-pro': { latest: '1.1.0' } } });
      }
      throw new Error(`Unexpected fixture fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    const registry = new SkillRegistry(new Context());
    const disposers: (() => void | Promise<void>)[] = [];
    const lookups: { name: string; scope: unknown; cwd?: string }[] = [];
    const listedVersions: string[] = [];
    const tools = new Map<string, ToolDefinition>();
    const pending: Promise<unknown>[] = [];
    const skills = {
      async get(name: string, options: { scope?: unknown; cwd?: string } = {}) {
        lookups.push({ name, scope: options.scope, cwd: options.cwd });
        return registry.get(name, options as never);
      },
      register(skill: SkillRegistration) {
        return registry.register(skill);
      },
      registerProvider(create: Parameters<SkillRegistry['registerProvider']>[0]) {
        const dispose = registry.registerProvider(create);
        disposers.push(dispose);
        return dispose;
      },
    };
    disposers.push(
      registry.registerProvider(() => ({
        name: 'filesystem',
        async list() {
          const loaded = await loadUpstreamSkill({ proSkillDir: proDir });
          const version = String(loaded.metadata?.version ?? 'unknown');
          listedVersions.push(version);
          const candidate: SkillCandidate = {
            name: loaded.name,
            description: loaded.description,
            provider: 'filesystem',
            source: 'user-agents',
            path: loaded.path,
            resourceBase: { kind: 'directory', path: proDir },
            invocation: { modelInvocable: true, userInvocable: true },
            metadata: loaded.metadata,
            rank: 1,
            locator: proDir,
          };
          return [candidate];
        },
        async get(candidate) {
          if (candidate.name !== 'oil-ui-pro') return undefined;
          const loaded = await loadUpstreamSkill({ proSkillDir: proDir });
          return {
            ...loaded,
            provider: 'filesystem',
            source: 'user-agents',
            invocation: { modelInvocable: true, userInvocable: true },
          };
        },
      })),
    );

    const ctx: any = {
      effect(register: () => () => void | Promise<void>) {
        disposers.push(register());
      },
      inject(services: string[], register: (ctx: unknown) => unknown) {
        const child = Object.create(ctx);
        if (services.includes('skills')) child.skills = skills;
        if (services.includes('tools')) {
          child.tools = {
            register(tool: ToolDefinition) {
              tools.set(tool.name, tool);
            },
          };
        }
        if (services.includes('commands')) child.commands = { register: () => () => {} };
        if (services.includes('systemPrompt')) child.systemPrompt = { section: () => () => {} };
        pending.push(Promise.resolve(register(child)));
      },
    };
    const agent = { session: { id: 'status-update', header: { cwd } } };
    const run = { agent, signal: new AbortController().signal } as unknown as ToolRunContext;
    try {
      apply(ctx as Context, { previewPort: 0, preferPro: true, proSkillDir: proDir });
      await Promise.all(pending);
      const statusTool = tools.get('oil_ui_skill_status');
      expect(statusTool).toBeDefined();
      const status = await statusTool!.execute({ update: true }, run);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await readFile(join(proDir, 'SKILL.md'), 'utf8')).toContain("version: '1.1.0'");
      expect(listedVersions).toEqual(expect.arrayContaining(['1.0.0', '1.1.0']));
      const proLookups = lookups.filter((entry) => entry.name === 'oil-ui-pro');
      expect(proLookups.length).toBeGreaterThanOrEqual(2);
      expect(proLookups.slice(-2)).toEqual([
        { name: 'oil-ui-pro', scope: agent, cwd },
        { name: 'oil-ui-pro', scope: agent, cwd },
      ]);
      expect(status).toMatchObject({
        updated: true,
        latestVersion: '1.1.0',
        edition: 'pro',
        activeSkillName: 'oil-ui-pro',
        activeVersion: '1.1.0',
        detected: { name: 'oil-ui-pro', edition: 'pro', version: '1.1.0' },
        effective: {
          name: 'oil-ui-pro',
          version: '1.1.0',
          provider: 'filesystem',
          path: join(proDir, 'SKILL.md'),
          resourceBase: { kind: 'directory', path: proDir },
        },
        proSourcePath: proDir,
        activeResourceBase: proDir,
        nativeSkillReady: true,
        visibleMatchesOriginal: true,
        skillLoadState: 'ready',
      });
    } finally {
      await Promise.all(disposers.map((dispose) => dispose()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'updates filesystem Lite and refreshes the winner in the same agent scope and cwd',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-status-update-lite-wiring-')));
    localHome.path = root;
    vi.stubEnv('OIL_TOKEN', '');
    vi.stubEnv('OIL_NO_UPDATE_CHECK', '0');
    const liteDir = join(root, '.agents/skills/oil-ui');
    const cwd = join(root, 'workspace');
    const rawBody = 'Filesystem Lite keeps `--frames` and `scripts/shoot.mjs` unchanged.\n';
    await mkdir(liteDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(liteDir, 'SKILL.md'),
      `---\nname: oil-ui\ndescription: Synthetic filesystem Lite\nmetadata:\n  version: '1.0.0'\n---\n${rawBody}`,
    );

    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    const runner = join(root, 'fake-npx.cjs');
    const updateLog = join(root, 'update-args.json');
    await writeFile(
      runner,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const args = process.argv.slice(2);',
        "const pathIndex = args.indexOf('--path');",
        "if (pathIndex < 0 || !args[pathIndex + 1]) throw new Error('Missing --path fixture argument');",
        `fs.writeFileSync(${JSON.stringify(updateLog)}, JSON.stringify(args));`,
        "const skillPath = path.join(args[pathIndex + 1], 'SKILL.md');",
        "const current = fs.readFileSync(skillPath, 'utf8');",
        'const updated = current.replace("version: \'1.0.0\'", "version: \'1.1.0\'");',
        "if (updated === current) throw new Error('Fixture Lite version was not 1.0.0');",
        'fs.writeFileSync(skillPath, updated);',
      ].join('\n'),
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const executable = join(bin, 'npx');
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} "$@"\n`);
    await chmod(executable, 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);

    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/store/versions')) return Response.json({ skills: { 'oil-ui': { latest: '1.1.0' } } });
      throw new Error(`Unexpected fixture fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    const registry = new SkillRegistry(new Context());
    const disposers: (() => void | Promise<void>)[] = [];
    const lookups: { name: string; scope: unknown; cwd?: string }[] = [];
    const tools = new Map<string, ToolDefinition>();
    const pending: Promise<unknown>[] = [];
    const skills = {
      async get(name: string, options: { scope?: unknown; cwd?: string } = {}) {
        lookups.push({ name, scope: options.scope, cwd: options.cwd });
        if (name === 'oil-ui') {
          return {
            ...(await loadSkillDirectory(liteDir, 'oil-ui', 'filesystem')),
            provider: 'filesystem',
          };
        }
        return registry.get(name, options as never);
      },
      register(skill: SkillRegistration) {
        return registry.register(skill);
      },
      registerProvider(create: Parameters<SkillRegistry['registerProvider']>[0]) {
        const dispose = registry.registerProvider(create);
        disposers.push(dispose);
        return dispose;
      },
    };
    disposers.push(
      registry.registerProvider(() => ({
        name: 'filesystem',
        async list() {
          const loaded = await loadSkillDirectory(liteDir, 'oil-ui', 'filesystem');
          const candidate: SkillCandidate = {
            ...loaded,
            source: 'user-agents',
            provider: 'filesystem',
            invocation: loaded.invocation!,
            rank: 10000,
            locator: liteDir,
          };
          return [candidate];
        },
        async get(candidate) {
          if (candidate.name !== 'oil-ui') return undefined;
          return {
            ...(await loadSkillDirectory(liteDir, 'oil-ui', 'filesystem')),
            provider: 'filesystem',
            source: 'user-agents',
            invocation: { modelInvocable: true, userInvocable: true },
          };
        },
      })),
    );
    const ctx: any = {
      effect(register: () => () => void | Promise<void>) {
        disposers.push(register());
      },
      inject(services: string[], register: (ctx: unknown) => unknown) {
        const child = Object.create(ctx);
        if (services.includes('skills')) child.skills = skills;
        if (services.includes('tools')) {
          child.tools = {
            register(tool: ToolDefinition) {
              tools.set(tool.name, tool);
            },
          };
        }
        if (services.includes('commands')) child.commands = { register: () => () => {} };
        if (services.includes('systemPrompt')) child.systemPrompt = { section: () => () => {} };
        pending.push(Promise.resolve(register(child)));
      },
    };
    const agent = { session: { id: 'status-update-lite', header: { cwd } } };
    const run = { agent, signal: new AbortController().signal } as unknown as ToolRunContext;
    try {
      apply(ctx as Context, { previewPort: 0, preferPro: false });
      await Promise.all(pending);
      const statusTool = tools.get('oil_ui_skill_status');
      expect(statusTool).toBeDefined();
      const status = await statusTool!.execute({ update: true }, run);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await readFile(join(liteDir, 'SKILL.md'), 'utf8')).toContain("version: '1.1.0'");
      expect(await readFile(join(liteDir, 'SKILL.md'), 'utf8')).toContain(rawBody);
      const liteLookups = lookups.filter((entry) => entry.name === 'oil-ui');
      expect(liteLookups.length).toBeGreaterThanOrEqual(2);
      expect(liteLookups.slice(-2)).toEqual([
        { name: 'oil-ui', scope: agent, cwd },
        { name: 'oil-ui', scope: agent, cwd },
      ]);
      const args = JSON.parse(await readFile(updateLog, 'utf8')) as string[];
      expect(args[args.indexOf('--path') + 1]).toBe(liteDir);
      expect(status).toMatchObject({
        updated: true,
        latestVersion: '1.1.0',
        edition: 'lite',
        activeSkillName: 'oil-ui',
        activeVersion: '1.1.0',
        effective: {
          name: 'oil-ui',
          version: '1.1.0',
          provider: 'filesystem',
          path: join(liteDir, 'SKILL.md'),
          resourceBase: { kind: 'directory', path: liteDir },
        },
        activeResourceBase: liteDir,
        nativeSkillReady: true,
        visibleMatchesOriginal: true,
        skillLoadState: 'ready',
      });
    } finally {
      await Promise.all(disposers.map((dispose) => dispose()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('reports cached update notices on lite edition without emitting a one-time Pro recommendation', async () => {
  vi.stubEnv('OIL_NO_UPDATE_CHECK', '0');
  const root = await mkdtemp(join(tmpdir(), 'dsh-oil-ui-update-notice-'));
  localHome.path = root;
  const stateDir = join(root, 'state');
  vi.stubEnv('XDG_STATE_HOME', stateDir);
  try {
    const manifest = JSON.parse(await readFile(join(skillDirectory, '../oil-ui.manifest.json'), 'utf8')) as {
      version: string;
    };
    const latestVersion = nextPatchVersion(manifest.version);
    await mkdir(join(stateDir, 'oil'), { recursive: true });
    await writeFile(
      join(stateDir, 'oil', 'oil-ui-update.json'),
      JSON.stringify({ checkedAt: Math.floor(Date.now() / 1000), latest: latestVersion }),
    );
    const first = await skillStatus(null, { preferPro: false });
    expect(first.edition).toBe('lite');
    expect(first.updateAvailable).toBe(true);
    expect(first.latestVersion).toBe(latestVersion);
    expect(first.updateNotice).toContain('Update available');
    expect('recommendOnceTriggered' in first).toBe(false);
    expect('recommendOnceNotice' in first).toBe(false);
    expect(existsSync(join(stateDir, 'oil-ui', 'recommended-oil-ui-pro'))).toBe(false);
  } finally {
    localHome.path = '';
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('injects the raw Pro reviewer manual for a native Pro and the Lite manual otherwise', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-oil-ui-subagent-')));
  const proDir = join(root, '.dsh/skills/oil-ui-pro');
  const rootCtx = new Context();
  new SystemPrompt(rootCtx, {});
  const createdListeners: ((payload: { agent: unknown }) => Promise<void> | void)[] = [];
  const pending: Promise<unknown>[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  let rawPro: SkillRegistration | undefined;
  const getSkill = vi.fn(async (name: string) => (name === 'oil-ui-pro' ? rawPro : undefined));

  const hostCtx = {
    skills: { get: getSkill, register() {} },
    systemPrompt: rootCtx.systemPrompt,
    agents: { list: () => [] },
    effect(fn: () => () => void | Promise<void>) {
      disposers.push(fn());
    },
    inject(services: string[], fn: (ctx: unknown) => unknown) {
      if (services.includes('systemPrompt') || (services.length === 1 && services[0] === 'skills')) {
        pending.push(Promise.resolve(fn(hostCtx)));
      }
    },
    on(event: string, listener: (payload: { agent: unknown }) => Promise<void> | void) {
      if (event === 'agent/created') createdListeners.push(listener);
      return () => {};
    },
  };

  try {
    apply(hostCtx as unknown as Context, { previewPort: 0, preferPro: true });
    await Promise.all(pending);

    const mainSections: { name: string; order: number; interpolate?: boolean; text: string }[] = [];
    const mainAgent = {
      id: 'main-1',
      session: { id: 'main-1', header: { cwd: root } },
      ctx: {
        systemPrompt: {
          section(sec: { name: string; order: number; interpolate?: boolean; text: string }) {
            mainSections.push(sec);
            return () => {};
          },
        },
      },
    };
    for (const listener of createdListeners) await listener({ agent: mainAgent });
    expect(mainSections).toHaveLength(0);
    const mainPrompt = renderPrompt(await rootCtx.systemPrompt.assemble({}));
    expect(mainPrompt).toContain('call oil_ui_skill_status first');
    expect(mainPrompt).not.toContain('视觉与交互评审手册');

    const subSections: { name: string; order: number; interpolate?: boolean; text: string }[] = [];
    const liteSubagent = {
      id: 'sub-lite',
      session: { id: 'sub-lite', header: { cwd: root, origin: 'subagent', parentSession: 'main-1' } },
      ctx: {
        systemPrompt: {
          section(sec: { name: string; order: number; interpolate?: boolean; text: string }) {
            subSections.push(sec);
            return () => {};
          },
        },
      },
    };
    for (const listener of createdListeners) await listener({ agent: liteSubagent });
    await vi.waitFor(() => expect(subSections).toHaveLength(1), { timeout: 5000 });
    expect(subSections[0]!.name).toBe('oil-ui-subagent-reviewer');
    expect(subSections[0]!.text).toContain(`${sep}references`);
    expect(subSections[0]!.text).toContain('ux-reviewer.md');
    expect(subSections[0]!.text).toContain('# 视觉与交互评审手册 (子 Agent 专用)');
    expect(subSections[0]!.text).toContain('oil_ui_shoot');
    expect(subSections[0]!.text).toContain('read_image');
    expect(subSections[0]!.text).not.toContain('call oil_ui_skill_status first');

    await mkdir(join(proDir, 'references'), { recursive: true });
    await writeFile(join(proDir, 'references/tools.md'), '# Synthetic Pro tools\n');
    await writeFile(
      join(proDir, 'SKILL.md'),
      '---\nname: oil-ui-pro\ndescription: Pro\nmetadata:\n  version: 9.9.9\n---\nPro body',
    );
    await writeFile(
      join(proDir, 'references/reviewer-manual.md'),
      '# 视觉与交互评审手册 (子 Agent 专用 - Pro 专属标识)\n能用截图工具时，用它出缩略图和遮字图。保留 `--frames 7`。',
    );
    rawPro = {
      name: 'oil-ui-pro',
      description: 'Synthetic filesystem Pro',
      content: 'Pro body',
      metadata: { version: '9.9.9' },
      provider: 'filesystem',
      source: 'user-dsh',
      path: join(proDir, 'SKILL.md'),
      resourceBase: { kind: 'directory', path: proDir },
    };
    const proSubSections: { name: string; order: number; interpolate?: boolean; text: string }[] = [];
    const proSubagent = {
      id: 'sub-pro',
      session: { id: 'sub-pro', header: { cwd: root, origin: 'subagent', parentSession: 'main-1' } },
      ctx: {
        systemPrompt: {
          section(sec: { name: string; order: number; interpolate?: boolean; text: string }) {
            proSubSections.push(sec);
            return () => {};
          },
        },
      },
    };
    for (const listener of createdListeners) await listener({ agent: proSubagent });
    await vi.waitFor(() => expect(proSubSections).toHaveLength(1), { timeout: 5000 });
    expect(getSkill).toHaveBeenCalledWith('oil-ui-pro', expect.objectContaining({ scope: proSubagent }));
    expect(proSubSections[0]!.text).toContain('Pro 专属标识');
    expect(proSubSections[0]!.text).toContain('`--frames 7`');
    expect(proSubSections[0]!.text).toContain(proDir);
    expect(proSubSections[0]!.text).toContain('oil_ui_shoot');
  } finally {
    await Promise.all(disposers.map((dispose) => dispose()));
    await rm(root, { recursive: true, force: true });
  }
});

it('never awaits reviewer setup, uses Lite without a visible Pro definition, and disposes only its own section', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-reviewer-fallback-')));
  const pro = join(root, 'pro');
  const disposers: (() => void | Promise<void>)[] = [];
  let listener: ((payload: { agent: unknown }) => unknown) | undefined;
  const inherited = 'Main Oil UI guidance';
  const sections = new Map([['oil-ui', inherited]]);
  const disposeReviewer = vi.fn();
  const agent = {
    session: { header: { cwd: root, origin: 'subagent' } },
    ctx: {
      systemPrompt: {
        section(section: { name: string; text: string }) {
          sections.set(section.name, section.text);
          return () => {
            sections.delete(section.name);
            disposeReviewer();
          };
        },
      },
    },
  };
  const ctx = {
    effect(fn: () => () => void | Promise<void>) {
      disposers.push(fn());
    },
    inject(services: string[], fn: (value: unknown) => unknown) {
      if (services.includes('systemPrompt')) fn(ctx);
    },
    systemPrompt: {
      section() {
        return () => {};
      },
    },
    on(_name: string, fn: typeof listener) {
      listener = fn;
    },
  };
  try {
    await mkdir(join(pro, 'references'), { recursive: true });
    await writeFile(join(pro, 'SKILL.md'), '---\nname: oil-ui-pro\ndescription: Test\n---\nTest');
    await writeFile(join(pro, 'references/tools.md'), 'node scripts/shoot.mjs <target>');
    await writeFile(join(pro, 'references/reviewer-manual.md'), '# PRO ONLY MANUAL\n');
    apply(ctx as unknown as Context, { previewPort: 0, preferPro: true, proSkillDir: pro });
    expect(listener!({ agent })).toBeUndefined();
    expect(listener!({ agent })).toBeUndefined();
    await vi.waitFor(() => expect(sections.get('oil-ui-subagent-reviewer')).toContain('# 视觉与交互评审手册'), {
      timeout: 5000,
    });
    expect(sections.get('oil-ui-subagent-reviewer')).not.toContain('PRO ONLY MANUAL');
    expect(sections.get('oil-ui')).toBe(inherited);
    expect(sections.size).toBe(2);
    await Promise.all(disposers.map((dispose) => dispose()));
    expect(disposeReviewer).toHaveBeenCalledTimes(1);
    expect(sections.get('oil-ui')).toBe(inherited);
    expect(sections.size).toBe(1);
    expect(listener!({ agent })).toBeUndefined();
  } finally {
    await Promise.all(disposers.map((dispose) => dispose()));
    await rm(root, { recursive: true, force: true });
  }
});
