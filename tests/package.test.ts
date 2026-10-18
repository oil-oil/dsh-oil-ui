import { expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);

it('rebuilds stale lib before producing and verifying the plugin archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oil-package-contract-'));
  const repository = process.cwd();
  try {
    for (const entry of ['src', 'scripts', 'skills', 'tsdown.config.ts', 'tsconfig.json', 'package.json', 'LICENSE']) {
      await cp(join(repository, entry), join(root, entry), { recursive: true });
    }
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'lib/index.js'), 'throw new Error("STALE_BUILD_SENTINEL");');
    const archive = join(root, 'result.tgz');
    const result = await exec(process.execPath, ['scripts/package-plugin.mjs', archive], { cwd: root });
    expect(result.stdout).toContain('Build complete');
    const unpack = join(root, 'unpacked');
    await mkdir(unpack);
    await exec('tar', ['-xzf', archive, '-C', unpack]);
    const bundled = await readFile(join(unpack, 'package/lib/index.js'), 'utf8');
    expect(bundled).not.toContain('STALE_BUILD_SENTINEL');
    expect(bundled).toContain('oil-ui-subagent-reviewer');
    expect(bundled).toBe(await readFile(join(root, 'lib/index.js'), 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
