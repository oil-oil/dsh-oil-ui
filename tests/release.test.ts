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
  await mkdir(join(root, 'scripts'), { recursive: true });
  await cp(join(project, 'scripts/release-check.mjs'), join(root, 'scripts/release-check.mjs'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-oil-ui', version: '0.4.1-dev.0' }));
  await writeFile(
    join(root, 'skills/oil-ui.manifest.json'),
    JSON.stringify({
      name: 'oil-ui',
      version: '0.25.0',
      transformVersion: '7',
      source: { repository: 'https://github.com/oil-oil/oil-ui', commit: upstreamCommit },
    }),
  );
  return root;
}

it('verifies the release tag and writes traceable release notes', async () => {
  const root = await fixture();
  try {
    const script = join(root, 'scripts/release-check.mjs');
    const result = await exec(process.execPath, [script, '--tag', 'v0.4.1-dev.0', '--notes', '.work/notes.md'], {
      cwd: root,
    });
    expect(result.stdout).toContain('plugin 0.4.1-dev.0, oil-ui 0.25.0');
    const notes = await readFile(join(root, '.work/notes.md'), 'utf8');
    expect(notes).toContain('Bundled oil-ui: 0.25.0');
    expect(notes).toContain(`commit/${upstreamCommit}`);

    await expect(exec(process.execPath, [script, '--tag', 'v0.4.0'], { cwd: root })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('does not match package.json'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
