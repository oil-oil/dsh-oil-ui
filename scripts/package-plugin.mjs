#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { publicSkillFiles } from './public-skill-files.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const snapshotDirectory = path.join(root, 'skills', 'oil-ui')
const manifestPath = path.join(root, 'skills', 'oil-ui.manifest.json')
const tarEnvironment = { ...process.env, COPYFILE_DISABLE: '1' }

function usage() {
  process.stdout.write('Usage: node scripts/package-plugin.mjs [output.tgz]\n')
  process.stdout.write('Default output: .work/<package-name>-<version>.tgz\n')
}

async function collectFiles(directory, relative = '') {
  const files = []
  for (const row of await readdir(directory, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${row.name}` : row.name
    const absolute = path.join(directory, row.name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`Unexpected symlink in archive tree: ${childRelative}`)
    if (info.isDirectory()) files.push(...await collectFiles(absolute, childRelative))
    else if (info.isFile()) files.push(childRelative)
    else throw new Error(`Unexpected non-file entry in archive tree: ${childRelative}`)
  }
  return files
}

async function verifyPackageTree(packageDirectory, expectedPaths, gitignoreBytes) {
  const skills = await readdir(path.join(packageDirectory, 'skills'))
  if (skills.sort().join(',') !== 'oil-ui,oil-ui.manifest.json') throw new Error('Unexpected packaged Skill tree.')
  const skillDirectory = path.join(packageDirectory, 'skills', 'oil-ui')
  const actualPaths = (await collectFiles(skillDirectory)).sort()
  const expected = [...expectedPaths].sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(expected)) {
    throw new Error(`Packaged Skill resource paths differ (expected ${expected.length}, found ${actualPaths.length}).`)
  }
  const packagedGitignore = await readFile(path.join(skillDirectory, '.gitignore'))
  if (!packagedGitignore.equals(gitignoreBytes)) {
    throw new Error('The packaged Skill .gitignore does not match the original snapshot bytes.')
  }
}

function verifyArchiveHasNoAppleDouble(archivePath) {
  const entries = execFileSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    env: tarEnvironment,
  }).split(/\r?\n/).filter(Boolean)
  const sidecar = entries.find(entry => entry.split('/').some(part => part.startsWith('._')))
  if (sidecar) throw new Error(`The package archive contains a macOS AppleDouble entry: ${sidecar}.`)
  return entries
}

async function main() {
  const outputArgument = process.argv[2]
  if (outputArgument === '--help' || outputArgument === '-h') {
    usage()
    return
  }
  const built = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  if (built.error) throw built.error
  if (built.status !== 0) throw new Error(`Build failed with exit code ${built.status}.`)
  const defaultOutput = path.join(root, '.work', `${packageJson.name}-${packageJson.version}.tgz`)
  const outputPath = path.resolve(outputArgument ?? defaultOutput)
  const outputDirectory = path.dirname(outputPath)
  const skillManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (skillManifest.name !== 'oil-ui' || skillManifest.fileCount !== 41) throw new Error('Expected the 41-file open-source oil-ui distribution.')
  const expectedPaths = skillManifest.files.map(file => file.path)
  if (expectedPaths.some(p => /^(references\/(direction-concept|direction-workspace|cards)\.md|assets\/cards(?:\/|$))/.test(p))) throw new Error('Pro resources cannot be packaged.')
  if (JSON.stringify([...expectedPaths].sort()) !== JSON.stringify(publicSkillFiles)) throw new Error('Only reviewed public Skill resource paths may be packaged.')
  const snapshotIgnore = path.join(snapshotDirectory, '.gitignore')
  const gitignoreBytes = await readFile(snapshotIgnore)
  const gitignoreMode = (await stat(snapshotIgnore)).mode & 0o777

  await mkdir(outputDirectory, { recursive: true })
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-oil-ui-package-'))
  const initialPack = path.join(temporaryDirectory, 'pnpm-pack.tgz')
  const unpackDirectory = path.join(temporaryDirectory, 'unpacked')
  const verifyDirectory = path.join(temporaryDirectory, 'verify')
  const stagedOutput = path.join(outputDirectory, `.${path.basename(outputPath)}.${process.pid}.tmp`)

  try {
    const packed = spawnSync('pnpm', ['pack', '--out', initialPack], { cwd: root, stdio: 'inherit' })
    if (packed.error) throw packed.error
    if (packed.status !== 0) throw new Error(`pnpm pack failed with exit code ${packed.status}.`)

    await mkdir(unpackDirectory, { recursive: true })
    execFileSync('tar', ['-xzf', initialPack, '-C', unpackDirectory], { stdio: 'inherit', env: tarEnvironment })
    const packageDirectory = path.join(unpackDirectory, 'package')
    const packagedIgnorePath = path.join(packageDirectory, 'skills', 'oil-ui', '.gitignore')
    await mkdir(path.dirname(packagedIgnorePath), { recursive: true })
    await writeFile(packagedIgnorePath, gitignoreBytes, { mode: gitignoreMode })
    await chmod(packagedIgnorePath, gitignoreMode)
    // npm normalizes executable bits; restore each original resource mode before the final tar.
    for (const file of skillManifest.files) {
      await chmod(path.join(packageDirectory, 'skills', 'oil-ui', file.path), file.mode)
    }
    await verifyPackageTree(packageDirectory, expectedPaths, gitignoreBytes)

    execFileSync('tar', ['-czf', stagedOutput, '-C', unpackDirectory, 'package'], { stdio: 'inherit', env: tarEnvironment })
    await mkdir(verifyDirectory, { recursive: true })
    const archiveEntries = verifyArchiveHasNoAppleDouble(stagedOutput)
    execFileSync('tar', ['-xzf', stagedOutput, '-C', verifyDirectory], { stdio: 'inherit', env: tarEnvironment })
    await verifyPackageTree(path.join(verifyDirectory, 'package'), expectedPaths, gitignoreBytes)

    await rename(stagedOutput, outputPath)
    process.stdout.write(`Created ${outputPath} with ${expectedPaths.length} oil-ui Skill resources and the original .gitignore; checked ${archiveEntries.length} total archive entries for AppleDouble sidecars.\n`)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {})
    await rm(stagedOutput, { force: true }).catch(() => {})
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
