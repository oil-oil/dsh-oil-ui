import { spawn, type ChildProcess } from 'node:child_process';
export interface ProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
}
export function timeout(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isInteger(ms) || ms < 1 || ms > 900_000)
    throw new Error('timeoutMs must be an integer between 1 and 900000');
  return ms;
}
export class ManagedProcesses {
  private active = new Set<ChildProcess>();
  private stopped = false;
  private kill(child: ChildProcess, signal: NodeJS.Signals) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* The owned process group may already have exited. */
    }
  }
  run(script: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
    return this.runCommand(process.execPath, [script, ...args], cwd, timeoutMs, signal);
  }
  runCommand(
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    if (this.stopped) throw new Error('Workbench is disposed');
    if (signal?.aborted) throw new Error('Tool invocation aborted');
    return new Promise((done, reject) => {
      const child = spawn(executable, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: false,
      });
      this.active.add(child);
      let stdout = '',
        stderr = '',
        timedOut = false,
        outputLimit = false,
        aborted = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        this.kill(child, 'SIGTERM');
        escalation ??= setTimeout(() => this.kill(child, 'SIGKILL'), 500);
      };
      const abort = () => {
        aborted = true;
        stop();
      };
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 4 * 1024 * 1024) {
          outputLimit = true;
          stop();
          return;
        }
        if (stream === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => capture(chunk, 'stdout'));
      child.stderr.on('data', (chunk) => capture(chunk, 'stderr'));
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        // Kill remaining descendants in this invocation's process group, never global browser processes.
        this.kill(child, 'SIGKILL');
        this.active.delete(child);
      };
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', (exitCode) => {
        cleanup();
        if (aborted) stderr += '\nTool invocation aborted';
        if (outputLimit) stderr += '\nProcess output exceeded 4 MiB';
        if (timedOut) stderr += `\nProcess timed out after ${timeoutMs}ms`;
        done({ ok: exitCode === 0 && !timedOut && !outputLimit && !aborted, stdout, stderr, timedOut, exitCode });
      });
    });
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    const children = [...this.active];
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((done) => {
            const timer = setTimeout(() => {
              this.kill(child, 'SIGKILL');
              done();
            }, 500);
            child.once('close', () => {
              clearTimeout(timer);
              done();
            });
            this.kill(child, 'SIGTERM');
          }),
      ),
    );
  }
}
