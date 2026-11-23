import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { assertValidVersion, planReleaseVersion } from '../scripts/release-version.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const script = join(project, 'scripts/release-version.mjs');

describe('planReleaseVersion', () => {
  it('promotes X.Y.Z-dev.N to X.Y.Z and advances next dev to X.Y.(Z+1)-dev.0', () => {
    expect(planReleaseVersion('0.4.17-dev.0')).toEqual({
      current: '0.4.17-dev.0',
      releaseVersion: '0.4.17',
      nextDevVersion: '0.4.18-dev.0',
      releaseTag: 'v0.4.17',
    });
    expect(planReleaseVersion('0.4.17-dev.12')).toEqual({
      current: '0.4.17-dev.12',
      releaseVersion: '0.4.17',
      nextDevVersion: '0.4.18-dev.0',
      releaseTag: 'v0.4.17',
    });
    expect(planReleaseVersion('0.0.0-dev.0')).toEqual({
      current: '0.0.0-dev.0',
      releaseVersion: '0.0.0',
      nextDevVersion: '0.0.1-dev.0',
      releaseTag: 'v0.0.0',
    });
  });

  it('bumps stable X.Y.Z to X.Y.(Z+1) and advances next dev to X.Y.(Z+2)-dev.0', () => {
    expect(planReleaseVersion('0.4.17')).toEqual({
      current: '0.4.17',
      releaseVersion: '0.4.18',
      nextDevVersion: '0.4.19-dev.0',
      releaseTag: 'v0.4.18',
    });
    expect(planReleaseVersion('1.2.9')).toEqual({
      current: '1.2.9',
      releaseVersion: '1.2.10',
      nextDevVersion: '1.2.11-dev.0',
      releaseTag: 'v1.2.10',
    });
  });

  it.each([
    '',
    'v0.4.17',
    '0.4',
    '0.4.17.0',
    '01.4.17',
    '0.04.17',
    '0.4.17-beta.0',
    '0.4.17-dev',
    '0.4.17-dev.01',
    '0.4.17-dev.-1',
    '0.4.17+build.1',
    '0.4.-1',
  ])('rejects invalid version format %j', (invalid) => {
    expect(() => planReleaseVersion(invalid)).toThrow(/Invalid package version/u);
    expect(() => assertValidVersion(invalid)).toThrow(/Invalid plugin version/u);
  });
});

describe('release-version CLI', () => {
  it('plans and updates package.json while preserving exact Prettier JSON formatting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-oil-version-'));
    const packagePath = join(root, 'package.json');
    try {
      await cp(join(project, 'package.json'), packagePath);
      const originalText = await readFile(packagePath, 'utf8');
      const originalVersion = JSON.parse(originalText).version as string;
      const expectedPlan = planReleaseVersion(originalVersion);

      const planResult = await exec(process.execPath, [script, '--plan', '--package', packagePath], { cwd: root });
      expect(JSON.parse(planResult.stdout)).toEqual(expectedPlan);

      await exec(process.execPath, [script, '--set', expectedPlan.releaseVersion, '--package', packagePath], {
        cwd: root,
      });
      const updatedText = await readFile(packagePath, 'utf8');
      expect(updatedText).toBe(
        originalText.replace(`"version": "${originalVersion}"`, `"version": "${expectedPlan.releaseVersion}"`),
      );
      expect(updatedText.endsWith('\n')).toBe(true);

      await exec(process.execPath, [script, '--set', expectedPlan.nextDevVersion, '--package', packagePath], {
        cwd: root,
      });
      const nextDevText = await readFile(packagePath, 'utf8');
      expect(JSON.parse(nextDevText).version).toBe(expectedPlan.nextDevVersion);
      expect(nextDevText).toBe(`${JSON.stringify(JSON.parse(nextDevText), null, 2)}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid --set values and conflicting flags without modifying package.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-oil-version-'));
    const packagePath = join(root, 'package.json');
    try {
      await cp(join(project, 'package.json'), packagePath);
      const originalText = await readFile(packagePath, 'utf8');

      await expect(
        exec(process.execPath, [script, '--set', 'v0.4.17', '--package', packagePath], { cwd: root }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Invalid plugin version'),
      });
      expect(await readFile(packagePath, 'utf8')).toBe(originalText);

      await expect(
        exec(process.execPath, [script, '--plan', '--set', '0.4.17', '--package', packagePath], { cwd: root }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('not both'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
