#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPackageJsonPath = path.join(root, 'package.json');

const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DEV_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.(0|[1-9]\d*)$/;

export function assertValidVersion(version) {
  if (typeof version !== 'string' || (!STABLE_VERSION_RE.test(version) && !DEV_VERSION_RE.test(version))) {
    throw new Error(`Invalid plugin version "${String(version)}". Expected X.Y.Z or X.Y.Z-dev.N.`);
  }
  return version;
}

export function planReleaseVersion(current) {
  if (typeof current !== 'string') {
    throw new Error(`Invalid package version "${String(current)}". Expected X.Y.Z or X.Y.Z-dev.N.`);
  }
  const devMatch = DEV_VERSION_RE.exec(current);
  if (devMatch) {
    const major = Number(devMatch[1]);
    const minor = Number(devMatch[2]);
    const patch = Number(devMatch[3]);
    const releaseVersion = `${major}.${minor}.${patch}`;
    const nextDevVersion = `${major}.${minor}.${patch + 1}-dev.0`;
    return {
      current,
      releaseVersion,
      nextDevVersion,
      releaseTag: `v${releaseVersion}`,
    };
  }
  const stableMatch = STABLE_VERSION_RE.exec(current);
  if (stableMatch) {
    const major = Number(stableMatch[1]);
    const minor = Number(stableMatch[2]);
    const patch = Number(stableMatch[3]);
    const releaseVersion = `${major}.${minor}.${patch + 1}`;
    const nextDevVersion = `${major}.${minor}.${patch + 2}-dev.0`;
    return {
      current,
      releaseVersion,
      nextDevVersion,
      releaseTag: `v${releaseVersion}`,
    };
  }
  throw new Error(`Invalid package version "${current}". Expected X.Y.Z or X.Y.Z-dev.N.`);
}

export async function setPackageVersion(version, packageJsonPath = defaultPackageJsonPath) {
  assertValidVersion(version);
  const resolvedPath = path.resolve(packageJsonPath);
  const packageJson = JSON.parse(await readFile(resolvedPath, 'utf8'));
  const previousVersion = packageJson.version;
  packageJson.version = version;
  await writeFile(resolvedPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  return { previousVersion, version, packageJsonPath: resolvedPath };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/release-version.mjs --plan [--package <path>]',
    '  node scripts/release-version.mjs --set <version> [--package <path>]',
  ].join('\n');
}

function parseArguments(argv) {
  const options = { plan: false, set: undefined, packagePath: defaultPackageJsonPath, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--plan') {
      options.plan = true;
    } else if (argument === '--set') {
      options.set = argv[++index];
      if (!options.set) throw new Error('--set requires a version value.');
    } else if (argument === '--package') {
      options.packagePath = argv[++index];
      if (!options.packagePath) throw new Error('--package requires a file path.');
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (!options.help) {
    if (options.plan && options.set !== undefined) {
      throw new Error('Specify either --plan or --set, not both.');
    }
    if (!options.plan && options.set === undefined) {
      throw new Error('Specify --plan or --set <version>.');
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.plan) {
    const packageJson = JSON.parse(await readFile(path.resolve(options.packagePath), 'utf8'));
    const plan = planReleaseVersion(packageJson.version);
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }
  const result = await setPackageVersion(options.set, options.packagePath);
  process.stdout.write(
    `Updated version in ${result.packageJsonPath}: ${result.previousVersion} -> ${result.version}\n`,
  );
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
