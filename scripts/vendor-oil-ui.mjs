#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { TRANSFORM_VERSION, transformSkillMarkdown, validateSkillTree } from '../src/skill/transform.ts';
import {
  assertNoProResources,
  assertPublicSkillFiles,
  inside,
  isExcludedSkillPath,
  sha256,
  skillExclusionRules,
  toPosix,
  verifySkillEntries,
  verifySkillSnapshot,
} from './lib/skill-distribution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDirectory = path.join(root, 'skills');
const destinationDirectory = path.join(skillsDirectory, 'oil-ui');
const manifestPath = path.join(skillsDirectory, 'oil-ui.manifest.json');
const sourceRepository = 'https://github.com/oil-oil/oil-ui';

function usage() {
  return [
    'Usage: node scripts/vendor-oil-ui.mjs [source-skill-directory] [--check]',
    '       node scripts/vendor-oil-ui.mjs --source <source-skill-directory> [--check]',
    '',
    'Options:',
    '  --source <dir>  oil-ui Git checkout. Defaults to OIL_UI_SOURCE_DIR or ../oil-ui.',
    '  --check         Generate in a temporary directory and verify the committed snapshot.',
    '  --help          Show this help.',
    '',
    'OIL_UI_SOURCE_COMMIT may identify a non-Git source archive. OIL_UI_REPO is deprecated.',
  ].join('\n');
}

function parseArguments(argv) {
  let source;
  let check = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--check') {
      check = true;
    } else if (argument === '--source') {
      source = argv[++index];
      if (!source) throw new Error('--source requires a directory.');
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (source) {
      throw new Error('Specify the source directory only once.');
    } else {
      source = argument;
    }
  }
  return { source, check, help };
}

async function collectFiles(
  rootDirectory,
  directory = rootDirectory,
  relativeDirectory = '',
  ancestors = [],
  entries = [],
  exclusions = [],
  symlinks = [],
) {
  const realDirectory = await realpath(directory);
  if (!inside(rootDirectory, realDirectory)) {
    throw new Error(`Source directory escaped the supplied root at ${toPosix(relativeDirectory || '.')}.`);
  }
  if (ancestors.includes(realDirectory)) {
    throw new Error(`A directory symlink cycle was found at ${toPosix(relativeDirectory)}.`);
  }

  for (const row of await readdir(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? path.join(relativeDirectory, row.name) : row.name;
    const absolutePath = path.join(directory, row.name);
    const linkInfo = await lstat(absolutePath);
    let resolvedPath = absolutePath;
    let sourceKind = 'file';

    if (linkInfo.isSymbolicLink()) {
      resolvedPath = await realpath(absolutePath);
      sourceKind = 'resolved-symlink';
      symlinks.push(toPosix(relativePath));
    } else {
      resolvedPath = await realpath(absolutePath);
    }
    if (!inside(rootDirectory, resolvedPath)) {
      throw new Error(`A source entry escapes the supplied root at ${toPosix(relativePath)}.`);
    }

    const targetInfo = await stat(resolvedPath);
    const isDirectory = targetInfo.isDirectory();
    if (isExcludedSkillPath(relativePath, row.name, isDirectory)) {
      exclusions.push({
        path: toPosix(relativePath),
        reason: 'Excluded from the runtime distribution (repository metadata, caches or documentation-only files).',
      });
      continue;
    }
    if (isDirectory) {
      await collectFiles(
        rootDirectory,
        resolvedPath,
        relativePath,
        [...ancestors, realDirectory],
        entries,
        exclusions,
        symlinks,
      );
      continue;
    }
    if (!targetInfo.isFile()) throw new Error(`Unsupported non-file entry at ${toPosix(relativePath)}.`);

    entries.push({
      path: toPosix(relativePath),
      sourcePath: resolvedPath,
      size: targetInfo.size,
      mode: targetInfo.mode & 0o777,
      sha256: await sha256(resolvedPath),
      sourceKind,
    });
  }
  return { entries, exclusions, symlinks };
}

function resolveSourceCommit(sourceRoot) {
  const supplied = process.env.OIL_UI_SOURCE_COMMIT?.trim();
  if (supplied) {
    if (!/^[0-9a-f]{40}$/i.test(supplied)) throw new Error('OIL_UI_SOURCE_COMMIT must be a full Git commit SHA.');
    return supplied.toLowerCase();
  }
  try {
    return execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('The oil-ui source must be a Git checkout, or set OIL_UI_SOURCE_COMMIT explicitly.');
  }
}

async function buildSnapshot(sourceRoot, stageDirectory, stagedManifest) {
  const sourceSkill = path.join(sourceRoot, 'SKILL.md');
  const raw = await readFile(sourceSkill, 'utf8');
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error('The source SKILL.md has no YAML frontmatter.');
  const identity = parse(frontmatter[1]);
  if (identity.name !== 'oil-ui') throw new Error('Only the open-source oil-ui may be bundled.');
  const version = identity.metadata?.version;
  if (typeof version !== 'string' || !version)
    throw new Error('The source SKILL.md metadata does not declare a version.');

  const transformContext = await validateSkillTree(sourceRoot, { mode: 'strict' });
  const commit = resolveSourceCommit(sourceRoot);
  const { entries, exclusions, symlinks } = await collectFiles(sourceRoot);
  const paths = entries.map((file) => file.path);
  assertNoProResources(paths);
  assertPublicSkillFiles(paths, 'Source paths');
  entries.sort((left, right) => left.path.localeCompare(right.path));

  for (const entry of entries) {
    const targetPath = path.join(stageDirectory, ...entry.path.split('/'));
    await mkdir(path.dirname(targetPath), { recursive: true });
    if (entry.path.endsWith('.md')) {
      const source = await readFile(entry.sourcePath, 'utf8');
      const compiled = transformSkillMarkdown(entry.path, source, { ...transformContext, mode: 'strict' });
      const bytes = Buffer.from(compiled.markdown, 'utf8');
      await writeFile(targetPath, bytes);
      entry.size = bytes.length;
      entry.sha256 = await sha256(targetPath);
    } else {
      await copyFile(entry.sourcePath, targetPath);
    }
    await chmod(targetPath, entry.mode);
  }

  const manifest = {
    name: 'oil-ui',
    version,
    transformVersion: TRANSFORM_VERSION,
    source: {
      repository: sourceRepository,
      commit,
      rootSymlinkResolved: true,
    },
    symlinkAudit: {
      checkedWithinSuppliedRoot: true,
      resolvedSourceSymlinks: symlinks,
      outputContainsSymlinks: false,
    },
    exclusions: {
      rules: skillExclusionRules,
      paths: exclusions.sort((left, right) => left.path.localeCompare(right.path)),
    },
    fileCount: entries.length,
    files: entries.map(({ path: filePath, size, mode, sha256: hash, sourceKind }) => ({
      path: filePath,
      sha256: hash,
      size,
      mode: `0${mode.toString(8).padStart(3, '0')}`,
      ...(sourceKind === 'resolved-symlink' ? { sourceKind } : {}),
    })),
  };

  const compiledReport = await validateSkillTree(stageDirectory, { mode: 'strict' });
  if (compiledReport.unmatchedRules.length > 0) {
    throw new Error(
      `Compiled Skill tree still has unmatched required rules: ${compiledReport.unmatchedRules.map((rule) => `${rule.id} (${rule.file})`).join(', ')}`,
    );
  }
  await verifySkillEntries(stageDirectory, entries);
  await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!process.env.OIL_UI_SOURCE_DIR && process.env.OIL_UI_REPO) {
    process.stderr.write('OIL_UI_REPO is deprecated; use OIL_UI_SOURCE_DIR instead.\n');
  }
  const sourceArgument =
    options.source ?? process.env.OIL_UI_SOURCE_DIR ?? process.env.OIL_UI_REPO ?? path.resolve(root, '..', 'oil-ui');
  const sourceRoot = await realpath(path.resolve(sourceArgument));
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error('The supplied source must be a directory.');

  await mkdir(skillsDirectory, { recursive: true });
  const workspace = await mkdtemp(
    path.join(options.check ? os.tmpdir() : skillsDirectory, options.check ? 'dsh-oil-ui-check-' : '.oil-ui-sync-'),
  );
  const stageDirectory = path.join(workspace, 'oil-ui');
  const stagedManifest = path.join(workspace, 'oil-ui.manifest.json');
  await mkdir(stageDirectory);
  try {
    const manifest = await buildSnapshot(sourceRoot, stageDirectory, stagedManifest);
    if (options.check) {
      const currentManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      await verifySkillSnapshot(destinationDirectory, currentManifest);
      await verifySkillSnapshot(destinationDirectory, manifest);
      if (JSON.stringify(currentManifest) !== JSON.stringify(manifest)) {
        throw new Error('Skill manifest metadata differs from the source checkout. Run pnpm sync:skill.');
      }
      process.stdout.write(
        `Skill snapshot is up to date: oil-ui ${manifest.version} from ${manifest.source.commit}.\n`,
      );
      return;
    }

    const existing = await lstat(destinationDirectory).catch((error) =>
      error.code === 'ENOENT' ? null : Promise.reject(error),
    );
    if (existing?.isSymbolicLink()) throw new Error('The destination Skill directory must not be a symlink.');
    if (existing) await rm(destinationDirectory, { recursive: true, force: true });
    await rename(stageDirectory, destinationDirectory);
    await rename(stagedManifest, manifestPath);
    await verifySkillSnapshot(destinationDirectory, manifest);
    process.stdout.write(
      `Vendored oil-ui ${manifest.version} from ${manifest.source.commit}: ${manifest.fileCount} files copied; ${manifest.exclusions.paths.length} non-runtime paths excluded.\n`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
