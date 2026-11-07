import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry, { type SkillCandidate } from '@deepseek-ai/dsh-skill';
import { createScope } from '@deepseek-ai/dsh-scope';
import { createSkillProvider, loadUpstreamSkill, skillStatus } from '../src/skill/upstream.ts';

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
  root = await realpath(await mkdtemp(join(tmpdir(), 'oil-provider-ownership-')));
  fixture.home = root;
  for (const [key, value] of Object.entries({
    DSH_HOME: join(root, '.dsh'),
    DSH_AGENTS_HOME: '',
    CODEX_HOME: '',
    OIL_UI_PRO_DIR: '',
    OIL_UI_IMAGE_GEN_SCRIPT: '',
    OIL_TOKEN: '',
    OIL_API: '',
    OIL_NO_UPDATE_CHECK: '1',
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_STATE_HOME: join(root, '.local/state'),
    APPDATA: join(root, 'AppData/Roaming'),
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected fixture network request');
    }),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fixture.home = '';
  await rm(root, { recursive: true, force: true });
});

async function writeRawPro(directory: string, version: string, body: string) {
  await mkdir(join(directory, 'references'), { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: oil-ui-pro\ndescription: Synthetic filesystem Pro\nmetadata:\n  version: '${version}'\n---\n${body}`,
  );
  await writeFile(join(directory, 'references/tools.md'), '# Synthetic host tools\n');
  return directory;
}

it.each(['host', 'preset', 'agent'])(
  'keeps one raw filesystem Pro publisher at %s level and checks the winner itself',
  async (level) => {
    const directory = await writeRawPro(
      join(root, '.agents/skills/oil-ui-pro'),
      '0.33.0',
      'RAW_FIXTURE_ACTION\nUse --frames unchanged.\n',
    );
    const preferred = await writeRawPro(
      join(root, 'preferred/oil-ui-pro'),
      '0.34.0',
      'Different preferred local Pro.\n',
    );
    const sameContentOtherPath = await writeRawPro(
      join(root, 'other/oil-ui-pro'),
      '0.33.0',
      'RAW_FIXTURE_ACTION\nUse --frames unchanged.\n',
    );
    const host = new Context();
    new SkillRegistry(host);
    const presetKey = {};
    const agent = {};
    const preset = createScope(host, presetKey);
    const own = createScope(host, agent, { parent: presetKey });
    const filesystemContext = level === 'host' ? host : level === 'preset' ? preset.ctx : own.ctx;
    const candidate: SkillCandidate = {
      name: 'oil-ui-pro',
      description: 'Filesystem fixture',
      provider: 'filesystem',
      source: 'user-agents',
      path: join(directory, 'SKILL.md'),
      resourceBase: { kind: 'directory', path: directory },
      metadata: { version: '0.33.0' },
      invocation: { modelInvocable: true, userInvocable: true },
      rank: 10000,
      locator: directory,
    };
    const disposers: (() => void | Promise<void>)[] = [];
    try {
      // Even an explicit Pro preference cannot make the plugin a second publisher.
      disposers.push(
        host.skills.registerProvider((control) =>
          createSkillProvider({ preferPro: true, proSkillDir: preferred }, control),
        ),
      );
      disposers.push(
        filesystemContext.skills.registerProvider(() => ({
          name: 'filesystem',
          list: async () => [candidate],
          get: async (selected) => {
            if (selected.name !== 'oil-ui-pro') return undefined;
            const loaded = await loadUpstreamSkill({ proSkillDir: directory });
            return { ...loaded, provider: 'filesystem', invocation: candidate.invocation! };
          },
        })),
      );

      const lookup = { scope: agent, cwd: root };
      const catalog = await host.skills.list(lookup);
      expect(catalog.filter((skill) => skill.name === 'oil-ui-pro')).toHaveLength(1);
      expect(catalog.filter((skill) => skill.name === 'oil-ui')).toHaveLength(1);
      const visible = await host.skills.get('oil-ui-pro', lookup);
      expect(visible).toMatchObject({
        name: 'oil-ui-pro',
        provider: 'filesystem',
        path: join(directory, 'SKILL.md'),
        resourceBase: { kind: 'directory', path: directory },
        metadata: { version: '0.33.0' },
        content: 'RAW_FIXTURE_ACTION\nUse --frames unchanged.\n',
      });

      // The filesystem winner remains authoritative even when local discovery
      // prefers a different Pro version and a different source directory.
      const options = { proSkillDir: preferred, cwd: root };
      const status = await skillStatus(visible, options);
      expect(status).toMatchObject({
        edition: 'pro',
        activeSkillName: 'oil-ui-pro',
        activeVersion: '0.33.0',
        detected: { name: 'oil-ui-pro', version: '0.34.0', path: join(preferred, 'SKILL.md') },
        effective: { name: 'oil-ui-pro', provider: 'filesystem', version: '0.33.0', path: join(directory, 'SKILL.md') },
        proSourcePath: directory,
        activeResourceBase: directory,
        skillReady: true,
        nativeSkillReady: true,
        visibleMatchesOriginal: true,
        skillLoadState: 'ready',
        skillLoadWarning: null,
      });

      expect(await skillStatus({ ...visible!, content: `${visible!.content}changed` }, options)).toMatchObject({
        nativeSkillReady: false,
        visibleMatchesOriginal: false,
        skillLoadState: 'overridden',
      });
      expect(await skillStatus({ ...visible!, metadata: { version: '0.0.1' } }, options)).toMatchObject({
        nativeSkillReady: false,
        visibleMatchesOriginal: false,
      });
      expect(
        await skillStatus({ ...visible!, resourceBase: { kind: 'directory', path: sameContentOtherPath } }, options),
      ).toMatchObject({ nativeSkillReady: false, visibleMatchesOriginal: false });
      expect(await skillStatus({ ...visible!, path: join(sameContentOtherPath, 'SKILL.md') }, options)).toMatchObject({
        nativeSkillReady: false,
        visibleMatchesOriginal: false,
      });
      expect(
        await skillStatus({ ...visible!, invocation: { modelInvocable: false, userInvocable: true } }, options),
      ).toMatchObject({ nativeSkillReady: false, skillLoadState: 'unavailable' });
    } finally {
      await Promise.all(disposers.map((dispose) => dispose()));
      await host.fiber.dispose();
    }
  },
);
