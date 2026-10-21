import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MARKDOWN_RULES, SkillTransformError, transformSkillMarkdown, validateSkillTree } from '../src/transform.ts';

const execFileAsync = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const bundled = join(project, 'skills/oil-ui');
const liteSource = join(project, '../oil-ui');
const proSource = join(project, '../oil-ui-pro-dev');
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'oil-transform-'));
  temporary.push(directory);
  return directory;
}

describe('declarative Markdown rewrite validation', () => {
  it('has unique readable IDs and explains every compatibility-only rule', () => {
    expect(new Set(MARKDOWN_RULES.map(rule => rule.id)).size).toBe(MARKDOWN_RULES.length);
    for (const rule of MARKDOWN_RULES) {
      expect(rule.id).toMatch(/^[a-z][a-z.-]+$/);
      if (!rule.requiredIn.length) expect(rule.optionalReason).toBeTruthy();
    }
  });

  it('strictly validates every required rule in the bundled native tree without changing its contents', async () => {
    const report = await validateSkillTree(bundled, { mode: 'strict' });
    expect(report).toMatchObject({ edition: 'lite', input: 'native', unmatchedRules: [] });
    expect(report.rules.filter(rule => rule.required).length).toBeGreaterThan(20);
    for (const file of new Set(MARKDOWN_RULES.map(rule => rule.file))) {
      if (!existsSync(join(bundled, file))) continue;
      const raw = await readFile(join(bundled, file), 'utf8');
      const result = transformSkillMarkdown(file, raw, { ...report, mode: 'strict' });
      expect(result.markdown, file).toBe(raw);
      expect(result.rules.filter(rule => rule.required && rule.status === 'unmatched'), file).toEqual([]);
      expect(() => transformSkillMarkdown(file, raw.replaceAll('\n', '\r\n'), { ...report, mode: 'strict' }), `${file} with CRLF`).not.toThrow();
    }
  });

  it.skipIf(!existsSync(proSource))('strictly validates the current local Pro source when installed', async () => {
    const report = await validateSkillTree(proSource, { mode: 'strict' });
    expect(report).toMatchObject({ edition: 'pro', input: 'upstream', unmatchedRules: [] });
    expect(report.rules.find(rule => rule.id === 'review-loop.paths')).toMatchObject({ required: true, status: 'matched' });
    expect(report.rules.find(rule => rule.id === 'skill.pro-notice')).toMatchObject({ required: false, status: 'unmatched' });
  });

  it.skipIf(!existsSync(liteSource))('strictly validates current Lite source and reproduces the bundled Markdown', async () => {
    const report = await validateSkillTree(liteSource, { mode: 'strict' });
    expect(report).toMatchObject({ edition: 'lite', input: 'upstream', unmatchedRules: [] });
    for (const file of new Set(MARKDOWN_RULES.map(rule => rule.file))) {
      if (!existsSync(join(liteSource, file))) continue;
      const result = transformSkillMarkdown(file, await readFile(join(liteSource, file), 'utf8'), { ...report, mode: 'strict' });
      expect(result.markdown, file).toBe(await readFile(join(bundled, file), 'utf8'));
    }
  });

  it('requires the Pro notice only in Lite and still reports its absence in Pro', async () => {
    const raw = (await readFile(join(bundled, 'SKILL.md'), 'utf8')).split('## 完整版提示')[0]!;
    const options = { input: 'native', mode: 'strict' } as const;
    const pro = transformSkillMarkdown('SKILL.md', raw, { ...options, edition: 'pro' });
    expect(pro.rules.find(rule => rule.id === 'skill.pro-notice')).toMatchObject({ required: false, status: 'unmatched' });
    expect(() => transformSkillMarkdown('SKILL.md', raw, { ...options, edition: 'lite' }))
      .toThrow('skill.pro-notice (SKILL.md)');
  });

  it('reports misses without throwing in lenient mode and counts global matches independently across calls', () => {
    const raw = '读 `--sheet`；再读 `--sheet`。';
    for (let i = 0; i < 2; i++) {
      const result = transformSkillMarkdown('references\\media.md', raw, { edition: 'pro', mode: 'lenient' });
      expect(result.markdown).toBe('读 `oil_ui_media` 的 `sheet: true`；再读 `oil_ui_media` 的 `sheet: true`。');
      expect(result.rules.find(rule => rule.id === 'media.sheet')).toMatchObject({ matches: 2, status: 'matched' });
      expect(result.rules.filter(rule => rule.status === 'unmatched').map(rule => rule.id)).toEqual(['media.curate', 'media.image']);
    }
    expect(() => transformSkillMarkdown('references/media.md', raw, { edition: 'pro', mode: 'strict' }))
      .toThrow(SkillTransformError);
  });

  it('does not accept native replacement text as evidence in raw upstream input', () => {
    const raw = '`oil_ui_shoot` 的 `compare` 参数';
    expect(() => transformSkillMarkdown('references/layout-and-viewport.md', raw, { edition: 'lite', mode: 'strict' }))
      .toThrow('layout.compare (references/layout-and-viewport.md)');
    expect(transformSkillMarkdown('references/layout-and-viewport.md', raw, { edition: 'lite', input: 'native', mode: 'strict' }).rules[0])
      .toMatchObject({ matches: 0, status: 'already-transformed' });
  });

  it.each(['默认 `390x844`', '不写时是手机 390x844'])('rewrites the default viewport wording: %s', raw => {
    const result = transformSkillMarkdown('references/tools.md', raw, { edition: 'lite' });
    expect(result.markdown).toBe('默认 `1440x900`');
    expect(result.rules.find(rule => rule.id === 'tools.default-viewport')).toMatchObject({ matches: 1, status: 'matched' });
  });

  it.each([
    ['SKILL.md', 'run check_update.sh now', 'skill.fallback-update-check', 'oil_ui_skill_status'],
    ['SKILL.md', '`scripts/shoot.mjs`', 'skill.fallback-shoot', 'oil_ui_shoot'],
    ['SKILL.md', '`scripts/curate-media.mjs`', 'skill.fallback-media', 'oil_ui_media'],
    ['SKILL.md', '`scripts/build_explorer.py`', 'skill.fallback-explorer', 'oil_ui_explorer'],
    ['references/tools.md', '`node scripts/shoot.mjs target`', 'tools.fallback-shoot', 'oil_ui_shoot'],
    ['references/tools.md', '`node scripts/curate-media.mjs search wood`', 'tools.fallback-media', 'oil_ui_media'],
    ['references/reviewer-manual.md', '能用 `oil_ui_shoot` 时，用它出缩略图（`size: "480x300"` 或 `"180x390"`）和遮字图（`mask: true`），并用 `read_image` 查看截图。', 'reviewer.legacy-thumbnail', '原比例缩放到 480px 或 180px'],
  ])('retains and measures compatibility rule %s / %s', (file, raw, id, expected) => {
    const result = transformSkillMarkdown(file, raw, { edition: 'pro', mode: 'lenient' });
    expect(result.markdown).toContain(expected);
    expect(result.rules.find(rule => rule.id === id)).toMatchObject({ required: false, matches: 1, status: 'matched' });
  });

  it('aggregates changed wording and missing files, and both build entrypoints fail before publishing', async () => {
    const directory = await tempDirectory();
    const source = join(directory, 'source');
    await cp(bundled, source, { recursive: true });
    await rm(join(source, 'references/media.md'));
    await writeFile(join(source, 'references/layout-and-viewport.md'), '# changed upstream wording');
    const report = await validateSkillTree(source);
    expect(report.unmatchedRules.map(rule => rule.id)).toEqual(['media.sheet', 'media.curate', 'media.image', 'layout.compare']);
    await expect(validateSkillTree(source, { mode: 'strict' })).rejects.toMatchObject({ unmatchedRules: report.unmatchedRules });

    // Run vendor in an isolated project so even a regression cannot overwrite the real bundle.
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    for (const file of ['vendor-oil-ui.mjs', 'public-skill-files.mjs', 'build-dsh-skill.mjs']) {
      await cp(join(project, 'scripts', file), join(directory, 'scripts', file));
    }
    await cp(join(project, 'src/transform.ts'), join(directory, 'src/transform.ts'));
    await symlink(join(project, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const target = join(directory, 'skills/oil-ui');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'sentinel'), 'previous build');
    for (const script of ['vendor-oil-ui.mjs', 'build-dsh-skill.mjs']) {
      const failure = await execFileAsync(process.execPath, [join(directory, 'scripts', script), source, target]).catch(error => error);
      expect(failure.code, script).toBe(1);
      for (const rule of report.unmatchedRules) expect(failure.stderr, script).toContain(`${rule.id} (${rule.file})`);
      expect(await readFile(join(target, 'sentinel'), 'utf8')).toBe('previous build');
    }
  });
});
