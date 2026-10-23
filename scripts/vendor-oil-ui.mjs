#!/usr/bin/env node

import { parse } from 'yaml'
import { publicSkillFiles } from './public-skill-files.mjs'
import { transformSkillMarkdown, validateSkillTree } from '../src/transform.ts'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const skillsDirectory = path.resolve(scriptDirectory, '..', 'skills')
const destinationDirectory = path.join(skillsDirectory, 'oil-ui')
const manifestPath = path.join(skillsDirectory, 'oil-ui.manifest.json')
const excludedNames = new Set(['.git', '.DS_Store', '__pycache__'])
// Documentation-only artwork and duplicate English README are outside the 39-file runtime distribution.
const documentationOnly = new Set(['assets/readme', 'README.en.md'])

function usage() {
  process.stderr.write('Usage: node scripts/vendor-oil-ui.mjs <source-skill-directory>\n')
  process.exitCode = 2
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/')
}

function excluded(relativePath, name, isDirectory) {
  if (excludedNames.has(name) || documentationOnly.has(toPosix(relativePath))) return true
  return !isDirectory && name.endsWith('.pyc')
}

function versionFromSkill(markdown) {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!frontmatter) throw new Error('The source SKILL.md has no YAML frontmatter.')

  let inMetadata = false
  for (const line of frontmatter[1].split(/\r?\n/)) {
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true
      continue
    }
    if (inMetadata && /^[^\s#][^:]*:\s*/.test(line)) inMetadata = false
    if (!inMetadata) continue
    const version = line.match(/^\s+version:\s*["']?([^"'\s]+)["']?\s*$/)
    if (version) return version[1]
  }
  throw new Error('The source SKILL.md metadata does not declare a version.')
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function collectFiles(root, directory = root, relativeDirectory = '', ancestors = [], entries = [], exclusions = [], symlinks = []) {
  const realDirectory = await realpath(directory)
  if (!inside(root, realDirectory)) {
    throw new Error(`Source directory escaped the supplied root at ${toPosix(relativeDirectory || '.')}.`)
  }
  if (ancestors.includes(realDirectory)) {
    throw new Error(`A directory symlink cycle was found at ${toPosix(relativeDirectory || '.')}.`)
  }

  const rows = await readdir(directory, { withFileTypes: true })
  for (const row of rows) {
    const relativePath = relativeDirectory ? path.join(relativeDirectory, row.name) : row.name
    const absolutePath = path.join(directory, row.name)
    const linkInfo = await lstat(absolutePath)
    let resolvedPath = absolutePath
    let sourceKind = 'file'

    if (linkInfo.isSymbolicLink()) {
      resolvedPath = await realpath(absolutePath)
      if (!inside(root, resolvedPath)) {
        throw new Error(`A source symlink escapes the supplied root at ${toPosix(relativePath)}.`)
      }
      sourceKind = 'resolved-symlink'
      symlinks.push(toPosix(relativePath))
    } else {
      resolvedPath = await realpath(absolutePath)
      if (!inside(root, resolvedPath)) {
        throw new Error(`A source entry escapes the supplied root at ${toPosix(relativePath)}.`)
      }
    }

    const targetInfo = await stat(resolvedPath)
    const isDirectory = targetInfo.isDirectory()
    if (excluded(relativePath, row.name, isDirectory)) {
      exclusions.push({ path: toPosix(relativePath), reason: 'Excluded from the runtime distribution (repository metadata, caches or documentation-only files).' })
      continue
    }

    if (isDirectory) {
      await collectFiles(root, resolvedPath, relativePath, [...ancestors, realDirectory], entries, exclusions, symlinks)
      continue
    }
    if (!targetInfo.isFile()) {
      throw new Error(`Unsupported non-file entry at ${toPosix(relativePath)}.`)
    }

    entries.push({
      path: toPosix(relativePath),
      sourcePath: resolvedPath,
      size: targetInfo.size,
      mode: targetInfo.mode & 0o777,
      sha256: await sha256(resolvedPath),
      sourceKind,
    })
  }
  return { entries, exclusions, symlinks }
}

async function verifyCopy(root, entries) {
  const expected = new Map(entries.map(entry => [entry.path, entry]))
  const actualPaths = []

  async function visit(directory, relativeDirectory = '') {
    for (const row of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, row.name) : row.name
      const normalized = toPosix(relativePath)
      const absolutePath = path.join(directory, row.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) throw new Error(`The vendored tree contains a symlink at ${normalized}.`)
      if (info.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!info.isFile()) throw new Error(`The vendored tree contains a non-file entry at ${normalized}.`)
      actualPaths.push(normalized)
      const source = expected.get(normalized)
      if (!source) throw new Error(`Unexpected file in the vendored tree: ${normalized}.`)
      const targetInfo = await stat(absolutePath)
      if (targetInfo.size !== source.size) throw new Error(`Size mismatch after copying ${normalized}.`)
      if ((targetInfo.mode & 0o777) !== source.mode) throw new Error(`Mode mismatch after copying ${normalized}.`)
      // Hashes are offline manifest evidence only; do not turn them into a copy/install gate.
    }
  }

  await visit(root)
  actualPaths.sort()
  const expectedPaths = [...expected.keys()].sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('The vendored tree does not contain exactly the expected files.')
  }
}

async function main() {
  const sourceArgument = process.argv[2] ?? process.env.OIL_UI_REPO ?? path.resolve(scriptDirectory, '..', '..', 'oil-ui')
  if (!sourceArgument || sourceArgument.startsWith('--')) {
    usage()
    return
  }

  const sourceRoot = await realpath(path.resolve(sourceArgument))
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error('The supplied source must be a directory.')
  const sourceSkill = path.join(sourceRoot, 'SKILL.md')
  const raw = await readFile(sourceSkill, 'utf8')
  const identity = parse(raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1])
  if (identity.name !== 'oil-ui') throw new Error('Only the open-source oil-ui may be bundled.')
  const transformContext = await validateSkillTree(sourceRoot, { mode: 'strict' })
  const version = versionFromSkill(raw)
  const { entries, exclusions, symlinks } = await collectFiles(sourceRoot)
  if (entries.some(f => /^(references\/(direction-concept|direction-workspace|cards)\.md|assets\/cards(?:\/|$))/.test(f.path))) throw new Error('Pro-only resources cannot be bundled.')
  const actualPaths = entries.map(file => file.path).sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(publicSkillFiles)) throw new Error('Source paths differ from the reviewed 39-file public distribution. Review the public file list before syncing.')
  entries.sort((left, right) => left.path.localeCompare(right.path))

  await mkdir(skillsDirectory, { recursive: true })
  const stageDirectory = await mkdtemp(path.join(skillsDirectory, '.oil-ui-stage-'))
  const stagedManifest = path.join(skillsDirectory, `.oil-ui.manifest-${process.pid}.tmp`)
  let installed = false
  try {
    for (const entry of entries) {
      const targetPath = path.join(stageDirectory, ...entry.path.split('/'))
      await mkdir(path.dirname(targetPath), { recursive: true })
      if (entry.path.endsWith('.md')) {
        const raw = await readFile(entry.sourcePath, 'utf8')
        const compiled = transformSkillMarkdown(entry.path, raw, { ...transformContext, mode: 'strict' })
        const buf = Buffer.from(compiled.markdown, 'utf8')
        await writeFile(targetPath, buf)
        entry.size = buf.length
        entry.sha256 = createHash('sha256').update(buf).digest('hex')
      } else {
        await copyFile(entry.sourcePath, targetPath)
      }
      await chmod(targetPath, entry.mode)
    }

    const manifest = {
      name: 'oil-ui',
      version,
      source: {
        description: 'The source directory is supplied by the caller and is intentionally not recorded as a machine-specific path.',
        rootSymlinkResolved: true,
      },
      symlinkAudit: {
        checkedWithinSuppliedRoot: true,
        resolvedSourceSymlinks: symlinks,
        outputContainsSymlinks: false,
      },
      exclusions: {
        rules: [
          { name: '.git', reason: 'Repository metadata is not part of the Skill runtime.' },
          { name: '.DS_Store', reason: 'macOS Finder metadata is not part of the Skill runtime.' },
          { name: '__pycache__', reason: 'Python bytecode cache is not part of the Skill runtime.' },
          { name: '*.pyc', reason: 'Compiled Python bytecode is a regenerable cache.' },
          { name: 'assets/readme', reason: 'README showcase images are not runtime resources.' },
          { name: 'README.en.md', reason: 'Duplicate English README; README.md is retained.' },
        ],
        paths: exclusions.sort((left, right) => left.path.localeCompare(right.path)),
      },
      fileCount: entries.length,
      files: entries.map(({ path: filePath, size, mode, sha256: hash, sourceKind }) => ({
        path: filePath,
        sha256: hash,
        size,
        mode: `0${mode.toString(8).padStart(3, '0')}`,
        ...(sourceKind === 'resolved-symlink' ? { sourceKind } : {}),
      })),
    }

    await verifyCopy(stageDirectory, entries)
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })

    await mkdir(skillsDirectory, { recursive: true })
    const existing = await lstat(destinationDirectory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (existing?.isSymbolicLink()) throw new Error('The destination Skill directory must not be a symlink.')
    if (existing) await rm(destinationDirectory, { recursive: true, force: true })
    await rename(stageDirectory, destinationDirectory)
    installed = true
    await rename(stagedManifest, manifestPath)

    await verifyCopy(destinationDirectory, entries)
    process.stdout.write(`Vendored oil-ui ${version}: ${entries.length} files copied; ${exclusions.length} non-runtime paths excluded; ${symlinks.length} internal symlinks resolved.\n`)
  } finally {
    if (!installed) await rm(stageDirectory, { recursive: true, force: true }).catch(() => {})
    await rm(stagedManifest, { force: true }).catch(() => {})
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
