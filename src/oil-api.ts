import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { win32, posix } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_API = 'https://api.oiloil.org';
export const DEFAULT_IMAGE_TIMEOUT_MS = 250_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
const OIL_REQUEST_ID_RE = /^req_[0-9a-f]+$/i;
const UNSAFE_DETAIL_RE =
  /(?:上游|模型服务|供应商|渠道|线路)|(?:yir|zenmux|openai|anthropic|gemini|aigocode|vertex|cloudflare|provider|upstream|google|replicate|midjourney)|(?:^|[^a-z])(?:traceback|stack|exception|syntaxerror|typeerror|referenceerror|econnreset|etimedout|enotfound|socket)(?:$|[^a-z])|(?:https?:|file:|at\s+\S+\s*\(|<\/?[a-z]|\\n)/i;

export type OilImagePreference = 'oiloil' | 'host';

export interface OilUsage {
  credits: number;
  balance?: number;
}

export interface OilImageResponse {
  id: string;
  image: {
    mime_type: string;
    data: string;
  };
  size: string;
  usage: OilUsage & { balance: number };
}

export interface OilApiErrorMeta {
  requestId?: string;
  retryAfter?: string;
  detail?: string;
}

export function sanitizeErrorDetail(message: unknown): string {
  if (typeof message !== 'string' || /[\r\n]/.test(message)) return '';
  const text = message.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 160 || !/[\u4e00-\u9fff]/.test(text) || UNSAFE_DETAIL_RE.test(text)) return '';
  return text;
}

export class OilApiError extends Error {
  readonly requestId: string | null;
  readonly retryAfter: string | null;
  readonly detail: string;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    meta: OilApiErrorMeta = {},
  ) {
    super(message);
    this.name = 'OilApiError';
    this.requestId =
      typeof meta.requestId === 'string' && OIL_REQUEST_ID_RE.test(meta.requestId) ? meta.requestId : null;
    const retryAfter = typeof meta.retryAfter === 'string' ? meta.retryAfter.trim() : '';
    this.retryAfter = /^\d+$/.test(retryAfter) ? retryAfter : null;
    this.detail = meta.detail ?? '';
  }
}

function oilConfigDir(env = process.env, platform = process.platform, home = homedir()) {
  const paths = platform === 'win32' ? win32 : posix;
  const root =
    platform === 'win32'
      ? env.APPDATA || paths.join(home, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || paths.join(home, '.config');
  return { paths, dir: paths.join(root, 'oil') };
}

/** Match oil CLI and the bundled image script on each platform. */
export function oilTokenConfigPath(env = process.env, platform = process.platform, home = homedir()): string {
  const { paths, dir } = oilConfigDir(env, platform, home);
  return paths.join(dir, 'config.json');
}

/** Match the bundled image script preferences file on each platform. */
export function oilPreferencesPath(env = process.env, platform = process.platform, home = homedir()): string {
  const { paths, dir } = oilConfigDir(env, platform, home);
  return paths.join(dir, 'preferences.json');
}

export async function readOilImagePreference(
  env = process.env,
  platform = process.platform,
  home = homedir(),
): Promise<OilImagePreference | null> {
  try {
    const raw = await readFile(oilPreferencesPath(env, platform, home), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!Object.hasOwn(record, 'image_tool')) return null;
    const value = record.image_tool;
    return value === 'oiloil' || value === 'host' ? value : null;
  } catch {
    return null;
  }
}

/** Uses the same login token as oil CLI; the config `api` field is intentionally ignored. */
export async function readOilToken(): Promise<string | null> {
  const envToken = process.env.OIL_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    const raw = await readFile(oilTokenConfigPath(), 'utf8');
    const config: unknown = JSON.parse(raw);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
    const token = (config as Record<string, unknown>).token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export function oilApiRoot(): string {
  return (process.env.OIL_API?.trim() || DEFAULT_API).replace(/\/+$/, '');
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: boolean | string;
  signal?: AbortSignal;
  timeoutMs?: number;
  token?: string;
}

export async function requestOilApi<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (options.signal?.aborted) throw new Error('Tool invocation aborted');
  const token = options.token ?? (await readOilToken());
  if (!token) throw new OilApiError(401, 'not_logged_in', '尚未登录 oiloil。');

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (typeof options.idempotencyKey === 'string' && options.idempotencyKey.trim()) {
    headers['Idempotency-Key'] = options.idempotencyKey.trim();
  } else if (options.idempotencyKey === true) {
    headers['Idempotency-Key'] = randomUUID();
  }
  const timeoutSignal = AbortSignal.timeout(
    options.timeoutMs ?? (options.method === 'POST' ? DEFAULT_IMAGE_TIMEOUT_MS : DEFAULT_QUERY_TIMEOUT_MS),
  );
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  const response = await fetch(`${oilApiRoot()}/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal,
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const record =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as { request_id?: unknown; error?: { code?: unknown; message?: unknown } })
        : undefined;
    const error =
      record?.error && typeof record.error === 'object' && !Array.isArray(record.error) ? record.error : undefined;
    const requestId =
      typeof record?.request_id === 'string' && OIL_REQUEST_ID_RE.test(record.request_id)
        ? record.request_id
        : undefined;
    const rawRetryAfter = response.headers.get('retry-after')?.trim();
    const retryAfter = rawRetryAfter && /^\d+$/.test(rawRetryAfter) ? rawRetryAfter : undefined;
    const detail = response.status < 500 ? sanitizeErrorDetail(error?.message) : '';
    throw new OilApiError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'api_error',
      detail || `Oil API request failed (${response.status}).`,
      { requestId, retryAfter, detail },
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Oil API returned an invalid JSON response.');
  }
  return payload as T;
}

export async function readOilCredits(token: string): Promise<number> {
  const result = await requestOilApi<{ balance: number }>('/credits', { token });
  if (typeof result.balance !== 'number' || !Number.isFinite(result.balance)) {
    throw new Error('Oil API returned an invalid credits balance.');
  }
  return result.balance;
}
