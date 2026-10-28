import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKDOWN_RULES, transformSkillMarkdown, validateSkillTree } from '../../src/skill/transform.ts';

const project = fileURLToPath(new URL('../../', import.meta.url));
const bundled = join(project, 'skills/oil-ui');
const liteSource = process.env.OIL_UI_SOURCE_DIR;

if (!liteSource) throw new Error('Set OIL_UI_SOURCE_DIR to an oil-ui checkout for integration tests.');
const resolvedLiteSource = resolve(liteSource);

describe('explicit upstream integration', () => {
  it('strictly validates the Lite source and reproduces the bundled Markdown', async () => {
    const report = await validateSkillTree(resolvedLiteSource, { mode: 'strict' });
    expect(report).toMatchObject({ edition: 'lite', input: 'upstream', unmatchedRules: [] });
    for (const file of new Set(MARKDOWN_RULES.map((rule) => rule.file))) {
      if (!existsSync(join(resolvedLiteSource, file))) continue;
      const result = transformSkillMarkdown(file, await readFile(join(resolvedLiteSource, file), 'utf8'), {
        ...report,
        mode: 'strict',
      });
      const bundledMarkdown = await readFile(join(bundled, file), 'utf8');
      if (file === 'references/style-explorer.md') {
        const outsideGeneratedSection = (markdown: string) =>
          markdown.replace(
            /## 生成和打开\r?\n[\s\S]*?(?=\r?\n(?:有本机地址候选时|## |$))/,
            '<generated-with-plugin-parameters>',
          );
        expect(outsideGeneratedSection(result.markdown), file).toBe(outsideGeneratedSection(bundledMarkdown));
        expect(result.markdown).toContain('改了候选后要重新调用生成');
      } else {
        expect(result.markdown, file).toBe(bundledMarkdown);
      }
    }
  });
});
