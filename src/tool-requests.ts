export interface ExplorerRequest {
  manifest?: unknown;
  out?: string;
  title?: string;
  brief?: string;
  request?: string;
}

export interface StitchItem {
  path: string;
  label?: string;
}

export interface ShootRequest {
  target?: string;
  out?: string;
  mode?: 'shot' | 'compare' | 'evidence';
  evidence?: boolean;
  size?: string;
  viewport?: string;
  states?: string | string[];
  param?: string;
  query?: string;
  zoom?: number | string | (number | string)[];
  fullPage?: boolean;
  mask?: boolean;
  sheet?: boolean;
  mark?: string;
  selector?: string;
  steps?: string | string[];
  record?: boolean | string;
  entry?: boolean;
  holdMs?: number;
  motion?: boolean | string;
  compare?: string;
  before?: string;
  after?: string;
  stitch?: (string | StitchItem)[];
  columns?: number;
  frames?: number | string;
  waitMs?: number;
  timeoutScale?: number;
  dryRun?: boolean;
  timeoutMs?: number;
}

export interface MediaRequest {
  action?: 'search' | 'preview' | 'fetch' | 'search_and_fetch';
  query?: string;
  refs?: string | string[];
  kind?: string;
  dir?: string;
  out?: string;
  use?: 'page' | 'reference' | 'all';
  limit?: number;
  sources?: string | string[];
  sheet?: boolean;
  maps?: string | string[];
  resolution?: string;
  videoSize?: string;
  note?: string;
  refresh?: boolean;
  timeoutMs?: number;
}

export interface ImageRequest {
  prompt: string;
  mode?: 'generate' | 'edit';
  out?: string;
  images?: string[];
  size?: string;
  quality?: 'auto' | 'low' | 'medium' | 'high';
  background?: 'auto' | 'opaque' | 'transparent';
  model?: string;
  force?: boolean;
  timeoutMs?: number;
}
