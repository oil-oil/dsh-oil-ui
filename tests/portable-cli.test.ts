import { expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { npmInvocation, packageBinEntry, pnpmInvocation } from '../scripts/lib/portable-cli.mjs';

async function createPackage(directory: string, name: string, binName: string, binPath: string) {
  await mkdir(path.dirname(path.join(directory, binPath)), { recursive: true });
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', bin: { [binName]: binPath } }),
  );
  await writeFile(path.join(directory, binPath), '#!/usr/bin/env node\n');
}

it('resolves a package bin and runs it through the selected Node executable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portable-cli-with-spaces-'));
  try {
    const packageDirectory = path.join(root, 'node_modules', 'pnpm');
    await createPackage(packageDirectory, 'pnpm', 'pnpm', 'bin/pnpm.cjs');
    const entry = packageBinEntry(packageDirectory, 'pnpm');
    expect(
      pnpmInvocation(['pack', '--out', path.join(root, 'plugin archive.tgz')], {
        env: { DSH_SMOKE_PNPM_ENTRY: entry, PATH: '/global/corepack/bin' },
        platform: 'win32',
        nodePath: path.join(root, 'node runtime', 'node.exe'),
      }),
    ).toEqual({
      command: path.join(root, 'node runtime', 'node.exe'),
      args: [entry, 'pack', '--out', path.join(root, 'plugin archive.tgz')],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('resolves npm and pnpm Windows command shims to their package Node entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portable-cli-with-spaces-'));
  try {
    const nodeDirectory = path.join(root, 'Node Runtime');
    const npmShim = path.join(nodeDirectory, 'npm.cmd');
    const npmEntry = path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const globalPrefix = path.join(root, 'npm prefix');
    const pnpmShim = path.join(globalPrefix, 'pnpm.cmd');
    const pnpmEntry = path.join(globalPrefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    await mkdir(path.dirname(npmEntry), { recursive: true });
    await mkdir(path.dirname(pnpmEntry), { recursive: true });
    await writeFile(npmShim, '@echo off\r\n');
    await writeFile(pnpmShim, '@echo off\r\n');
    await writeFile(npmEntry, '#!/usr/bin/env node\n');
    await writeFile(pnpmEntry, '#!/usr/bin/env node\n');

    // Windows can spell the same temp directory as a long path or an 8.3 short
    // path (RUNNER~1); compare resolved files, not path strings.
    const npm = npmInvocation(npmShim, ['run', 'pack:plugin'], {
      platform: 'win32',
      nodePath: path.join(root, 'node.exe'),
    });
    expect(npm.command).toBe(path.join(root, 'node.exe'));
    expect(await realpath(npm.args[0])).toBe(await realpath(npmEntry));
    expect(npm.args.slice(1)).toEqual(['run', 'pack:plugin']);
    const pnpm = pnpmInvocation(['pack'], {
      env: { PATH: globalPrefix, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32',
      nodePath: path.join(root, 'node.exe'),
    });
    expect(pnpm.command).toBe(path.join(root, 'node.exe'));
    expect(await realpath(pnpm.args[0])).toBe(await realpath(pnpmEntry));
    expect(pnpm.args.slice(1)).toEqual(['pack']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('fails with actionable guidance instead of spawning an unresolved Windows .cmd shim', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portable-cli-with-spaces-'));
  try {
    const shimDirectory = path.join(root, 'global npm');
    await mkdir(shimDirectory, { recursive: true });
    await writeFile(path.join(shimDirectory, 'pnpm.cmd'), '@echo off\r\n');
    expect(() =>
      pnpmInvocation(['pack'], {
        env: { PATH: shimDirectory },
        platform: 'win32',
      }),
    ).toThrow(/npm exec --package=pnpm@10\.16\.1/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
