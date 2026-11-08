import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const upstreamCommit = 'ff3ed0a88972747840ece9d4cd664807d6f5d501';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oil-release-'));
  await mkdir(join(root, 'skills'), { recursive: true });
  await mkdir(join(root, 'skills/oil-ui'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'src/skill'), { recursive: true });
  await mkdir(join(root, 'scripts/lib'), { recursive: true });
  await cp(join(project, 'scripts/release-check.mjs'), join(root, 'scripts/release-check.mjs'));
  await cp(join(project, 'scripts/lib/skill-distribution.mjs'), join(root, 'scripts/lib/skill-distribution.mjs'));
  await cp(join(project, 'scripts/public-skill-files.mjs'), join(root, 'scripts/public-skill-files.mjs'));
  await cp(join(project, 'src/skill/install.ts'), join(root, 'src/skill/install.ts'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-oil-ui', version: '0.4.1-dev.0' }));
  await writeFile(
    join(root, 'skills/oil-ui.manifest.json'),
    JSON.stringify({
      name: 'oil-ui',
      version: '0.25.0',
      distribution: 'original',
      source: { repository: 'https://github.com/oil-oil/oil-ui', commit: upstreamCommit, release: 'v0.25.0' },
    }),
  );
  return root;
}

function isolatedChildEnv(root: string): NodeJS.ProcessEnv {
  const config = join(root, '.config');
  const cache = join(root, '.cache');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'AppData/Roaming'),
    DSH_HOME: join(root, '.dsh'),
    DSH_AGENTS_HOME: '',
    CODEX_HOME: '',
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: join(root, '.local/state'),
    XDG_CACHE_HOME: cache,
    NPM_CONFIG_USERCONFIG: join(config, 'npmrc'),
    npm_config_userconfig: join(config, 'npmrc'),
    NPM_CONFIG_CACHE: join(cache, 'npm'),
    npm_config_cache: join(cache, 'npm'),
    OIL_TOKEN: '',
    OIL_API: '',
    OIL_NO_UPDATE_CHECK: '1',
  };
  delete env.GITHUB_REF_NAME;
  delete env.GITHUB_REF;
  delete env.GITHUB_SHA;
  delete env.OIL_UI_SOURCE_RELEASE;
  return env;
}

it('verifies the release tag and writes traceable release notes', async () => {
  const root = await fixture();
  try {
    const script = join(root, 'scripts/release-check.mjs');
    const env = isolatedChildEnv(root);
    const result = await exec(process.execPath, [script, '--tag', 'v0.4.1-dev.0', '--notes', '.work/notes.md'], {
      cwd: root,
      env,
    });
    expect(result.stdout).toContain('plugin 0.4.1-dev.0, oil-ui 0.25.0');
    const notes = await readFile(join(root, '.work/notes.md'), 'utf8');
    expect(notes).toContain('Bundled oil-ui: 0.25.0');
    expect(notes).toContain(`commit/${upstreamCommit}`);

    await expect(exec(process.execPath, [script, '--tag', 'v0.4.0'], { cwd: root, env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('does not match package.json'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
