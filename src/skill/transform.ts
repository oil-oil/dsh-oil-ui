import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { MARKDOWN_RULES } from './rules.ts';
import type { SkillEdition } from './rules.ts';

export { MARKDOWN_RULES } from './rules.ts';
export type { MarkdownRule, SkillEdition } from './rules.ts';

export const TRANSFORM_VERSION = '8';

const EXCLUDED_NAMES = new Set(['.git', '.DS_Store', '__pycache__']);
const DOC_ONLY_PATHS = new Set(['assets/readme', 'README.en.md']);

export type TransformInput = 'upstream' | 'native';
export interface TransformOptions {
  edition: SkillEdition;
  input?: TransformInput;
  mode?: 'strict' | 'lenient';
}

export interface RuleResult {
  id: string;
  file: string;
  required: boolean;
  matches: number;
  status: 'matched' | 'already-transformed' | 'unmatched';
}

export class SkillTransformError extends Error {
  readonly unmatchedRules: RuleResult[];

  constructor(unmatchedRules: RuleResult[]) {
    super(
      `Required Skill rewrite rules did not match:\n${unmatchedRules.map((rule) => `- ${rule.id} (${rule.file})`).join('\n')}`,
    );
    this.name = 'SkillTransformError';
    this.unmatchedRules = unmatchedRules;
  }
}

function assertRequiredRules(results: RuleResult[]): void {
  const missing = results.filter((rule) => rule.required && rule.status === 'unmatched');
  if (missing.length) throw new SkillTransformError(missing);
}

export function transformSkillMarkdown(relativePath: string, raw: string, options: TransformOptions) {
  const file = relativePath.split(/[/\\]/).join('/');
  const nativeEvidence = raw.split('\r\n').join('\n');
  const rules: RuleResult[] = [];
  let markdown = raw;
  for (const rule of MARKDOWN_RULES) {
    if (rule.file !== file) continue;
    let matches = 0;
    // Inspect the input, not text inserted by an earlier rule, for native evidence.
    const alreadyTransformed =
      options.input === 'native' &&
      (rule.nativeSatisfied ? rule.nativeSatisfied(nativeEvidence) : nativeEvidence.includes(rule.replacement));
    if (!alreadyTransformed) {
      markdown = markdown.replace(new RegExp(rule.match.source, rule.match.flags), () => {
        matches++;
        return rule.replacement;
      });
    }
    rules.push({
      id: rule.id,
      file,
      required: rule.requiredIn.includes(options.edition),
      matches,
      status: matches ? 'matched' : alreadyTransformed ? 'already-transformed' : 'unmatched',
    });
  }
  if (options.mode === 'strict') assertRequiredRules(rules);
  return { markdown, rules };
}

// Check every rule file, including missing files, and aggregate failures before publishing.
// Native input still needs per-rule evidence; detecting a native SKILL.md is not a bypass.
export async function validateSkillTree(sourceRoot: string, options: { mode?: TransformOptions['mode'] } = {}) {
  const realSource = await realpath(sourceRoot);
  const rules: RuleResult[] = [];
  async function readMarkdown(file: string): Promise<string> {
    try {
      const actual = await realpath(join(realSource, file));
      const rel = relative(realSource, actual);
      if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Skill entry escapes root: ${file}`);
      return await readFile(actual, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }
  const skill = await readMarkdown('SKILL.md');
  const header = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const name = header ? parse(header[1]!)?.name : undefined;
  if (name !== 'oil-ui' && name !== 'oil-ui-pro')
    throw new Error('Expected oil-ui or oil-ui-pro SKILL.md frontmatter.');
  const context: TransformOptions = {
    edition: name === 'oil-ui' ? 'lite' : 'pro',
    input: isHarnessNativeSkillMarkdown(skill) ? 'native' : 'upstream',
    mode: 'lenient',
  };
  for (const file of new Set(MARKDOWN_RULES.map((rule) => rule.file))) {
    const raw = file === 'SKILL.md' ? skill : await readMarkdown(file);
    rules.push(...transformSkillMarkdown(file, raw, context).rules);
  }
  if (options.mode === 'strict') assertRequiredRules(rules);
  return {
    edition: context.edition,
    input: context.input,
    rules,
    unmatchedRules: rules.filter((rule) => rule.required && rule.status === 'unmatched'),
  };
}

export function isHarnessNativeSkillMarkdown(raw: string): boolean {
  return raw.includes('oil_ui_skill_status') && !raw.includes('check_update.sh');
}

export async function compileHarnessSkillTree(
  sourceRoot: string,
  targetRoot: string,
  options: { symlinkBinaryAssets?: boolean; mode?: TransformOptions['mode'] } = {},
) {
  const realSource = await realpath(sourceRoot);
  const report = await validateSkillTree(realSource, options);
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });

  async function walk(currentSource: string, relDir = ''): Promise<void> {
    const entries = await readdir(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (EXCLUDED_NAMES.has(entry.name) || DOC_ONLY_PATHS.has(relPath)) continue;
      if (!entry.isDirectory() && entry.name.endsWith('.pyc')) continue;

      const srcPath = await realpath(join(currentSource, entry.name));
      const relFromRoot = relative(realSource, srcPath);
      if (relFromRoot === '..' || relFromRoot.startsWith(`..${sep}`)) {
        throw new Error(`Skill entry escapes root: ${relPath}`);
      }
      const info = await stat(srcPath);
      const dstPath = join(targetRoot, ...relPath.split('/'));

      if (info.isDirectory()) {
        if (options.symlinkBinaryAssets && (relPath === 'assets' || relPath === 'scripts')) {
          await mkdir(dirname(dstPath), { recursive: true });
          await symlink(srcPath, dstPath, process.platform === 'win32' ? 'junction' : 'dir');
          continue;
        }
        await mkdir(dstPath, { recursive: true });
        await walk(srcPath, relPath);
        continue;
      }

      if (!info.isFile()) continue;
      await mkdir(dirname(dstPath), { recursive: true });
      if (entry.name.endsWith('.md')) {
        const raw = await readFile(srcPath, 'utf8');
        const transformed = transformSkillMarkdown(relPath, raw, { ...report, mode: options.mode });
        await writeFile(dstPath, transformed.markdown, 'utf8');
        await chmod(dstPath, info.mode & 0o777);
      } else {
        await copyFile(srcPath, dstPath);
        await chmod(dstPath, info.mode & 0o777);
      }
    }
  }

  await walk(realSource);
  // Ensure .gitignore is present if source had one
  const srcIgnore = join(realSource, '.gitignore');
  const hasIgnore = await lstat(srcIgnore).then(
    (i) => i.isFile(),
    () => false,
  );
  if (hasIgnore) {
    const dstIgnore = join(targetRoot, '.gitignore');
    await copyFile(srcIgnore, dstIgnore);
  }
  return report;
}
