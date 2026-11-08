export interface CliInvocation {
  command: string;
  args: string[];
}

export interface CliResolutionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodePath?: string;
}

export function nodeCliInvocation(entryPath: string, args?: string[], nodePath?: string): CliInvocation;
export function isNodeScript(filePath: string): boolean;
export function packageBinEntry(packageDirectory: string, requestedName: string): string;
export function pnpmInvocation(args: string[], options?: CliResolutionOptions): CliInvocation;
export function npmInvocation(npmExecPath: string, args: string[], options?: Omit<CliResolutionOptions, 'env'>): CliInvocation;
