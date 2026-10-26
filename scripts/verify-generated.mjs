#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSFORM_VERSION } from '../src/skill/transform.ts';
import { runBuild } from './lib/build.mjs';
import { verifySkillSnapshot } from './lib/skill-distribution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function listFiles(directory, relative = '') {
  const files = [];
  for (const row of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = relative ? path.join(relative, row.name) : row.name;
    const info = await lstat(path.join(directory, child));
    if (info.isSymbolicLink()) throw new Error(`Unexpected symlink in generated tree: ${child}`);
    if (info.isDirectory()) files.push(...(await listFiles(directory, child)));
    else if (info.isFile()) files.push(child);
    else throw new Error(`Unexpected non-file entry in generated tree: ${child}`);
  }
  return files.sort();
}

async function compareTrees(expectedDirectory, actualDirectory, label) {
  const expectedFiles = await listFiles(expectedDirectory);
  const actualFiles = await listFiles(actualDirectory);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error(
      `${label} file lists differ. Expected ${expectedFiles.join(', ')}; found ${actualFiles.join(', ')}.`,
    );
  }
  for (const file of expectedFiles) {
    const [expected, actual] = await Promise.all([
      readFile(path.join(expectedDirectory, file)),
      readFile(path.join(actualDirectory, file)),
    ]);
    if (!expected.equals(actual)) throw new Error(`${label} is stale: ${file}. Run pnpm build.`);
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(root, 'skills/oil-ui.manifest.json'), 'utf8'));
  if (manifest.transformVersion !== TRANSFORM_VERSION) {
    throw new Error(
      `Skill transform version is stale: expected ${TRANSFORM_VERSION}, found ${manifest.transformVersion ?? 'none'}.`,
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.source?.commit ?? '')) {
    throw new Error('Skill manifest must record the full upstream commit. Run pnpm sync:skill.');
  }
  const skill = await verifySkillSnapshot(path.join(root, 'skills/oil-ui'), manifest);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-oil-ui-generated-'));
  try {
    const output = path.join(temporaryDirectory, 'lib');
    await mkdir(output);
    runBuild(root, output);
    await compareTrees(path.join(root, 'lib'), output, 'Committed lib/');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
  process.stdout.write(
    `Generated files are up to date: lib/index.js and ${skill.fileCount} oil-ui ${manifest.version} resources from ${manifest.source.commit}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
