import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_API = 'https://api.oiloil.org';

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

export class OilApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OilApiError';
  }
}

/** Uses the same login token as oil CLI; the config `api` field is intentionally ignored. */
export async function readOilToken(): Promise<string | null> {
  const envToken = process.env.OIL_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    const raw = await readFile(join(homedir(), '.config', 'oil', 'config.json'), 'utf8');
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
  idempotencyKey?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  token?: string;
}

export async function requestOilApi<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = options.token ?? (await readOilToken());
  if (!token) throw new OilApiError(401, 'not_logged_in', '尚未登录 oiloil。');

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = randomUUID();
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? (options.method === 'POST' ? 120_000 : 10_000));
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
    const error =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as { error?: { code?: unknown; message?: unknown } }).error
        : undefined;
    throw new OilApiError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'api_error',
      typeof error?.message === 'string' ? error.message : `Oil API request failed (${response.status}).`,
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
