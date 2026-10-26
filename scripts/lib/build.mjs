import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

function run(command, args, root) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`)
}

export function runBuild(root, outDir) {
  const require = createRequire(path.join(root, 'package.json'))
  const tsdownPackage = require.resolve('tsdown/package.json')
  const cli = path.join(path.dirname(tsdownPackage), 'dist/run.mjs')
  const args = [cli]
  if (outDir) args.push('--out-dir', outDir)
  run(process.execPath, args, root)
}

export function runPnpm(root, args) {
  const executable = process.env.npm_execpath
  if (executable && /pnpm/i.test(path.basename(executable))) {
    run(process.execPath, [executable, ...args], root)
    return
  }
  run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, root)
}
