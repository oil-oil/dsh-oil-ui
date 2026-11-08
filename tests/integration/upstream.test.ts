import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../../', import.meta.url));
const liteSource = process.env.OIL_UI_SOURCE_DIR;

if (!liteSource) throw new Error('Set OIL_UI_SOURCE_DIR to a public oil-ui source tree for integration tests.');
const publicSource = resolve(liteSource);

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
    OIL_UI_SOURCE_DIR: '',
    OIL_UI_PRO_DIR: '',
    OIL_UI_IMAGE_GEN_SCRIPT: '',
  };
  delete env.OIL_UI_SOURCE_RELEASE;
  delete env.GITHUB_REF_NAME;
  delete env.GITHUB_REF;
  delete env.GITHUB_SHA;
  delete env.OIL_UI_SOURCE_COMMIT;
  return env;
}

it('syncs a temporary plugin clone from the explicit public source and verifies original bytes and pin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oil-public-integration-'));
  const clone = join(root, 'plugin');
  const source = publicSource;
  try {
    await mkdir(clone, { recursive: true });
    await cp(join(project, 'scripts'), join(clone, 'scripts'), { recursive: true });
    await cp(join(project, 'src'), join(clone, 'src'), { recursive: true });
    await cp(join(project, 'skills'), join(clone, 'skills'), { recursive: true });
    await writeFile(join(clone, 'package.json'), '{"type":"module"}\n');
    await symlink(join(project, 'node_modules'), join(clone, 'node_modules'), 'dir');

    const childEnv = isolatedChildEnv(root);
    // build_lite candidates are source archives. This synthetic commit exists only
    // in the disposable, explicitly unreleased validation snapshot.
    childEnv.OIL_UI_SOURCE_COMMIT = '0'.repeat(40);
    await exec(process.execPath, ['scripts/vendor-oil-ui.mjs', '--source', source, '--allow-unreleased'], {
      cwd: clone,
      env: childEnv,
    });
    await exec(process.execPath, ['scripts/check-public-pin.mjs', source], { cwd: clone, env: childEnv });

    const output = join(clone, 'skills/oil-ui');
    const manifest = JSON.parse(await readFile(join(clone, 'skills/oil-ui.manifest.json'), 'utf8'));
    const sourceMarkdown = await readFile(join(source, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(sourceMarkdown);
    if (!frontmatter) throw new Error('The explicit public source has no SKILL.md frontmatter.');
    const metadata = parse(frontmatter[1]!).metadata;
    expect(manifest).toMatchObject({
      name: 'oil-ui',
      version: metadata.version,
      distribution: 'original',
      source: { release: null },
      symlinkAudit: { outputContainsSymlinks: false },
    });
    expect(manifest).not.toHaveProperty('transformVersion');

    for (const file of manifest.files) {
      expect(await readFile(join(output, file.path)), file.path).toEqual(await readFile(join(source, file.path)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
