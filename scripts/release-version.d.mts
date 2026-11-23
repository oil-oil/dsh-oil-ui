export interface ReleaseVersionPlan {
  current: string;
  releaseVersion: string;
  nextDevVersion: string;
  releaseTag: string;
}

export interface SetPackageVersionResult {
  previousVersion: unknown;
  version: string;
  packageJsonPath: string;
}

export function assertValidVersion(version: string): string;
export function planReleaseVersion(current: string): ReleaseVersionPlan;
export function setPackageVersion(version: string, packageJsonPath?: string): Promise<SetPackageVersionResult>;
