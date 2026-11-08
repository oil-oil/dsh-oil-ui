import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const NODE_SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

export function isNodeScript(filePath) {
  if (NODE_SCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  const firstLine = readFileSync(filePath, 'utf8').split(/\r?\n/u, 1)[0] ?? '';
  return /^#!.*\bnode(?:\.exe)?(?:\s|$)/iu.test(firstLine);
}

export function nodeCliInvocation(entryPath, args = [], nodePath = process.execPath) {
  if (!path.isAbsolute(entryPath)) throw new Error(`Node CLI entry must be absolute: ${entryPath}`);
  return { command: nodePath, args: [entryPath, ...args] };
}

export function packageBinEntry(packageDirectory, requestedName) {
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? { [manifest.name?.split('/').at(-1)]: manifest.bin } : manifest.bin;
  if (!bin || typeof bin !== 'object') {
    throw new Error(`${manifest.name ?? packageDirectory} does not declare a CLI bin.`);
  }
  const entry = bin[requestedName] ?? (Object.keys(bin).length === 1 ? Object.values(bin)[0] : undefined);
  if (typeof entry !== 'string') {
    throw new Error(`${manifest.name ?? packageDirectory} does not declare the ${requestedName} CLI bin.`);
  }
  const root = realpathSync(packageDirectory);
  const resolved = realpathSync(path.resolve(root, entry));
  if (!resolved.startsWith(`${root}${path.sep}`) || !statSync(resolved).isFile()) {
    throw new Error(`${manifest.name ?? packageDirectory} CLI entry escapes its package or is not a file.`);
  }
  return resolved;
}

function pathDirectories(env) {
  const value = env.PATH ?? env.Path ?? env.path ?? '';
  return value.split(path.delimiter).filter(Boolean);
}

function findPnpmShim(env, platform) {
  const names = platform === 'win32' ? ['pnpm', 'pnpm.cmd', 'pnpm.exe'] : ['pnpm'];
  for (const directory of pathDirectories(env)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function packageEntryBesideWindowsShim(shimPath, relativeEntries) {
  let directory = path.dirname(shimPath);
  while (true) {
    for (const relative of relativeEntries) {
      const candidate = path.join(directory, relative);
      if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function pnpmInvocation(args, { env = process.env, platform = process.platform, nodePath = process.execPath } = {}) {
  const configuredEntry = env.DSH_SMOKE_PNPM_ENTRY;
  if (configuredEntry) return nodeCliInvocation(configuredEntry, args, nodePath);

  const npmExecPath = env.npm_execpath;
  if (npmExecPath && /pnpm/iu.test(path.basename(npmExecPath)) && isNodeScript(npmExecPath)) {
    return nodeCliInvocation(npmExecPath, args, nodePath);
  }

  const shimPath = findPnpmShim(env, platform);
  if (!shimPath) throw new Error('Could not find pnpm on PATH. Run with pnpm or set DSH_SMOKE_PNPM_ENTRY.');
  let resolved;
  try {
    resolved = realpathSync(shimPath);
  } catch {
    resolved = shimPath;
  }
  if (isNodeScript(resolved)) return nodeCliInvocation(resolved, args, nodePath);
  if (platform === 'win32') {
    const entry = packageEntryBesideWindowsShim(shimPath, [
      path.join('node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      path.join('node_modules', 'pnpm', 'bin', 'pnpm.js'),
      path.join('node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    ]);
    if (entry) return nodeCliInvocation(entry, args, nodePath);
    throw new Error(
      `Could not resolve the pnpm Node entry behind ${shimPath}. Run with pnpm or npm exec --package=pnpm@10.16.1 -- pnpm, or set DSH_SMOKE_PNPM_ENTRY.`,
    );
  }
  return { command: resolved, args };
}

export function npmInvocation(npmExecPath, args, { platform = process.platform, nodePath = process.execPath } = {}) {
  if (!npmExecPath || !path.isAbsolute(npmExecPath)) {
    throw new Error('Run this script through npm so it can use the active npm CLI.');
  }
  if (isNodeScript(npmExecPath)) return nodeCliInvocation(npmExecPath, args, nodePath);
  if (platform === 'win32' && /\.(?:cmd|bat)$/iu.test(npmExecPath)) {
    const entry = packageEntryBesideWindowsShim(npmExecPath, [
      path.join('node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join('node_modules', 'npm', 'bin', 'npm-cli.cjs'),
    ]);
    if (entry) return nodeCliInvocation(entry, args, nodePath);
  }
  throw new Error(
    `npm_execpath must resolve to a Node CLI entry, not a shell wrapper: ${npmExecPath}. Invoke npm run smoke:install from npm so npm_execpath points to npm-cli.js.`,
  );
}
