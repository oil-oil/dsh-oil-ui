import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { INSTALL_REPO } from '../src/skill/install.ts';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const bundledSkill = join(project, 'skills/oil-ui');
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'oil-distribution-'));
  temporary.push(directory);
  return directory;
}

async function pluginClone(root: string) {
  await mkdir(root, { recursive: true });
  await cp(join(project, 'scripts'), join(root, 'scripts'), { recursive: true });
  await cp(join(project, 'src'), join(root, 'src'), { recursive: true });
  await cp(join(project, 'skills'), join(root, 'skills'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
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
    OIL_UI_SOURCE_DIR: '',
    OIL_UI_PRO_DIR: '',
    OIL_UI_IMAGE_GEN_SCRIPT: '',
  };
  delete env.OIL_UI_SOURCE_RELEASE;
  delete env.GITHUB_REF_NAME;
  delete env.OIL_UI_SOURCE_COMMIT;
  delete env.GITHUB_REF;
  delete env.GITHUB_SHA;
  return env;
}

async function sourceTree(root: string, name = 'oil-ui') {
  const directory = join(root, 'source');
  await cp(bundledSkill, directory, { recursive: true });
  const skillPath = join(directory, 'SKILL.md');
  const raw = await readFile(skillPath, 'utf8');
  const renamed = raw.replace(/^name: oil-ui$/m, `name: ${name}`).replace(/^([ \t]*version:\s*).+$/m, "$1'0.0.1'");
  await writeFile(skillPath, `${renamed}\n<!-- ORIGINAL_DISTRIBUTION_FIXTURE -->\n`);
  return directory;
}

async function runVendor(
  root: string,
  source: string,
  options: { allowUnreleased?: boolean; sourceCommit?: string | null; sourceRelease?: string } = {},
) {
  const args = ['scripts/vendor-oil-ui.mjs', '--source', source];
  if (options.allowUnreleased !== false) args.push('--allow-unreleased');
  const env = isolatedChildEnv(root);
  if (options.sourceCommit === null) delete env.OIL_UI_SOURCE_COMMIT;
  else env.OIL_UI_SOURCE_COMMIT = options.sourceCommit ?? 'a'.repeat(40);
  if (options.sourceRelease) env.OIL_UI_SOURCE_RELEASE = options.sourceRelease;
  return exec(process.execPath, args, { cwd: root, env });
}

async function sentinel(root: string) {
  const destination = join(root, 'skills/oil-ui');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'sentinel.txt'), 'previous snapshot');
  return join(destination, 'sentinel.txt');
}

describe('original Lite distribution', () => {
  it('does not let archive environment claims bypass a missing or stale Git release tag', async () => {
    const root = await pluginClone(await tempDirectory());
    const source = await sourceTree(root);
    const env = isolatedChildEnv(root);
    const git = (args: string[]) => exec('git', ['-C', source, ...args], { env });
    await git(['init', '-q']);
    await git(['add', '-A']);
    const commit = () =>
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    await commit();
    const first = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const sentinelPath = await sentinel(root);
    const claimed = (sourceCommit: string) =>
      runVendor(root, source, {
        allowUnreleased: false,
        sourceCommit,
        sourceRelease: 'v0.0.1',
      });
    await expect(claimed(first)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('published public release'),
    });
    await git(['tag', 'v0.0.1']);
    await writeFile(join(source, 'README.md'), 'fictional later commit\n');
    await git(['add', '-A']);
    await commit();
    const next = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await expect(claimed(next)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('published public release'),
    });
    expect(await readFile(sentinelPath, 'utf8')).toBe('previous snapshot');
  });

  it('accepts explicit release provenance for a source archive without Git metadata', async () => {
    const root = await pluginClone(await tempDirectory());
    const source = await sourceTree(root);
    await runVendor(root, source, { allowUnreleased: false, sourceRelease: 'v0.0.1' });
    const manifest = JSON.parse(await readFile(join(root, 'skills/oil-ui.manifest.json'), 'utf8'));
    expect(manifest.source).toMatchObject({ commit: 'a'.repeat(40), release: 'v0.0.1' });
  });

  it('refuses archive provenance for a source nested inside a parent Git repository', async () => {
    const root = await pluginClone(await tempDirectory());
    const source = await sourceTree(root);
    const env = isolatedChildEnv(root);
    await exec('git', ['init', '-q', root], { env });
    await exec('git', ['-C', root, 'add', 'package.json'], { env });
    await exec(
      'git',
      ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'],
      { env },
    );
    await expect(
      runVendor(root, source, {
        allowUnreleased: false,
        sourceRelease: 'v0.0.1',
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('published public release') });
  });

  it('copies source bytes unchanged and records manifest hashes, modes and provenance', async () => {
    const root = await pluginClone(await tempDirectory());
    const source = await sourceTree(root);
    const sourceManifestInput = await readFile(join(source, 'SKILL.md'), 'utf8');
    await writeFile(join(source, 'README.ja.md'), 'fictional Japanese repository introduction\n');

    await runVendor(root, source);

    const output = join(root, 'skills/oil-ui');
    const manifest = JSON.parse(await readFile(join(root, 'skills/oil-ui.manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: 'oil-ui',
      version: '0.0.1',
      distribution: 'original',
      source: { repository: 'https://github.com/oil-oil/oil-ui', commit: 'a'.repeat(40), release: null },
      symlinkAudit: { outputContainsSymlinks: false },
    });
    expect(manifest).not.toHaveProperty('transformVersion');
    expect(manifest.exclusions.paths).toContainEqual(expect.objectContaining({ path: 'README.ja.md' }));
    expect(manifest.files.map((file: { path: string }) => file.path)).not.toContain('README.ja.md');
    expect(await readFile(join(output, 'SKILL.md'), 'utf8')).toBe(sourceManifestInput);

    const paths: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const info = await lstat(path);
        expect(info.isSymbolicLink()).toBe(false);
        if (info.isDirectory()) await walk(path);
        else paths.push(relative(output, path).split(sep).join('/'));
      }
    };
    await walk(output);
    expect(paths.sort()).toEqual(manifest.files.map((file: { path: string }) => file.path).sort());
    expect(manifest.fileCount).toBe(manifest.files.length);
    for (const file of manifest.files) {
      const sourceBytes = await readFile(join(source, file.path));
      const outputBytes = await readFile(join(output, file.path));
      expect(outputBytes, file.path).toEqual(sourceBytes);
      expect(outputBytes.length, file.path).toBe(file.size);
      if (process.platform !== 'win32') {
        const info = await lstat(join(output, file.path));
        expect(`0${(info.mode & 0o777).toString(8).padStart(3, '0')}`, file.path).toBe(file.mode);
      }
    }
  });

  it('requires a clean tagged release by default and marks an explicit candidate as unreleased', async () => {
    const root = await pluginClone(await tempDirectory());
    const source = await sourceTree(root);
    await exec('git', ['init', '-q', source], { env: isolatedChildEnv(root) });
    await exec('git', ['-C', source, 'config', 'user.name', 'Distribution Fixture'], { env: isolatedChildEnv(root) });
    await exec('git', ['-C', source, 'config', 'user.email', 'distribution-fixture@example.invalid'], {
      env: isolatedChildEnv(root),
    });
    await exec('git', ['-C', source, 'add', '-A'], { env: isolatedChildEnv(root) });
    await exec('git', ['-C', source, 'commit', '-qm', 'public release fixture'], { env: isolatedChildEnv(root) });
    await exec('git', ['-C', source, 'tag', 'v0.0.1'], { env: isolatedChildEnv(root) });

    await runVendor(root, source, { allowUnreleased: false, sourceCommit: null });
    let manifest = JSON.parse(await readFile(join(root, 'skills/oil-ui.manifest.json'), 'utf8'));
    expect(manifest.source.release).toBe('v0.0.1');
    const releaseSentinel = join(root, 'skills/oil-ui/release-sentinel.txt');
    await writeFile(releaseSentinel, 'preserve published snapshot on failed sync');

    const sourceSkillPath = join(source, 'SKILL.md');
    const sourceSkill = await readFile(sourceSkillPath, 'utf8');
    await writeFile(sourceSkillPath, `${sourceSkill}\nDIRTY_CANDIDATE\n`);
    const failure = await runVendor(root, source, { allowUnreleased: false, sourceCommit: null }).catch(
      (error) => error,
    );
    expect(failure.code).toBe(1);
    expect(failure.stderr).toMatch(/clean|tag|published release/i);
    expect(await readFile(releaseSentinel, 'utf8')).toBe('preserve published snapshot on failed sync');

    await runVendor(root, source, { allowUnreleased: true, sourceCommit: null });
    manifest = JSON.parse(await readFile(join(root, 'skills/oil-ui.manifest.json'), 'utf8'));
    expect(manifest.source.release).toBeNull();
    expect(await readFile(join(root, 'skills/oil-ui/SKILL.md'), 'utf8')).toContain('DIRTY_CANDIDATE');
  });

  it.each([
    [
      'a Pro identity',
      async (source: string) => {
        const path = join(source, 'SKILL.md');
        const raw = await readFile(path, 'utf8');
        await writeFile(path, raw.replace(/^name: oil-ui$/m, 'name: oil-ui-pro'));
      },
    ],
    [
      'an unreviewed private file',
      async (source: string) => {
        await writeFile(join(source, 'unreviewed.md'), 'synthetic unreviewed content');
      },
    ],
  ])('rejects %s without replacing the existing snapshot', async (_label, mutate) => {
    const root = await pluginClone(await tempDirectory());
    const source = await sourceTree(root);
    const sentinelPath = await sentinel(root);
    await mutate(source);

    const failure = await runVendor(root, source).catch((error) => error);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toMatch(/Only the open-source oil-ui|reviewed .* public distribution/);
    expect(await readFile(sentinelPath, 'utf8')).toBe('previous snapshot');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a source symlink escape without replacing the snapshot',
    async () => {
      const root = await pluginClone(await tempDirectory());
      const source = await sourceTree(root);
      const outside = join(root, 'outside.md');
      const target = join(source, 'references/tools.md');
      await writeFile(outside, 'outside source sentinel');
      await rm(target);
      await symlink(outside, target);
      const sentinelPath = await sentinel(root);

      const failure = await runVendor(root, source).catch((error) => error);

      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain('escapes the supplied root');
      expect(await readFile(sentinelPath, 'utf8')).toBe('previous snapshot');
      expect(await readFile(outside, 'utf8')).toBe('outside source sentinel');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink destination after staging and leaves its target untouched',
    async () => {
      const root = await pluginClone(await tempDirectory());
      const source = await sourceTree(root);
      const outside = join(root, 'destination-outside');
      await mkdir(outside);
      await writeFile(join(outside, 'sentinel.txt'), 'keep destination');
      await rm(join(root, 'skills/oil-ui'), { recursive: true, force: true });
      await symlink(outside, join(root, 'skills/oil-ui'), 'dir');

      const failure = await runVendor(root, source).catch((error) => error);

      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain('destination Skill directory must not be a symlink');
      expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep destination');
    },
  );
});

describe('public install pin', () => {
  it('keeps the Harness installer pin fixed and checks only public source declarations', async () => {
    expect(INSTALL_REPO).toBe('github:oil-oil/oil-cli#e6ee580c01e854919ee50ef1f3de6876c3c52c18');
    const root = await tempDirectory();
    const skill = join(root, 'skill');
    await mkdir(join(skill, 'scripts'), { recursive: true });
    await writeFile(join(skill, 'scripts/check_update.py'), '# No embedded install pin in this public source.\n');
    const runCheck = () =>
      exec(process.execPath, [join(project, 'scripts/check-public-pin.mjs'), skill], {
        cwd: project,
        env: isolatedChildEnv(root),
      });
    await expect(runCheck()).resolves.toMatchObject({ stdout: expect.stringContaining('pin matches') });

    await writeFile(join(skill, 'scripts/check_update.py'), `INSTALL_REPO = '${INSTALL_REPO}'\n`);
    await expect(runCheck()).resolves.toMatchObject({ stdout: expect.stringContaining('pin matches') });

    await writeFile(
      join(skill, 'scripts/check_update.py'),
      "CLI = 'github:oil-oil/oil-cli#0000000000000000000000000000000000000000'\n",
    );
    await expect(runCheck()).rejects.toMatchObject({ stderr: expect.stringContaining('oil-cli pin differs') });
    await writeFile(join(skill, 'scripts/check_update.py'), "INSTALL_REPO = 'github:oil-oil/oil-cli#short'\n");
    await expect(runCheck()).rejects.toMatchObject({ stderr: expect.stringContaining('oil-cli pin differs') });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects an update checker symlink that escapes the public Skill root',
    async () => {
      const root = await tempDirectory();
      const skill = join(root, 'skill');
      const scripts = join(skill, 'scripts');
      const outside = join(root, 'outside-checker.py');
      await mkdir(scripts, { recursive: true });
      await writeFile(outside, `INSTALL_REPO = '${INSTALL_REPO}'\n`);
      await symlink(outside, join(scripts, 'check_update.py'));

      await expect(
        exec(process.execPath, [join(project, 'scripts/check-public-pin.mjs'), skill], {
          cwd: project,
          env: isolatedChildEnv(root),
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('escapes the supplied Skill root') });
    },
  );
});
