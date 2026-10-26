#!/usr/bin/env node

import path from 'node:path';
import { compileHarnessSkillTree } from '../src/skill/transform.ts';

async function main() {
  const sourceArg = process.argv[2];
  const targetArg = process.argv[3];
  if (!sourceArg || !targetArg || sourceArg.startsWith('--')) {
    process.stderr.write('Usage: node scripts/build-dsh-skill.mjs <source-skill-dir> <target-skill-dir>\n');
    process.exitCode = 2;
    return;
  }
  const sourceDir = path.resolve(sourceArg);
  const targetDir = path.resolve(targetArg);
  await compileHarnessSkillTree(sourceDir, targetDir, { mode: 'strict' });
  process.stdout.write(`Compiled DeepSeek Harness native Skill from ${sourceDir} -> ${targetDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
