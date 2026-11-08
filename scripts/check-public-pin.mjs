#!/usr/bin/env node

import path from 'node:path';
import { INSTALL_REPO } from '../src/skill/install.ts';
import { assertInstallRepoMatches } from './lib/skill-distribution.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/check-public-pin.mjs <public-skill-directory>');
await assertInstallRepoMatches(path.resolve(directory), INSTALL_REPO);
process.stdout.write('Public oil-cli pin matches the plugin.\n');
