#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild, runPnpm } from './lib/build.mjs';
import { verifySkillSnapshot } from './lib/skill-distribution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const snapshotDirectory = path.join(root, 'skills', 'oil-ui');
const manifestPath = path.join(root, 'skills', 'oil-ui.manifest.json');
const tarEnvironment = { ...process.env, COPYFILE_DISABLE: '1' };

function usage() {
  process.stdout.write('Usage: node scripts/package-plugin.mjs [output.tgz]\n');
  process.stdout.write('Default output: .work/<package-name>-<version>.tgz\n');
}

async function verifyPackageTree(packageDirectory, manifest, gitignoreBytes) {
  const skills = await readdir(path.join(packageDirectory, 'skills'));
  if (skills.sort().join(',') !== 'oil-ui,oil-ui.manifest.json') throw new Error('Unexpected packaged Skill tree.');
  const skillDirectory = path.join(packageDirectory, 'skills', 'oil-ui');
  await verifySkillSnapshot(skillDirectory, manifest);
  const packagedGitignore = await readFile(path.join(skillDirectory, '.gitignore'));
  if (!packagedGitignore.equals(gitignoreBytes)) {
    throw new Error('The packaged Skill .gitignore does not match the original snapshot bytes.');
  }
}

function verifyArchiveHasNoAppleDouble(archivePath) {
  const entries = execFileSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    env: tarEnvironment,
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const sidecar = entries.find((entry) => entry.split('/').some((part) => part.startsWith('._')));
  if (sidecar) throw new Error(`The package archive contains a macOS AppleDouble entry: ${sidecar}.`);
  return entries;
}

async function main() {
  const outputArgument = process.argv[2];
  if (outputArgument === '--help' || outputArgument === '-h') {
    usage();
    return;
  }
  runBuild(root);
  const defaultOutput = path.join(root, '.work', `${packageJson.name}-${packageJson.version}.tgz`);
  const outputPath = path.resolve(outputArgument ?? defaultOutput);
  const outputDirectory = path.dirname(outputPath);
  const skillManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await verifySkillSnapshot(snapshotDirectory, skillManifest);
  const snapshotIgnore = path.join(snapshotDirectory, '.gitignore');
  const gitignoreBytes = await readFile(snapshotIgnore);
  const gitignoreMode = (await stat(snapshotIgnore)).mode & 0o777;

  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-oil-ui-package-'));
  const initialPack = path.join(temporaryDirectory, 'pnpm-pack.tgz');
  const unpackDirectory = path.join(temporaryDirectory, 'unpacked');
  const verifyDirectory = path.join(temporaryDirectory, 'verify');
  const stagedOutput = path.join(outputDirectory, `.${path.basename(outputPath)}.${process.pid}.tmp`);

  try {
    runPnpm(root, ['pack', '--out', initialPack]);

    await mkdir(unpackDirectory, { recursive: true });
    execFileSync('tar', ['-xzf', initialPack, '-C', unpackDirectory], { stdio: 'inherit', env: tarEnvironment });
    const packageDirectory = path.join(unpackDirectory, 'package');
    const packagedIgnorePath = path.join(packageDirectory, 'skills', 'oil-ui', '.gitignore');
    await mkdir(path.dirname(packagedIgnorePath), { recursive: true });
    await writeFile(packagedIgnorePath, gitignoreBytes, { mode: gitignoreMode });
    await chmod(packagedIgnorePath, gitignoreMode);
    for (const file of skillManifest.files) {
      await chmod(path.join(packageDirectory, 'skills', 'oil-ui', file.path), file.mode);
    }
    await verifyPackageTree(packageDirectory, skillManifest, gitignoreBytes);

    execFileSync('tar', ['-czf', stagedOutput, '-C', unpackDirectory, 'package'], {
      stdio: 'inherit',
      env: tarEnvironment,
    });
    await mkdir(verifyDirectory, { recursive: true });
    const archiveEntries = verifyArchiveHasNoAppleDouble(stagedOutput);
    execFileSync('tar', ['-xzf', stagedOutput, '-C', verifyDirectory], { stdio: 'inherit', env: tarEnvironment });
    await verifyPackageTree(path.join(verifyDirectory, 'package'), skillManifest, gitignoreBytes);

    await rename(stagedOutput, outputPath);
    process.stdout.write(
      `Created ${outputPath} with ${skillManifest.fileCount} oil-ui Skill resources and the original .gitignore; checked ${archiveEntries.length} total archive entries for AppleDouble sidecars.\n`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    await rm(stagedOutput, { force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
