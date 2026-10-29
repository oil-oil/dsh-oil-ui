import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { hasDirectionImagery, MARKDOWN_RULES } from './rules.ts';
import type { MarkdownRule, SkillEdition } from './rules.ts';

const PROTOCOL_VERSION = 1;
const NATIVE_OPERATIONS = new Map([['hasDirectionImagery', hasDirectionImagery]]);

export class ProAdapterError extends Error {
  override readonly name = 'ProAdapterError';
}

export interface ProAdapter {
  rules: readonly MarkdownRule[];
  fingerprint: string;
  requiredRuleIds: ReadonlySet<string>;
}

function invalidRule(index: number): never {
  throw new ProAdapterError(`Pro adapter rule ${index + 1} is invalid.`);
}

function record(value: unknown, index?: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (index === undefined) throw new ProAdapterError('Pro adapter metadata is invalid.');
    invalidRule(index);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, index: number): string {
  if (typeof value !== 'string' || !value.trim()) invalidRule(index);
  return value;
}

function editions(value: unknown, index: number): readonly SkillEdition[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => item !== 'lite' && item !== 'pro') ||
    new Set(value).size !== value.length
  ) {
    invalidRule(index);
  }
  return value as readonly SkillEdition[];
}

function decodeRule(value: unknown, index: number): MarkdownRule {
  const input = record(value, index);
  const id = text(input.id, index);
  if (!/^[a-z][a-z.-]+$/.test(id)) invalidRule(index);
  const file = text(input.file, index);
  if (
    file !== file.trim() ||
    file.includes('\0') ||
    /^[a-zA-Z]:/.test(file) ||
    file.split(/[/\\]/).some((part) => !part || part === '.' || part === '..')
  ) {
    invalidRule(index);
  }
  const replacement = text(input.replacement, index);
  const requiredIn = editions(input.requiredIn, index);
  const allowedEditions = input.editions === undefined ? undefined : editions(input.editions, index);
  const optionalReason = input.optionalReason === undefined ? undefined : text(input.optionalReason, index);
  const match = record(input.match, index);
  const source = text(match.source, index);
  const flags = match.flags === undefined ? '' : text(match.flags, index);
  if (!/^[gim]*$/.test(flags) || new Set(flags).size !== flags.length) invalidRule(index);
  let nativeSatisfied;
  if (input.nativeSatisfied !== undefined) {
    const operation = text(record(input.nativeSatisfied, index).operation, index);
    nativeSatisfied = NATIVE_OPERATIONS.get(operation);
    if (!nativeSatisfied) invalidRule(index);
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, flags);
  } catch {
    invalidRule(index);
  }
  return {
    id,
    file,
    requiredIn,
    ...(allowedEditions ? { editions: allowedEditions } : {}),
    ...(optionalReason ? { optionalReason } : {}),
    match: pattern,
    replacement,
    ...(nativeSatisfied ? { nativeSatisfied } : {}),
  };
}

async function readAdapterJson(root: string, path: string, label: 'metadata' | 'rules') {
  try {
    const actual = await realpath(resolve(root, path));
    const rel = relative(root, actual);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ProAdapterError('Pro adapter resources must stay inside adapters/dsh.');
    }
    const bytes = await readFile(actual);
    return { value: JSON.parse(bytes.toString('utf8')) as unknown, bytes, path };
  } catch (error) {
    if (error instanceof ProAdapterError) throw error;
    throw new ProAdapterError(`Pro adapter ${label} is missing, unreadable or invalid.`);
  }
}

export async function loadProAdapter(sourceDirectory: string, transformVersion: string): Promise<ProAdapter> {
  let root: string;
  try {
    root = resolve(await realpath(sourceDirectory), 'adapters/dsh');
  } catch {
    throw new ProAdapterError('Pro adapter is missing or unreadable.');
  }
  const metadataFile = await readAdapterJson(root, 'adapter.json', 'metadata');
  const metadata = record(metadataFile.value);
  if (metadata.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProAdapterError('Pro adapter protocol is unsupported.');
  }
  if (typeof metadata.transformVersion !== 'string' || !/^\d+$/.test(metadata.transformVersion)) {
    throw new ProAdapterError('Pro adapter metadata is invalid.');
  }
  if (metadata.transformVersion !== transformVersion) {
    throw new ProAdapterError(
      `Pro adapter requires transform ${metadata.transformVersion}, current is ${transformVersion}.`,
    );
  }
  if (typeof metadata.rules !== 'string' || !metadata.rules.trim()) {
    throw new ProAdapterError('Pro adapter metadata is invalid.');
  }
  const rulesFile = await readAdapterJson(root, metadata.rules, 'rules');
  if (!Array.isArray(rulesFile.value)) throw new ProAdapterError('Pro adapter rules must be an array.');
  const privateRules = rulesFile.value.map(decodeRule);
  const ids = new Set([...MARKDOWN_RULES, ...privateRules].map((rule) => rule.id));
  if (ids.size !== MARKDOWN_RULES.length + privateRules.length) {
    throw new ProAdapterError('Pro adapter rule IDs must be unique across the combined rule set.');
  }
  const hash = createHash('sha256').update(String(PROTOCOL_VERSION)).update('\0').update(transformVersion).update('\0');
  for (const file of [metadataFile, rulesFile]) {
    hash.update(file.path).update('\0').update(file.bytes).update('\0');
  }
  return {
    rules: [...MARKDOWN_RULES, ...privateRules],
    fingerprint: hash.digest('hex'),
    requiredRuleIds: new Set(
      privateRules
        .filter((rule) => rule.requiredIn.includes('pro') && (!rule.editions || rule.editions.includes('pro')))
        .map((rule) => rule.id),
    ),
  };
}

export async function loadMarkdownRules(
  edition: SkillEdition,
  sourceDirectory?: string,
  transformVersion = '9',
): Promise<readonly MarkdownRule[]> {
  if (edition === 'lite') return MARKDOWN_RULES;
  if (!sourceDirectory) throw new ProAdapterError('Pro adapter is missing from the installed Pro Skill.');
  return (await loadProAdapter(sourceDirectory, transformVersion)).rules;
}

export async function adapterFingerprint(sourceDirectory: string, transformVersion: string): Promise<string> {
  return (await loadProAdapter(sourceDirectory, transformVersion)).fingerprint;
}
