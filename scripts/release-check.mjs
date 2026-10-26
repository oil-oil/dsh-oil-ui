#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const options = { tag: process.env.GITHUB_REF_NAME || undefined, notes: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--tag') options.tag = argv[++index];
    else if (argument === '--notes') options.notes = argv[++index];
    else throw new Error(`Unknown option: ${argument}`);
    if ((argument === '--tag' || argument === '--notes') && !options[argument.slice(2)]) {
      throw new Error(`${argument} requires a value.`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/release-check.mjs [--tag vX.Y.Z] [--notes release-notes.md]\n');
    return;
  }
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(root, 'skills/oil-ui.manifest.json'), 'utf8'));
  const expectedTag = `v${packageJson.version}`;
  if (options.tag && options.tag !== expectedTag) {
    throw new Error(`Release tag ${options.tag} does not match package.json (${expectedTag}).`);
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.source?.commit ?? '')) {
    throw new Error('Cannot release without a full upstream Skill commit in the manifest.');
  }
  if (typeof manifest.source?.repository !== 'string' || !manifest.source.repository) {
    throw new Error('Cannot release without the upstream Skill repository in the manifest.');
  }

  const notes = [
    `## dsh-oil-ui ${expectedTag}`,
    '',
    `- Plugin version: ${packageJson.version}`,
    `- Bundled oil-ui: ${manifest.version}`,
    `- Transform version: ${manifest.transformVersion}`,
    `- Upstream: ${manifest.source.repository}/commit/${manifest.source.commit}`,
    '',
    'The attached plugin archive was rebuilt and verified after extraction.',
    '',
  ].join('\n');
  if (options.notes) {
    const output = path.resolve(options.notes);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, notes);
  }
  process.stdout.write(
    `Release metadata verified: plugin ${packageJson.version}, oil-ui ${manifest.version}, upstream ${manifest.source.commit}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
