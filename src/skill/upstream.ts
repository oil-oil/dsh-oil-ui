import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { parse } from 'yaml';
import type { SkillRegistration, SkillDefinition, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill';
import { OilApiError, readOilCredits, readOilToken } from '../oil-api.ts';
import { INSTALL_REPO } from './install.ts';

const execFileAsync = promisify(execFile);
const VERSIONS_URL = 'https://ui.oiloil.org/api/store/versions';
const CHECK_INTERVAL_MS = 600_000;
const FETCH_TIMEOUT_MS = 8_000;

const packagedSkillDirectory = fileURLToPath(new URL('../skills/oil-ui', import.meta.url));
const sourceSkillDirectory = fileURLToPath(new URL('../../skills/oil-ui', import.meta.url));
export const bundledSkillDirectory = existsSync(join(packagedSkillDirectory, 'SKILL.md'))
  ? packagedSkillDirectory
  : sourceSkillDirectory;
export const skillDirectory = bundledSkillDirectory;

export interface SkillOptions {
  preferPro?: boolean;
  proSkillDir?: string;
  cwd?: string;
}
export interface ImageGenOptions {
  imageGenScript?: string;
  cwd?: string;
}
export interface SkillStatusOptions extends SkillOptions, ImageGenOptions {
  update?: boolean;
}

export function dshSkillRoots(skillName: string, cwd?: string): string[] {
  const home = homedir();
  const dshHome = process.env.DSH_HOME?.trim();
  const agentsHome = process.env.DSH_AGENTS_HOME?.trim();
  let projectDir = cwd?.trim() ? resolve(cwd.trim()) : undefined;
  if (projectDir) {
    let ancestor = projectDir;
    while (true) {
      if (existsSync(join(ancestor, '.git'))) {
        projectDir = ancestor;
        break;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  const roots = [
    ...(projectDir
      ? [
          join(resolve(projectDir), '.dsh', 'skills', skillName),
          join(resolve(projectDir), '.agents', 'skills', skillName),
        ]
      : []),
    ...(dshHome ? [join(resolve(dshHome), 'skills', skillName)] : []),
    join(home, '.dsh', 'skills', skillName),
    ...(process.platform === 'darwin'
      ? [join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness', 'skills', skillName)]
      : []),
    ...(agentsHome ? [join(resolve(agentsHome), 'skills', skillName)] : []),
    join(home, '.agents', 'skills', skillName),
  ];
  return [...new Set(roots)];
}

function stateRootDir(): string {
  return process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
}

function parseSemverTuple(v: string): [number, number, number] {
  const parts = v
    .trim()
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isNewerVersion(latest: string, current: string): boolean {
  const [la, lb, lc] = parseSemverTuple(latest);
  const [ca, cb, cc] = parseSemverTuple(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

interface UpdateCache {
  attemptedAt: number;
  succeededAt: number;
  failures: number;
  latest: string | null;
  lastError: string | null;
}
const updateCache = new Map<string, UpdateCache>();
const updateChecks = new Map<string, Promise<UpdateCache>>();

export async function checkSkillUpdate(
  active: ActiveSkill,
  currentVersion: string,
  performUpdate = false,
): Promise<{
  latestVersion: string | null;
  updateAvailable: boolean;
  updated: boolean;
  updateNotice: string | null;
  lastError: string | null;
}> {
  if (process.env.OIL_NO_UPDATE_CHECK === '1' && !performUpdate) {
    return { latestVersion: null, updateAvailable: false, updated: false, updateNotice: null, lastError: null };
  }
  const cachePath = join(stateRootDir(), 'oil', `${active.name}-update.json`);
  let cache = updateCache.get(cachePath);
  if (!cache) {
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf8'));
      const rawAttemptedAt = Number(raw.attemptedAt ?? raw.checkedAt ?? raw.checked_at ?? 0);
      const rawSucceededAt = Number(raw.succeededAt ?? (raw.checkedAt || raw.checked_at ? rawAttemptedAt : 0));
      const rawFailures = Math.max(0, Number(raw.failures) || 0);
      const rawLastError = typeof raw.lastError === 'string' && raw.lastError.trim() ? raw.lastError.trim() : null;
      // Recover immediately from legacy caches where `skills[name].version` was misread and succeededAt stayed 0.
      const poisonedLegacyCache = rawSucceededAt === 0 && rawFailures > 0 && !('lastError' in raw);
      cache = {
        attemptedAt: poisonedLegacyCache ? 0 : rawAttemptedAt,
        succeededAt: rawSucceededAt,
        failures: poisonedLegacyCache ? 0 : rawFailures,
        latest: typeof raw.latest === 'string' ? raw.latest : null,
        lastError: rawLastError,
      };
    } catch {
      cache = { attemptedAt: 0, succeededAt: 0, failures: 0, latest: null, lastError: null };
    }
    cache = updateCache.get(cachePath) ?? cache;
    updateCache.set(cachePath, cache);
  }
  const nowMs = Date.now();
  const interval = cache.failures
    ? Math.min(CHECK_INTERVAL_MS, 30_000 * 2 ** Math.min(cache.failures - 1, 5))
    : CHECK_INTERVAL_MS;
  const localOutpacedCache = Boolean(
    cache.latest && cache.failures === 0 && isNewerVersion(currentVersion, cache.latest),
  );
  if (performUpdate || localOutpacedCache || nowMs - cache.attemptedAt * 1000 >= interval) {
    let pending = updateChecks.get(cachePath);
    if (!pending) {
      const previous = cache;
      pending = (async () => {
        const next: UpdateCache = {
          ...previous,
          attemptedAt: Math.floor(nowMs / 1000),
          failures: previous.failures + 1,
        };
        try {
          const res = await fetch(VERSIONS_URL, {
            headers: { 'User-Agent': 'oil-skill-update-check/1.0' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          if (res.ok) {
            const payload = (await res.json()) as {
              skills?: Record<
                string,
                { latest?: string; version?: string; published_at?: string; history?: unknown[] }
              >;
            };
            const entry = payload?.skills?.[active.name];
            const version =
              typeof entry?.latest === 'string' && entry.latest.trim()
                ? entry.latest
                : typeof entry?.version === 'string' && entry.version.trim()
                  ? entry.version
                  : undefined;
            if (typeof version === 'string' && version.trim()) {
              next.latest = version.trim();
              next.succeededAt = next.attemptedAt;
              next.failures = 0;
              next.lastError = null;
            } else {
              next.lastError = `Missing latest version for ${active.name} in versions response`;
            }
          } else {
            next.lastError = `HTTP ${res.status}`;
          }
        } catch (error) {
          /* Retain the last successful version and back off failed attempts. */
          next.lastError = error instanceof Error ? error.message : String(error);
        }
        updateCache.set(cachePath, next);
        try {
          await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
          await writeFile(cachePath, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
        } catch {
          /* The process cache still provides offline backoff in read-only environments. */
        }
        return next;
      })();
      updateChecks.set(cachePath, pending);
    }
    try {
      cache = await pending;
    } finally {
      if (updateChecks.get(cachePath) === pending) updateChecks.delete(cachePath);
    }
  }
  const latest = cache.latest && isNewerVersion(currentVersion, cache.latest) ? currentVersion : cache.latest;
  const lastError = cache.lastError;

  if (!latest || !isNewerVersion(latest, currentVersion)) {
    return { latestVersion: latest, updateAvailable: false, updated: false, updateNotice: null, lastError };
  }

  // Bundled files are immutable plugin assets, never an oil-cli installation.
  if (await isBundledSkillDirectory(active.directory)) {
    return {
      latestVersion: latest,
      updateAvailable: true,
      updated: false,
      updateNotice: `[oil-ui] Update available: ${currentVersion} -> ${latest}. Update the dsh-oil-ui plugin to receive its bundled Skill; do not update files inside the plugin installation.`,
      lastError,
    };
  }
  const targetDir = active.directory;
  if (performUpdate) {
    try {
      const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      await execFileAsync(cmd, ['-y', INSTALL_REPO, 'update', active.name, '--path', targetDir, '--json'], {
        timeout: 90_000,
      });
      return {
        latestVersion: latest,
        updateAvailable: false,
        updated: true,
        updateNotice: `[${active.name}] Updated to ${latest}. Reload the Skill to use the updated instructions.`,
        lastError,
      };
    } catch {
      return {
        latestVersion: latest,
        updateAvailable: true,
        updated: false,
        updateNotice: `[${active.name}] Auto-update failed. Run manually: npx -y ${INSTALL_REPO} update ${active.name} --path "${targetDir}"`,
        lastError,
      };
    }
  }

  return {
    latestVersion: latest,
    updateAvailable: true,
    updated: false,
    updateNotice: `[${active.name}] Update available: ${currentVersion} -> ${latest}. Ask the user whether to update now; if confirmed, call oil_ui_skill_status({ "update": true }).`,
    lastError,
  };
}

export async function resolveImageGenScript(options: ImageGenOptions = {}): Promise<string | null> {
  const explicit = options.imageGenScript?.trim() || process.env.OIL_UI_IMAGE_GEN_SCRIPT?.trim();
  const roots = dshSkillRoots('image-gen', options.cwd);
  const candidates = [
    ...(explicit ? [{ path: resolve(explicit), root: dirname(resolve(explicit)) }] : []),
    ...roots.map((root) => ({ root, path: join(root, 'scripts', 'image_gen.py') })),
  ];
  for (const candidate of candidates) {
    try {
      const root = await realpath(candidate.root);
      const path = await realpath(candidate.path);
      const rel = relative(root, path);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      if ((await stat(path)).isFile()) return path;
    } catch {
      /* Missing, unreadable or escaping scripts are unavailable. */
    }
  }
  return null;
}

export interface ActiveSkill {
  edition: 'pro' | 'lite';
  name: 'oil-ui-pro' | 'oil-ui';
  directory: string;
  source: 'local-pro' | 'bundled-lite' | 'filesystem';
}

function frontmatter(raw: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw new Error('Skill frontmatter missing');
  const data = parse(match[1]!);
  if (!data || typeof data !== 'object') throw new Error('Invalid Skill frontmatter');
  return { data, content: raw.slice(match[0].length) };
}

interface SkillHeader {
  data: Record<string, unknown>;
}
const headers = new Map<string, { stamp: string; value: Promise<SkillHeader> }>();
async function readHeader(path: string): Promise<SkillHeader> {
  const info = await stat(path);
  const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const old = headers.get(path);
  if (old?.stamp === stamp) return old.value;
  const value = (async () => {
    const handle = await open(path, 'r');
    try {
      let raw = '';
      const chunk = Buffer.alloc(1024);
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < 65536; offset += chunk.length) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
        raw = Buffer.concat(chunks).toString('utf8');
        if (/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(raw) || !bytesRead) break;
      }
      return { data: frontmatter(raw).data };
    } finally {
      await handle.close();
    }
  })();
  headers.set(path, { stamp, value });
  try {
    return await value;
  } catch (error) {
    headers.delete(path);
    throw error;
  }
}

async function findPro(options: SkillOptions): Promise<string | null> {
  const explicit = options.proSkillDir?.trim() || process.env.OIL_UI_PRO_DIR?.trim();
  // oil-cli installationRoots/targetRoot: Claude is the first default target;
  // Codex/DSH normally share .agents, while --to accepts these user roots.
  // Keep DSH roots ahead of cross-host Pro fallbacks; image-gen is unchanged.
  const home = homedir();
  const codexHome = process.env.CODEX_HOME?.trim();
  const codexRoot = codexHome
    ? codexHome === '~'
      ? home
      : /^~[/\\]/.test(codexHome)
        ? join(home, codexHome.slice(2))
        : resolve(codexHome)
    : join(home, '.codex');
  const candidates = [
    ...(explicit ? [explicit] : []),
    ...dshSkillRoots('oil-ui-pro', options.cwd),
    join(home, '.claude', 'skills', 'oil-ui-pro'),
    join(codexRoot, 'skills', 'oil-ui-pro'),
    join(home, '.cursor', 'skills', 'oil-ui-pro'),
    join(home, '.workbuddy', 'skills', 'oil-ui-pro'),
  ];
  for (const candidate of new Set(candidates.filter((p): p is string => Boolean(p)))) {
    try {
      const directory = await realpath(resolve(candidate));
      const path = await realpath(join(directory, 'SKILL.md'));
      const rel = relative(directory, path);
      if (rel.startsWith('..') || isAbsolute(rel) || !(await stat(path)).isFile()) continue;
      const { data } = await readHeader(path);
      if (data.name === 'oil-ui-pro') return directory;
    } catch {
      /* An absent, unreadable or invalid installation is not active. */
    }
  }
  return null;
}

export interface SkillSnapshot {
  active: ActiveSkill;
  header: SkillHeader;
}
export async function discoverSkill(options: SkillOptions = {}): Promise<SkillSnapshot> {
  const pro = options.preferPro !== false ? await findPro(options) : null;
  const active: ActiveSkill = pro
    ? { edition: 'pro', name: 'oil-ui-pro', directory: pro, source: 'local-pro' }
    : {
        edition: 'lite',
        name: 'oil-ui',
        directory: bundledSkillDirectory,
        source: 'bundled-lite',
      };
  const header = await readHeader(join(active.directory, 'SKILL.md'));
  return { active, header };
}

export async function resolveActiveSkill(options: SkillOptions = {}): Promise<ActiveSkill> {
  return (await discoverSkill(options)).active;
}

// Read the selected original manual afresh; never rewrite or cache Pro documents.
export async function loadReviewerManual(options: SkillOptions = {}, activeSkill?: ActiveSkill): Promise<string> {
  const active = activeSkill ?? (await resolveActiveSkill(options).catch(() => undefined));
  for (const directory of new Set([...(active ? [active.directory] : []), bundledSkillDirectory])) {
    try {
      const base = await realpath(directory);
      const path = await realpath(join(base, 'references/reviewer-manual.md'));
      const rel = relative(base, path);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      return await readFile(path, 'utf8');
    } catch {
      /* Continue to the bundled manual. */
    }
  }
  return '';
}

export async function isBundledSkillDirectory(directory: string): Promise<boolean> {
  try {
    return (await realpath(directory)) === (await realpath(bundledSkillDirectory));
  } catch {
    return false;
  }
}

export async function loadSkillDirectory(
  directory: string,
  expectedName: ActiveSkill['name'],
  source: ActiveSkill['source'],
): Promise<SkillRegistration> {
  const base = await realpath(directory);
  const path = await realpath(join(base, 'SKILL.md'));
  const rel = relative(base, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Skill entry escapes its resource directory');
  const { data, content } = frontmatter(await readFile(path, 'utf8'));
  if (data.name !== expectedName) throw new Error('Invalid active Skill identity');
  return {
    name: expectedName,
    description: typeof data.description === 'string' ? data.description : 'Oil UI',
    metadata: data.metadata,
    path: join(directory, 'SKILL.md'),
    source,
    resourceBase: { kind: 'directory', path: directory },
    invocation: { modelInvocable: true, userInvocable: true },
    content,
  };
}

export async function loadUpstreamSkill(options: SkillOptions = {}): Promise<SkillRegistration> {
  const active = await resolveActiveSkill(options);
  return loadSkillDirectory(active.directory, active.name, active.source);
}

// This invariant belongs here, not just in apply(): callers cannot accidentally
// turn this provider into a second publisher of oil-ui-pro.
export function createSkillProvider(_options: SkillOptions, control: SkillProviderControl): SkillProvider {
  const name = 'oil-ui-provider';
  return {
    name,
    async list(lookup) {
      control.signal.throwIfAborted();
      lookup.signal?.throwIfAborted();
      const skill = await loadUpstreamSkill({ preferPro: false });
      return [{ ...skill, provider: name, invocation: skill.invocation!, rank: 20, locator: 'bundled-lite' }];
    },
    async get(candidate, lookup) {
      if (candidate.name !== 'oil-ui') return undefined;
      control.signal.throwIfAborted();
      lookup.signal?.throwIfAborted();
      return {
        ...(await loadUpstreamSkill({ preferPro: false })),
        provider: name,
        invocation: { modelInvocable: true, userInvocable: true },
      };
    },
  };
}

// Validate the definition selected by the caller's scope, not a preferred local
// installation or a provider label. Every edition is checked against its own original file.
export async function matchesNativeSkill(visible: SkillDefinition | null | undefined): Promise<boolean> {
  if (!visible || visible.invocation?.modelInvocable === false || visible.resourceBase?.kind !== 'directory')
    return false;
  if (visible.name !== 'oil-ui' && visible.name !== 'oil-ui-pro') return false;
  try {
    const directory = await realpath(visible.resourceBase.path);
    const expected = await loadSkillDirectory(directory, visible.name, 'filesystem');
    return (
      visible.name === expected.name &&
      visible.metadata?.version === expected.metadata?.version &&
      // Harness filesystem trims boundary whitespace when parsing Markdown.
      visible.content.trim() === expected.content.trim() &&
      Boolean(visible.path && expected.path && (await realpath(visible.path)) === (await realpath(expected.path)))
    );
  } catch {
    return false;
  }
}

export async function skillStatus(
  visible?: SkillDefinition | null,
  options: SkillStatusOptions = {},
  snapshot?: SkillSnapshot,
  refreshVisible?: () => Promise<SkillDefinition | null | undefined>,
) {
  snapshot ??= await discoverSkill(options);
  const matchedBeforeUpdate = await matchesNativeSkill(visible);
  const targetBase = visible?.resourceBase?.kind === 'directory' ? visible.resourceBase.path : null;
  const targetEdition = visible?.name === 'oil-ui-pro' ? 'pro' : 'lite';
  const updateTarget: ActiveSkill =
    visible && targetBase && (visible.name === 'oil-ui-pro' || visible.name === 'oil-ui')
      ? {
          edition: targetEdition,
          name: visible.name,
          directory: targetBase,
          source: (await isBundledSkillDirectory(targetBase)) ? 'bundled-lite' : 'filesystem',
        }
      : snapshot.active;
  const updateInfo = await checkSkillUpdate(
    updateTarget,
    String(visible?.metadata?.version ?? 'unknown'),
    Boolean(options.update && matchedBeforeUpdate),
  );
  if (updateInfo.updated) {
    // Reload through the same Harness scope; a file on disk is not proof of the winner.
    if (refreshVisible) visible = await refreshVisible();
    snapshot = await discoverSkill(options);
  }
  const { active, header } = snapshot;
  const manifestPath = join(bundledSkillDirectory, '../oil-ui.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string; files: unknown[] };
  const visibleMatchesOriginal = updateInfo.updated ? await matchesNativeSkill(visible) : matchedBeforeUpdate;
  const effectiveBase = visible?.resourceBase?.kind === 'directory' ? visible.resourceBase.path : null;
  const effectiveName = visible?.name ?? active.name;
  const edition = effectiveName === 'oil-ui-pro' ? 'pro' : 'lite';
  const activeVersion = String(visible?.metadata?.version ?? 'unknown');
  const pro =
    visible?.name === 'oil-ui-pro' && visibleMatchesOriginal && effectiveBase
      ? await realpath(effectiveBase)
      : await findPro(options);
  const imageGenScriptPath = await resolveImageGenScript(options);
  const oilToken = await readOilToken();
  let oilLoggedIn = Boolean(oilToken);
  let oilBalance: number | null = null;
  let oilBalanceError: string | null = null;
  if (oilToken) {
    try {
      oilBalance = await readOilCredits(oilToken);
    } catch (error) {
      if (error instanceof OilApiError && error.status === 401) oilLoggedIn = false;
      oilBalanceError = '无法查询 oiloil 余额';
    }
  }
  const skillLoadState = visibleMatchesOriginal
    ? ('ready' as const)
    : !visible || visible.invocation?.modelInvocable === false
      ? ('unavailable' as const)
      : ('overridden' as const);
  const skillLoadWarning = visibleMatchesOriginal
    ? null
    : !visible
      ? '当前作用域未能加载 Oil UI Skill。'
      : visible.invocation?.modelInvocable === false
        ? `当前 Skill 由 ${visible.provider} 发布，但已禁止模型调用。`
        : `当前 Skill 由 ${visible.provider} 发布，其正文、资源目录、版本或入口路径与实际安装不一致。`;
  return {
    skillReady: visibleMatchesOriginal,
    nativeSkillReady: visibleMatchesOriginal,
    skillLoadState,
    skillLoadWarning,
    imageGenAvailable: imageGenScriptPath !== null,
    imageGenScriptPath,
    imageSource: imageGenScriptPath ? 'image-gen' : oilLoggedIn ? 'oiloil' : 'none',
    oilLoggedIn,
    oilBalance,
    oilBalanceError,
    edition,
    activeSkillName: effectiveName,
    detected: {
      name: active.name,
      edition: active.edition,
      version: String((header.data.metadata as Record<string, unknown> | undefined)?.version ?? 'unknown'),
      path: join(active.directory, 'SKILL.md'),
    },
    effective: visible
      ? {
          name: visible.name,
          version: activeVersion,
          path: visible.path,
          resourceBase: visible.resourceBase,
          provider: visible.provider,
        }
      : null,
    activeVersion,
    latestVersion: updateInfo.latestVersion,
    updateAvailable: updateInfo.updateAvailable,
    updated: updateInfo.updated,
    updateNotice: updateInfo.updateNotice,
    updateCheckError: updateInfo.lastError,
    bundledVersion: manifest.version,
    proInstalled: pro !== null,
    proVisible: visible?.name === 'oil-ui-pro',
    proSourcePath: pro,
    activeResourceBase: effectiveBase,
    name: effectiveName,
    version: activeVersion,
    fileCount: manifest.files.length,
    manifestPath,
    resourceBase: visible?.resourceBase ?? null,
    path: visible?.path ?? null,
    visibleMatchesOriginal,
    upgradeHint:
      skillLoadWarning ??
      (edition === 'pro'
        ? '已加载本机 Pro 原文，宿主工具用法见 references/tools.md。'
        : pro
          ? '已发现本地 Pro，但当前 Agent 的 filesystem Skill 目录未发布它；当前加载生效的 Lite 原文。配置插件发现路径不会发布 Pro，请检查 Harness 的 Skill 目录。'
          : '可通过 npx github:oil-oil/oil-cli install oil-ui-pro 安装 Pro；由 Harness filesystem Provider 发现并直接加载原文。'),
    note: 'All Oil UI instructions are loaded unchanged. Manifest hashes are offline evidence for the bundled public Skill only.',
  };
}
