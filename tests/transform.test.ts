import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MARKDOWN_RULES,
  SkillTransformError,
  transformSkillMarkdown,
  validateSkillTree,
} from '../src/skill/transform.ts';

const execFileAsync = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const bundled = join(project, 'skills/oil-ui');
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'oil-transform-'));
  temporary.push(directory);
  return directory;
}

describe('declarative Markdown rewrite validation', () => {
  it('has unique readable IDs and explains every compatibility-only rule', () => {
    expect(new Set(MARKDOWN_RULES.map((rule) => rule.id)).size).toBe(MARKDOWN_RULES.length);
    for (const rule of MARKDOWN_RULES) {
      expect(rule.id).toMatch(/^[a-z][a-z.-]+$/);
      if (!rule.requiredIn.length) expect(rule.optionalReason).toBeTruthy();
    }
  });

  it('strictly validates every required rule in the bundled native tree without changing its contents', async () => {
    const report = await validateSkillTree(bundled, { mode: 'strict' });
    expect(report).toMatchObject({ edition: 'lite', input: 'native', unmatchedRules: [] });
    expect(report.rules.filter((rule) => rule.required).length).toBeGreaterThan(20);
    for (const file of new Set(MARKDOWN_RULES.map((rule) => rule.file))) {
      if (!existsSync(join(bundled, file))) continue;
      const raw = await readFile(join(bundled, file), 'utf8');
      if (file === 'SKILL.md') {
        expect(raw).toContain('## 完整版提示');
        expect(raw).toContain('recommendOnceNotice');
      }
      const result = transformSkillMarkdown(file, raw, { ...report, mode: 'strict' });
      expect(result.markdown, file).toBe(raw);
      expect(
        result.rules.filter((rule) => rule.required && rule.status === 'unmatched'),
        file,
      ).toEqual([]);
      expect(
        () => transformSkillMarkdown(file, raw.replaceAll('\n', '\r\n'), { ...report, mode: 'strict' }),
        `${file} with CRLF`,
      ).not.toThrow();
    }
  });

  it('rewrites lightweight UX dispatch paths without requiring them in older Skills', () => {
    const raw = '模板路径换成本 Skill 目录下的绝对路径。';
    const result = transformSkillMarkdown('references/ux-review.md', raw, { edition: 'lite', mode: 'strict' });
    expect(result.markdown).toContain('子 Agent 启动时系统提示词中已自动注入本目录');
    expect(result.rules.find((rule) => rule.id === 'ux-review.paths')).toMatchObject({
      required: false,
      status: 'matched',
    });
  });

  it('refuses Pro at both compiler entrypoints and keeps its original files untouched', async () => {
    const source = await tempDirectory();
    const original = '---\nname: oil-ui-pro\ndescription: Synthetic original\n---\nUse --frames unchanged.\n';
    await writeFile(join(source, 'SKILL.md'), original);
    await expect(validateSkillTree(source)).rejects.toThrow('Only public oil-ui Lite');
    expect(() => transformSkillMarkdown('SKILL.md', original, { edition: 'lite', mode: 'lenient' })).toThrow(
      'Only public oil-ui Lite',
    );
    for (const script of ['build-dsh-skill.mjs', 'vendor-oil-ui.mjs']) {
      const failure = await execFileAsync(process.execPath, [
        join(project, 'scripts', script),
        source,
        ...(script === 'build-dsh-skill.mjs' ? [join(source, 'output')] : []),
      ]).catch((error) => error);
      expect(failure.code).toBe(1);
      expect(failure.stderr).toMatch(/Only public oil-ui|Only the open-source oil-ui/);
    }
    expect(await readFile(join(source, 'SKILL.md'), 'utf8')).toBe(original);
  });

  it('keeps the one-time Pro recommendation in Lite after replacing its source copy', () => {
    const raw = '## 完整版提示\n\nLegacy recommendation copy.\n';
    const result = transformSkillMarkdown('SKILL.md', raw, { edition: 'lite', mode: 'lenient' });
    expect(result.markdown).toContain('## 完整版提示');
    expect(result.markdown).toContain('recommendOnceNotice');
    expect(result.markdown).toContain('仅当 `recommendOnceNotice` 非空时');
    expect(result.markdown).not.toContain('Legacy recommendation copy');
    expect(result.rules.find((rule) => rule.id === 'skill.pro-notice')).toMatchObject({
      required: true,
      matches: 1,
      status: 'matched',
    });
  });

  it('reports misses without throwing in lenient mode and counts global matches independently across calls', () => {
    const raw = '读 `--sheet`；再读 `--sheet`。';
    for (let i = 0; i < 2; i++) {
      const result = transformSkillMarkdown('references\\media.md', raw, { edition: 'lite', mode: 'lenient' });
      expect(result.markdown).toBe('读 `oil_ui_media` 的 `sheet: true`；再读 `oil_ui_media` 的 `sheet: true`。');
      expect(result.rules.find((rule) => rule.id === 'media.sheet')).toMatchObject({ matches: 2, status: 'matched' });
      expect(result.rules.filter((rule) => rule.status === 'unmatched').map((rule) => rule.id)).toEqual([
        'media.direction-source',
      ]);
    }
    expect(() => transformSkillMarkdown('references/media.md', raw, { edition: 'lite', mode: 'strict' })).toThrow(
      SkillTransformError,
    );
  });

  it('does not accept native replacement text as evidence in raw upstream input', () => {
    const raw = '`oil_ui_shoot` 的 `compare` 参数';
    expect(() =>
      transformSkillMarkdown('references/layout-and-viewport.md', raw, { edition: 'lite', mode: 'strict' }),
    ).toThrow('layout.compare (references/layout-and-viewport.md)');
    expect(
      transformSkillMarkdown('references/layout-and-viewport.md', raw, {
        edition: 'lite',
        input: 'native',
        mode: 'strict',
      }).rules[0],
    ).toMatchObject({ matches: 0, status: 'already-transformed' });
  });

  it.each(['默认 `390x844`', '不写时是手机 390x844'])('rewrites the default viewport wording: %s', (raw) => {
    const result = transformSkillMarkdown('references/tools.md', raw, { edition: 'lite' });
    expect(result.markdown).toBe('默认 `1440x900`');
    expect(result.rules.find((rule) => rule.id === 'tools.default-viewport')).toMatchObject({
      matches: 1,
      status: 'matched',
    });
  });

  it('keeps the core action when rewriting Lite direction imagery', () => {
    const raw =
      '把每个方向用三四行写给用户：它给人什么感觉，首屏长什么样，核心动作怎样完成，用什么字体和色彩，主视觉靠什么。';
    const result = transformSkillMarkdown('SKILL.md', raw, { edition: 'lite', mode: 'lenient' });
    expect(result.markdown).toContain('核心动作怎样完成');
    expect(result.markdown).toContain('oil_ui_image');
    expect(result.rules.find((rule) => rule.id === 'skill.direction-images')).toMatchObject({
      matches: 1,
      status: 'matched',
    });
  });

  it.each(['lite'] as const)('rewrites imagery for the single-direction flow: %s', (edition) => {
    const raw = '用三四行写清它给人什么感觉、首屏长什么样、核心动作怎样完成、字体、色彩和主视觉。';
    const result = transformSkillMarkdown('SKILL.md', raw, { edition, mode: 'lenient' });
    expect(result.markdown).toContain('oil_ui_image');
    expect(result.markdown).toContain('oil_ui_media');
  });

  it('rewrites Lite imagery and prototype guidance in the 0.27 exploration module', () => {
    const raw = [
      '先用三四行写清每个方向的感觉、首屏、核心动作、字体、色彩和主视觉，附上推荐及理由，再问用户。',
      '主视觉靠图的方向按 [素材](media.md) 生成一张，至多重新生成一次；页面已有专项候选流程时按专项，不重复增加生成批次。其余图位先用从页面取色的色块占着。',
    ].join('\n');
    const result = transformSkillMarkdown('references/task-explore.md', raw, { edition: 'lite', mode: 'lenient' });
    expect(result.markdown).toContain('oil_ui_image');
    expect(result.markdown).toContain('oil_ui_media');
    expect(result.markdown).toContain('其余图位用代码占位');
    expect(result.markdown).not.toContain('direction-concept.md');
    expect(result.rules.find((rule) => rule.id === 'skill.explore-prototype-images')).toMatchObject({ matches: 1 });
  });

  it.each([
    ['用 `--evidence` 一次取齐状态图。', '用 `oil_ui_shoot`（`evidence: true`） 一次取齐状态图。'],
    ['用 `--evidence` 给选定画面生成状态图。', '用 `oil_ui_shoot`（`evidence: true`） 给选定画面生成状态图。'],
  ])('rewrites evidence wording: %s', (raw, expected) => {
    const result = transformSkillMarkdown('references/tools.md', raw, { edition: 'lite', mode: 'lenient' });
    expect(result.markdown).toBe(expected);
    expect(result.rules.find((rule) => rule.id === 'tools.evidence.legacy')).toMatchObject({
      matches: 1,
      status: 'matched',
    });
  });

  it('rewrites the single-state mask flag for the native tool', () => {
    const result = transformSkillMarkdown('references/tools.md', '单状态需要遮字图时加 `--mask`。', {
      edition: 'lite',
      mode: 'lenient',
    });
    expect(result.markdown).toBe('单状态需要遮字图时设 `mask: true`。');
    expect(result.rules.find((rule) => rule.id === 'tools.evidence-mask')).toMatchObject({
      required: false,
      matches: 1,
      status: 'matched',
    });
  });

  it.each(['每个字段的写法和限制见生成器的 `--help`。', '其他字段写法见生成器的 `--help`。'])(
    'rewrites old and new explorer parameter help wording: %s',
    (raw) => {
      const result = transformSkillMarkdown('references/style-explorer.md', raw, { edition: 'lite', mode: 'lenient' });
      expect(result.markdown).toBe('字段与限制以 `oil_ui_explorer` 的参数说明及本页 manifest 示例为准。');
      expect(result.rules.find((rule) => rule.id === 'explorer.parameter-help')).toMatchObject({
        matches: 1,
        status: 'matched',
      });
    },
  );

  it.each([
    ['SKILL.md', 'run check_update.sh now', 'skill.fallback-update-check', 'oil_ui_skill_status'],
    ['SKILL.md', '`scripts/shoot.mjs`', 'skill.fallback-shoot', 'oil_ui_shoot'],
    ['SKILL.md', '`scripts/curate-media.mjs`', 'skill.fallback-media', 'oil_ui_media'],
    ['SKILL.md', '`scripts/build_explorer.py`', 'skill.fallback-explorer', 'oil_ui_explorer'],
    ['references/tools.md', '`node scripts/shoot.mjs target`', 'tools.fallback-shoot', 'oil_ui_shoot'],
    ['references/tools.md', '`node scripts/curate-media.mjs search wood`', 'tools.fallback-media', 'oil_ui_media'],
    [
      'references/reviewer-manual.md',
      '能用 `oil_ui_shoot` 时，用它出缩略图（`size: "480x300"` 或 `"180x390"`）和遮字图（`mask: true`），并用 `read_image` 查看截图。',
      'reviewer.legacy-thumbnail',
      '原比例缩放到 480px 或 180px',
    ],
  ])('retains and measures compatibility rule %s / %s', (file, raw, id, expected) => {
    const result = transformSkillMarkdown(file, raw, { edition: 'lite', mode: 'lenient' });
    expect(result.markdown).toContain(expected);
    expect(result.rules.find((rule) => rule.id === id)).toMatchObject({
      required: false,
      matches: 1,
      status: 'matched',
    });
  });

  it('aggregates changed wording and missing files, and both build entrypoints fail before publishing', async () => {
    const directory = await tempDirectory();
    const source = join(directory, 'source');
    await cp(bundled, source, { recursive: true });
    await rm(join(source, 'references/media.md'));
    await writeFile(join(source, 'references/layout-and-viewport.md'), '# changed upstream wording');
    const report = await validateSkillTree(source);
    expect(report.unmatchedRules.map((rule) => rule.id)).toEqual([
      'media.sheet',
      'media.direction-source',
      'layout.compare',
    ]);
    await expect(validateSkillTree(source, { mode: 'strict' })).rejects.toMatchObject({
      unmatchedRules: report.unmatchedRules,
    });

    // Run vendor in an isolated project so even a regression cannot overwrite the real bundle.
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await cp(join(project, 'scripts'), join(directory, 'scripts'), { recursive: true });
    await cp(join(project, 'src/skill'), join(directory, 'src/skill'), { recursive: true });
    await symlink(
      join(project, 'node_modules'),
      join(directory, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const target = join(directory, 'skills/oil-ui');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'sentinel'), 'previous build');
    for (const script of ['vendor-oil-ui.mjs', 'build-dsh-skill.mjs']) {
      const args = script === 'vendor-oil-ui.mjs' ? [source] : [source, target];
      const failure = await execFileAsync(process.execPath, [join(directory, 'scripts', script), ...args]).catch(
        (error) => error,
      );
      expect(failure.code, script).toBe(1);
      for (const rule of report.unmatchedRules) expect(failure.stderr, script).toContain(`${rule.id} (${rule.file})`);
      expect(await readFile(join(target, 'sentinel'), 'utf8')).toBe('previous build');
    }
  });
});
