#!/usr/bin/env node

// Run the workflow's validation block against an offline, fictional future release.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { INSTALL_REPO } from '../src/skill/install.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'oil-sync-workflow-'));
const checkout = path.join(temporary, 'plugin');
const home = path.join(temporary, 'home');
const env = Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'COMSPEC']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  DSH_HOME: path.join(home, '.dsh'),
  DSH_AGENTS_HOME: path.join(home, '.agents'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_STATE_HOME: path.join(home, '.local/state'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  APPDATA: path.join(home, 'AppData/Roaming'),
  npm_config_cache: path.join(home, '.npm'),
  npm_config_userconfig: path.join(home, '.npmrc'),
  npm_config_globalconfig: path.join(home, 'global.npmrc'),
  COREPACK_HOME: path.join(home, '.corepack'),
  OIL_NO_UPDATE_CHECK: '1',
  NO_COLOR: '1',
});
const run = (command, args, cwd = checkout) =>
  execFileSync(command, args, { cwd, env, stdio: 'inherit', timeout: 300_000 });
const git = (args, cwd = checkout) => run('git', args, cwd);

try {
  await mkdir(home);
  await mkdir(checkout);
  for (const entry of [
    'src',
    'scripts',
    'tests',
    'skills',
    'lib',
    '.github',
    'docs',
    'AGENTS.md',
    'cordis.patch.yml',
    'assets',
    'package.json',
    'pnpm-lock.yaml',
    'LICENSE',
    'README.md',
    'README.en.md',
    'tsconfig.json',
    'tsdown.config.ts',
    'vitest.config.ts',
    'vitest.integration.config.ts',
    '.prettierignore',
    '.prettierrc.json',
  ]) {
    await cp(path.join(repository, entry), path.join(checkout, entry), { recursive: true });
  }
  await writeFile(path.join(checkout, '.gitignore'), 'node_modules/\n.work/\n');
  await symlink(
    path.join(repository, 'node_modules'),
    path.join(checkout, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline']);

  const source = path.join(checkout, 'upstream-oil-ui');
  await cp(path.join(repository, 'skills/oil-ui'), source, { recursive: true });
  const skill = path.join(source, 'SKILL.md');
  const original = await readFile(skill, 'utf8');
  const version = '999.0.0';
  const next = original.replace(/^(\s+version:\s*)["']?\d+\.\d+\.\d+["']?\s*$/m, `$1"${version}"`);
  if (next === original) throw new Error('Cannot create the fictional Skill version.');
  await writeFile(skill, next);
  const checker = path.join(source, 'scripts/check_update.py');
  await writeFile(
    checker,
    (await readFile(checker, 'utf8')).replace(/^((?:CLI|INSTALL_REPO)\s*=\s*)["'][^"']+["']/m, `$1"${INSTALL_REPO}"`),
  );
  git(['init', '-q'], source);
  git(['add', '.'], source);
  git(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fictional public release',
    ],
    source,
  );
  git(['tag', `v${version}`], source);

  const workflow = parse(await readFile(path.join(checkout, '.github/workflows/sync-skill.yml'), 'utf8'));
  const steps = workflow.jobs.sync.steps;
  const upstreamCheckout = steps.find((step) => step.with?.repository === 'oil-oil/oil-ui');
  if (upstreamCheckout?.with?.ref !== '${{ steps.upstream.outputs.tag }}')
    throw new Error('Workflow must check out the published release tag.');
  const block = steps.find((step) => step.name === 'Sync and verify the upstream snapshot')?.run;
  if (!block || !block.includes('check-public-pin.mjs'))
    throw new Error('Workflow validation and pin check are required.');
  run(process.platform === 'win32' ? 'bash' : 'sh', ['-eu', '-c', block]);
  const manifest = JSON.parse(await readFile(path.join(checkout, 'skills/oil-ui.manifest.json'), 'utf8'));
  if (manifest.version !== version || manifest.source.release !== `v${version}` || manifest.distribution !== 'original')
    throw new Error('Workflow did not synchronize the fictional original release.');
  if ((await readFile(path.join(checkout, 'skills/oil-ui/SKILL.md'), 'utf8')) !== next)
    throw new Error('Workflow rewrote the fictional Skill.');
  const changed = execFileSync('git', ['diff', '--name-only'], { cwd: checkout, env, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  if (!changed.length || changed.some((file) => !file.startsWith('skills/') && !file.startsWith('lib/')))
    throw new Error('Workflow changed files outside generated assets.');
  process.stdout.write(
    `${JSON.stringify({ ok: true, fictionalVersion: version, validationBlockPassed: true, originalBytesUnchanged: true, changedOnlyGeneratedAssets: true })}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
