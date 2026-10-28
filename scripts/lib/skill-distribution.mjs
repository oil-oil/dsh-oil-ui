import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { publicSkillFiles } from '../public-skill-files.mjs'

export const excludedSkillNames = new Set(['.git', '.DS_Store', '__pycache__'])
export const documentationOnlySkillPaths = new Set(['assets/readme', 'README.en.md', '.github'])
export const skillExclusionRules = Object.freeze([
  { name: '.github', reason: 'Repository maintenance and CI configuration are not part of the Skill runtime.' },
  { name: '.git', reason: 'Repository metadata is not part of the Skill runtime.' },
  { name: '.DS_Store', reason: 'macOS Finder metadata is not part of the Skill runtime.' },
  { name: '__pycache__', reason: 'Python bytecode cache is not part of the Skill runtime.' },
  { name: '*.pyc', reason: 'Compiled Python bytecode is a regenerable cache.' },
  { name: 'assets/readme', reason: 'README showcase images are not runtime resources.' },
  { name: 'README.en.md', reason: 'Duplicate English README; README.md is retained.' },
])

const proOnlyPattern = /^(references\/(direction-concept|direction-workspace|cards)\.md|assets\/cards(?:\/|$))/

export function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

export function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/')
}

export function isExcludedSkillPath(relativePath, name, isDirectory) {
  if (excludedSkillNames.has(name) || documentationOnlySkillPaths.has(toPosix(relativePath))) return true
  return !isDirectory && name.endsWith('.pyc')
}

export function assertNoProResources(paths) {
  const blocked = paths.filter(filePath => proOnlyPattern.test(filePath))
  if (blocked.length) throw new Error(`Pro-only resources cannot be bundled: ${blocked.join(', ')}`)
}

export function assertPublicSkillFiles(paths, label = 'Skill tree') {
  const expected = [...publicSkillFiles].sort()
  if (new Set(publicSkillFiles).size !== publicSkillFiles.length) {
    throw new Error('The reviewed public Skill file list contains duplicates.')
  }
  const actual = [...paths].sort()
  if (new Set(actual).size !== actual.length) throw new Error(`${label} contains duplicate paths.`)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedSet = new Set(expected)
    const actualSet = new Set(actual)
    const missing = expected.filter(filePath => !actualSet.has(filePath))
    const unexpected = actual.filter(filePath => !expectedSet.has(filePath))
    throw new Error([
      `${label} differs from the reviewed ${expected.length}-file public distribution.`,
      missing.length ? `Missing: ${missing.join(', ')}` : '',
      unexpected.length ? `Unexpected: ${unexpected.join(', ')}` : '',
    ].filter(Boolean).join(' '))
  }
  return actual
}

export async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

export async function verifySkillEntries(root, entries) {
  const expected = new Map(entries.map(entry => [entry.path, entry]))
  const expectedPaths = assertPublicSkillFiles([...expected.keys()])
  assertNoProResources(expectedPaths)
  const actualPaths = []

  async function visit(directory, relativeDirectory = '') {
    for (const row of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, row.name) : row.name
      const normalized = toPosix(relativePath)
      const absolutePath = path.join(directory, row.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) throw new Error(`The Skill tree contains a symlink at ${normalized}.`)
      if (info.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!info.isFile()) throw new Error(`The Skill tree contains a non-file entry at ${normalized}.`)
      actualPaths.push(normalized)
      const source = expected.get(normalized)
      if (!source) throw new Error(`Unexpected file in the Skill tree: ${normalized}.`)
      const targetInfo = await stat(absolutePath)
      if (targetInfo.size !== source.size) throw new Error(`Size mismatch for ${normalized}.`)
      const expectedMode = typeof source.mode === 'string' ? Number.parseInt(source.mode, 8) : source.mode
      if (process.platform !== 'win32' && (targetInfo.mode & 0o777) !== expectedMode) {
        throw new Error(`Mode mismatch for ${normalized}.`)
      }
      if (typeof source.sha256 !== 'string' || await sha256(absolutePath) !== source.sha256) {
        throw new Error(`SHA-256 mismatch for ${normalized}.`)
      }
    }
  }

  await visit(root)
  actualPaths.sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths)
    const missing = expectedPaths.filter(filePath => !actual.has(filePath))
    throw new Error(`The Skill tree is missing expected files: ${missing.join(', ')}`)
  }
  return actualPaths
}

export async function verifySkillSnapshot(root, manifest) {
  if (!manifest || manifest.name !== 'oil-ui' || !Array.isArray(manifest.files)) {
    throw new Error('Invalid oil-ui Skill manifest.')
  }
  if (manifest.fileCount !== manifest.files.length || manifest.fileCount !== publicSkillFiles.length) {
    throw new Error(`Manifest fileCount must equal the reviewed ${publicSkillFiles.length}-file distribution.`)
  }
  const files = await verifySkillEntries(root, manifest.files)
  return { fileCount: files.length, files }
}
