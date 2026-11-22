import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesignWorkbench } from '../src/workbench/index.ts';
import { ManagedProcesses } from '../src/processes.ts';
import { skillStatus } from '../src/skill/upstream.ts';
import {
  DEFAULT_IMAGE_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  OilApiError,
  oilPreferencesPath,
  readOilImagePreference,
  requestOilApi,
  sanitizeErrorDetail,
} from '../src/oil-api.ts';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => {
    if (!fixture.home) throw new Error('Test HOME must be isolated');
    return fixture.home;
  },
}));

const project = fileURLToPath(new URL('..', import.meta.url));
const bundledImageScript = join(project, 'skills/oil-ui/scripts/oiloil-image.mjs');
const ACCOUNT_IMAGES_URL = 'https://ui.oiloil.org/account/?tab=images';
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const IMAGE_MOCK = `const fs=require('node:fs');const a=process.argv.slice(2);const value=k=>a[a.indexOf(k)+1];const out=value('--out');fs.writeFileSync(out,'local image fixture');console.log(JSON.stringify({outputs:[out],model:a.includes('--model')?value('--model'):'local-mock-model',size:value('--size'),args:a}));`;

let root: string;
const instances: DesignWorkbench[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-oil-contract-')));
  fixture.home = root;
  vi.stubEnv('DSH_HOME', join(root, '.dsh'));
  vi.stubEnv('DSH_AGENTS_HOME', '');
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('XDG_CONFIG_HOME', join(root, '.config'));
  vi.stubEnv('XDG_STATE_HOME', join(root, '.local/state'));
  vi.stubEnv('APPDATA', join(root, 'AppData', 'Roaming'));
  vi.stubEnv('OIL_NO_UPDATE_CHECK', '1');
  vi.stubEnv('OIL_UI_PRO_DIR', '');
  vi.stubEnv('OIL_UI_IMAGE_GEN_SCRIPT', '');
  vi.stubEnv('OIL_TOKEN', '');
  vi.stubEnv('OIL_API', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected real or unconfigured fetch: ${String(input)}`);
    }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fixture.home = '';
  for (const workbench of instances.splice(0)) await workbench.dispose();
  await rm(root, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function makeWorkbench(imageGenScript = join(root, 'missing-image-gen.py')) {
  const workbench = new DesignWorkbench(0, { preferPro: false, imageGenScript });
  instances.push(workbench);
  return workbench;
}

async function setupLocalImageGen() {
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const script = join(root, 'mock-image-gen.cjs');
  await writeFile(script, IMAGE_MOCK);
  const runCommand = ManagedProcesses.prototype.runCommand;
  vi.spyOn(ManagedProcesses.prototype, 'runCommand').mockImplementation(function (
    this: ManagedProcesses,
    executable,
    args,
    execCwd,
    timeoutMs,
    signal,
  ) {
    if (executable === 'python3') return runCommand.call(this, process.execPath, args, execCwd, timeoutMs, signal);
    return runCommand.call(this, executable, args, execCwd, timeoutMs, signal);
  });
  return { cwd, script, workbench: makeWorkbench(script) };
}

describe('bundled oiloil-image.mjs contract drift gate', () => {
  it('keeps plugin image and query timeouts >= bundled oiloil-image.mjs runtime defaults', async () => {
    const bundledCli = (await import(pathToFileURL(bundledImageScript).href)) as {
      parseArgs(argv: string[]): { opts: { timeout: number } };
      preferencesPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string;
    };
    const bundledImageTimeoutMs = bundledCli.parseArgs(['image', 'prompt']).opts.timeout;
    const bundledBalanceTimeoutMs = bundledCli.parseArgs(['balance']).opts.timeout;
    const bundledStatusTimeoutMs = bundledCli.parseArgs(['status', '00000000-0000-4000-8000-000000000000']).opts
      .timeout;

    for (const ms of [bundledImageTimeoutMs, bundledBalanceTimeoutMs, bundledStatusTimeoutMs]) {
      expect(Number.isInteger(ms) && ms > 0).toBe(true);
    }

    expect(DEFAULT_IMAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(bundledImageTimeoutMs);
    expect(DEFAULT_QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(bundledBalanceTimeoutMs);
    expect(DEFAULT_QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(bundledStatusTimeoutMs);

    for (const [platform, env, home] of [
      ['win32', { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming', XDG_CONFIG_HOME: 'C:\\ignored' }, 'C:\\Users\\Alice'],
      ['win32', {}, 'C:\\Users\\Alice'],
      ['linux', { XDG_CONFIG_HOME: '/custom/config' }, '/home/alice'],
      ['linux', {}, '/home/alice'],
      ['darwin', {}, '/Users/alice'],
    ] as const) {
      expect(oilPreferencesPath(env, platform, home)).toBe(bundledCli.preferencesPath(env, platform, home));
    }
  });

  it('passes DEFAULT_IMAGE_TIMEOUT_MS to AbortSignal.timeout for POST /images', async () => {
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    vi.stubEnv('OIL_TOKEN', 'image-token');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: 'req_timeout_check',
        image: { mime_type: 'image/png', data: PNG_BYTES.toString('base64') },
        size: '1K',
        usage: { credits: 1, balance: 99 },
      }),
    );

    const workbench = makeWorkbench();
    const result = await workbench.image(cwd, { prompt: 'Check timeout' });
    expect(result.ok).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_IMAGE_TIMEOUT_MS);
  });
});

describe('upstream error detail sanitization', () => {
  it('blocks English, Chinese, compound provider words, URLs, HTML, stacks, non-strings, and >160 chars', () => {
    const dirtySamples = [
      'OpenAI rejected prompt',
      'yir 上游报错',
      'YirTimeout 超时',
      'proxyYir 失败',
      'zenmux 渠道限流',
      'ZenMuxError 异常',
      'OpenAIError 失败',
      'GoogleError 异常',
      'ReplicateTimeout 超时',
      'MidjourneyError 失败',
      'anthropic 服务异常',
      'gemini 生图失败',
      'aigocode 限流',
      'vertexAI 不可用',
      'cloudflare 502 错误',
      'providerError 请求失败',
      'upstreamTimeout 异常',
      '上游报错',
      '模型服务限流',
      '供应商异常',
      '渠道维护中',
      '线路拥堵',
      '详见 https://internal.example/error',
      '读取 file:///etc/passwd 失败',
      '<html><body>504 错误</body></html>',
      '错误详情\\n堆栈信息',
      '失败\n换行内容',
      '报错 at handler (/app/index.js:12:3)',
      'ECONNRESET 连接中断',
    ];
    for (const sample of dirtySamples) {
      expect(sanitizeErrorDetail(sample), sample).toBe('');
    }
    for (const nonString of [null, undefined, 42, true, {}, ['中文']]) {
      expect(sanitizeErrorDetail(nonString)).toBe('');
    }
    expect(sanitizeErrorDetail('中'.repeat(161))).toBe('');
    expect(sanitizeErrorDetail('中'.repeat(160))).toBe('中'.repeat(160));
    expect(sanitizeErrorDetail('size 超出支持范围')).toBe('size 超出支持范围');
    expect(sanitizeErrorDetail('今日生图请求次数已达上限（100 次/24h）')).toBe(
      '今日生图请求次数已达上限（100 次/24h）',
    );
  });

  it('never leaks raw 5xx or unsafe 4xx details through OilApiError', async () => {
    vi.stubEnv('OIL_TOKEN', 'image-token');
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          request_id: 'req_0123abcd',
          error: { code: 'bad_request', message: 'ZenMuxError 上游渠道限流' },
        },
        400,
      ),
    );
    await expect(requestOilApi('/images', { method: 'POST', body: {} })).rejects.toMatchObject({
      name: 'OilApiError',
      status: 400,
      code: 'bad_request',
      requestId: 'req_0123abcd',
      detail: '',
      message: 'Oil API request failed (400).',
    });

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          request_id: 'req_0123abcd',
          error: { code: 'internal_error', message: '服务端内部中文详情 yir' },
        },
        500,
      ),
    );
    const err = await requestOilApi('/images', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OilApiError);
    expect((err as OilApiError).detail).toBe('');
    expect((err as OilApiError).message).toBe('Oil API request failed (500).');
  });
});

describe('structured 429, 5xx, transport, and caller abort handling in oilImage', () => {
  it('propagates caller abort before fetch (0 calls) and mid-flight without returning uncertain_status', async () => {
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    vi.stubEnv('OIL_TOKEN', 'image-token');
    const workbench = makeWorkbench();

    // Pre-aborted caller signal -> rejects immediately with 0 fetch calls
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(workbench.image(cwd, { prompt: 'Pre-aborted' }, preAborted.signal)).rejects.toThrow(
      'Tool invocation aborted',
    );
    await expect(requestOilApi('/credits', { signal: preAborted.signal })).rejects.toThrow('Tool invocation aborted');
    expect(fetch).not.toHaveBeenCalled();

    // Mid-flight caller abort -> propagates abort error instead of returning uncertain_status
    const inFlight = new AbortController();
    vi.mocked(fetch).mockImplementationOnce(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
          inFlight.abort();
        }),
    );
    await expect(workbench.image(cwd, { prompt: 'Mid-flight abort' }, inFlight.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('handles 429 rate_limit_exceeded, cost_budget_exceeded, and sanitized fallback with Retry-After', async () => {
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    vi.stubEnv('OIL_TOKEN', 'image-token');
    const workbench = makeWorkbench();

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          request_id: 'req_abcdef12',
          error: { code: 'rate_limit_exceeded', message: 'yir zenmux openai 429' },
        },
        429,
        { 'Retry-After': '30' },
      ),
    );
    const rateLimited = await workbench.image(cwd, { prompt: 'A poster' });
    expect(rateLimited).toMatchObject({
      ok: false,
      source: 'oiloil',
      outputFiles: [],
      reason: 'rate_limited',
      agentInstruction: 'oiloil 请求过于频繁（HTTP 429）（建议 30s 后重试），本次未收到图片且未扣费。请稍后重试。',
    });
    for (const forbidden of ['yir', 'zenmux', 'openai']) {
      expect(rateLimited.agentInstruction).not.toContain(forbidden);
    }

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          request_id: 'req_abcdef12',
          error: { code: 'cost_budget_exceeded', message: 'ZenMuxError budget hit' },
        },
        429,
      ),
    );
    const budgetExceeded = await workbench.image(cwd, { prompt: 'A poster' });
    expect(budgetExceeded).toMatchObject({
      ok: false,
      reason: 'rate_limited',
      agentInstruction: 'oiloil 当前生图额度已达上限（HTTP 429），本次未收到图片且未扣费。请稍后重试。',
    });
    expect(budgetExceeded.agentInstruction).not.toContain('ZenMuxError');

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { message: '今日生图请求次数已达上限（100 次/24h）' } }, 429, { 'Retry-After': '15' }),
    );
    const safeCustom = await workbench.image(cwd, { prompt: 'A poster' });
    expect(safeCustom).toMatchObject({
      ok: false,
      reason: 'rate_limited',
      agentInstruction:
        'oiloil 请求频率或额度受限（HTTP 429）：今日生图请求次数已达上限（100 次/24h）（建议 15s 后重试），本次未收到图片且未扣费。请稍后重试。',
    });

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: { message: 'aigocode 上游渠道限流' } }, 429));
    const dirtyCustom = await workbench.image(cwd, { prompt: 'A poster' });
    expect(dirtyCustom).toMatchObject({
      ok: false,
      reason: 'rate_limited',
      agentInstruction: 'oiloil 请求频率或额度受限（HTTP 429），本次未收到图片且未扣费。请稍后重试。',
    });
    for (const forbidden of ['aigocode', '上游', '渠道']) {
      expect(dirtyCustom.agentInstruction).not.toContain(forbidden);
    }
  });

  it('handles structured 504 timeout and 502 upstream_error with valid req_* as unbilled retryable failures', async () => {
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    vi.stubEnv('OIL_TOKEN', 'image-token');
    const workbench = makeWorkbench();

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          request_id: 'req_0123abcd',
          error: { code: 'timeout', message: 'yir zenmux openai aigocode provider upstream secret' },
        },
        504,
      ),
    );
    const timedOut = await workbench.image(cwd, { prompt: 'A poster' });
    expect(timedOut).toMatchObject({
      ok: false,
      source: 'oiloil',
      outputFiles: [],
      reason: 'timeout',
      agentInstruction: 'oiloil 生成超时（HTTP 504），本次未收到图片且未扣费。请稍后重试。',
    });
    for (const forbidden of ['yir', 'zenmux', 'openai', 'aigocode', 'provider', 'upstream']) {
      expect(timedOut.agentInstruction).not.toContain(forbidden);
    }

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          request_id: 'req_0123abcd',
          error: { code: 'upstream_error', message: 'ZenMuxError vertexAI 上游供应商故障' },
        },
        502,
      ),
    );
    const unavailable = await workbench.image(cwd, { prompt: 'A poster' });
    expect(unavailable).toMatchObject({
      ok: false,
      source: 'oiloil',
      outputFiles: [],
      reason: 'service_unavailable',
      agentInstruction: 'oiloil 服务暂时繁忙或不可用（HTTP 502），本次未收到图片且未扣费。请稍后重试。',
    });
    for (const forbidden of ['ZenMuxError', 'vertexAI', '上游', '供应商']) {
      expect(unavailable.agentInstruction).not.toContain(forbidden);
    }
  });

  it('returns uncertain_status with original idempotencyKey for 503, 500, unstructured 5xx, and transport timeouts', async () => {
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    vi.stubEnv('OIL_TOKEN', 'image-token');
    const workbench = makeWorkbench();

    const cases: Array<() => Promise<Response>> = [
      async () =>
        jsonResponse(
          { request_id: 'req_0123abcd', error: { code: 'unavailable', message: 'aigocode provider down' } },
          503,
        ),
      async () =>
        jsonResponse(
          { request_id: 'req_0123abcd', error: { code: 'internal_error', message: 'yir openai stack trace' } },
          500,
        ),
      async () =>
        new Response('<html><body>504 Gateway Time-out cloudflare zenmux</body></html>', {
          status: 504,
          headers: { 'Content-Type': 'text/html' },
        }),
      async () => jsonResponse({ error: { code: 'timeout', message: 'missing req id provider detail' } }, 504),
      async () =>
        jsonResponse({ request_id: 'bad-id', error: { code: 'upstream_error', message: 'invalid req id yir' } }, 502),
      async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      async () => {
        throw new TypeError('fetch failed: ECONNRESET yir.internal');
      },
    ];

    for (const responder of cases) {
      const callIndex = vi.mocked(fetch).mock.calls.length;
      vi.mocked(fetch).mockImplementationOnce(responder);
      const result = await workbench.image(cwd, { prompt: 'A poster' });
      const sentHeaders = vi.mocked(fetch).mock.calls[callIndex]?.[1]?.headers as Record<string, string>;
      const sentKey = sentHeaders['Idempotency-Key'];
      expect(sentKey).toMatch(/^[0-9a-f-]{36}$/i);
      expect(result).toMatchObject({
        ok: false,
        source: 'oiloil',
        outputFiles: [],
        reason: 'uncertain_status',
        idempotencyKey: sentKey,
      });
      expect(result.agentInstruction).toContain('无法确认本次是否扣费');
      expect(result.agentInstruction).toContain(sentKey);
      expect(result.agentInstruction).toContain(ACCOUNT_IMAGES_URL);
      expect(result.agentInstruction).toContain('不要直接重新生成');
      for (const forbidden of ['aigocode', 'provider', 'yir', 'openai', 'cloudflare', 'zenmux', 'ECONNRESET']) {
        expect(result.agentInstruction).not.toContain(forbidden);
      }
    }
  });
});

describe('preferences.json routing, capability bypass, fallback, and skillStatus parity', () => {
  it('safely degrades missing, corrupt, or invalid preferences.json to null without reading config.json', async () => {
    const prefPath = oilPreferencesPath();
    await mkdir(dirname(prefPath), { recursive: true });
    expect(await readOilImagePreference()).toBeNull();

    for (const raw of ['{broken', 'null', '[]', '"oiloil"', '{}', '{"image_tool":"other"}', '{"image_tool":42}']) {
      await writeFile(prefPath, raw);
      expect(await readOilImagePreference(), raw).toBeNull();
    }

    await writeFile(prefPath, JSON.stringify({ image_tool: 'oiloil', extra: true }));
    expect(await readOilImagePreference()).toBe('oiloil');

    await writeFile(prefPath, JSON.stringify({ image_tool: 'host' }));
    expect(await readOilImagePreference()).toBe('host');
  });

  it('prefers oiloil when image_tool is oiloil and token is present, and preserves original priority otherwise', async () => {
    const { cwd, workbench } = await setupLocalImageGen();
    const prefPath = oilPreferencesPath();
    await mkdir(dirname(prefPath), { recursive: true });
    vi.stubEnv('OIL_TOKEN', 'image-token');

    // Unset preference: keeps local image-gen priority
    const unsetResult = await workbench.image(cwd, { prompt: 'Unset pref', out: 'assets/unset.png' });
    expect(unsetResult).toMatchObject({ ok: true, source: 'image-gen' });
    expect(fetch).not.toHaveBeenCalled();

    // Explicit host preference: keeps local image-gen priority
    await writeFile(prefPath, JSON.stringify({ image_tool: 'host' }));
    const hostResult = await workbench.image(cwd, { prompt: 'Host pref', out: 'assets/host.png' });
    expect(hostResult).toMatchObject({ ok: true, source: 'image-gen' });
    expect(fetch).not.toHaveBeenCalled();

    // Explicit oiloil preference with token: routes to oiloil first
    await writeFile(prefPath, JSON.stringify({ image_tool: 'oiloil' }));
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: 'req_pref_oiloil',
        image: { mime_type: 'image/png', data: PNG_BYTES.toString('base64') },
        size: '1024x1024',
        usage: { credits: 1.5, balance: 18.5 },
      }),
    );
    const oiloilResult = await workbench.image(cwd, { prompt: 'Oiloil pref', out: 'assets/oiloil.png' });
    expect(oiloilResult).toMatchObject({ ok: true, source: 'oiloil' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps 1K/2K/4K size aliases on fallback and routes 402/401/no-token without modifying preferences.json', async () => {
    const { cwd, workbench } = await setupLocalImageGen();
    const prefPath = oilPreferencesPath();
    await mkdir(dirname(prefPath), { recursive: true });
    const prefContent = `${JSON.stringify({ image_tool: 'oiloil', preserved: 1 }, null, 2)}\n`;
    await writeFile(prefPath, prefContent);
    vi.stubEnv('OIL_TOKEN', 'image-token');

    // 402 insufficient_credits with size: '2K' -> maps to 2048x2048 and succeeds via local image-gen
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { code: 'insufficient_credits', message: '余额不足' } }, 402),
    );
    const fallback402 = await workbench.image(cwd, {
      prompt: 'Fallback 402 2K',
      size: '2K',
      out: 'assets/fallback-402.png',
    });
    expect(fallback402).toMatchObject({ ok: true, source: 'image-gen', size: '2048x2048' });
    expect(await readFile(prefPath, 'utf8')).toBe(prefContent);

    // 401 not_logged_in with size: '4K' -> maps to 3840x2160 and succeeds via local image-gen
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: { code: 'unauthorized' } }, 401));
    const fallback401 = await workbench.image(cwd, {
      prompt: 'Fallback 401 4K',
      size: '4K',
      out: 'assets/fallback-401.png',
    });
    expect(fallback401).toMatchObject({ ok: true, source: 'image-gen', size: '3840x2160' });
    expect(await readFile(prefPath, 'utf8')).toBe(prefContent);

    // No oiloil token with lowercase '1k' -> maps to 1024x1024 on local image-gen
    vi.stubEnv('OIL_TOKEN', '');
    const noTokenResult = await workbench.image(cwd, {
      prompt: 'No token 1k',
      size: '1k',
      out: 'assets/no-token.png',
    });
    expect(noTokenResult).toMatchObject({ ok: true, source: 'image-gen', size: '1024x1024' });
    expect(await readFile(prefPath, 'utf8')).toBe(prefContent);
  });

  it('routes local capability mismatches straight to image-gen with 0 HTTP calls, and never falls back on 429/5xx', async () => {
    const { cwd, workbench } = await setupLocalImageGen();
    const prefPath = oilPreferencesPath();
    await mkdir(dirname(prefPath), { recursive: true });
    const prefContent = `${JSON.stringify({ image_tool: 'oiloil' }, null, 2)}\n`;
    await writeFile(prefPath, prefContent);
    vi.stubEnv('OIL_TOKEN', 'image-token');

    await mkdir(join(cwd, 'assets'), { recursive: true });
    await writeFile(join(cwd, 'assets/ref-1.png'), PNG_BYTES);
    await writeFile(join(cwd, 'assets/ref-2.png'), PNG_BYTES);
    await writeFile(join(cwd, 'assets/ref-large.png'), Buffer.alloc(2 * 1024 * 1024 + 16, 1));

    // >1 reference images -> straight to local image-gen, 0 HTTP calls
    const multiRef = await workbench.image(cwd, {
      prompt: 'Combine two refs',
      images: ['assets/ref-1.png', 'assets/ref-2.png'],
      out: 'assets/multi-ref.png',
    });
    expect(multiRef).toMatchObject({ ok: true, source: 'image-gen', mode: 'edit' });

    // Explicit model -> straight to local image-gen, 0 HTTP calls
    const withModel = await workbench.image(cwd, {
      prompt: 'Custom model',
      model: 'custom-image-model',
      out: 'assets/with-model.png',
    });
    expect(withModel).toMatchObject({ ok: true, source: 'image-gen', model: 'custom-image-model' });

    // Reference image > 2 MiB -> straight to local image-gen, 0 HTTP calls
    const largeRef = await workbench.image(cwd, {
      prompt: 'Large reference',
      images: ['assets/ref-large.png'],
      out: 'assets/large-ref.png',
    });
    expect(largeRef).toMatchObject({ ok: true, source: 'image-gen', mode: 'edit' });
    expect(fetch).not.toHaveBeenCalled();

    // 429, structured 504/502, and 503 uncertain_status must NEVER fall back to local image-gen
    const runCallsBefore = vi.mocked(ManagedProcesses.prototype.runCommand).mock.calls.length;
    const nonFallbackCases: Array<{ response: Response; reason: string }> = [
      {
        response: jsonResponse({ request_id: 'req_0123abcd', error: { code: 'rate_limit_exceeded' } }, 429),
        reason: 'rate_limited',
      },
      {
        response: jsonResponse({ request_id: 'req_0123abcd', error: { code: 'timeout' } }, 504),
        reason: 'timeout',
      },
      {
        response: jsonResponse({ request_id: 'req_0123abcd', error: { code: 'upstream_error' } }, 502),
        reason: 'service_unavailable',
      },
      {
        response: jsonResponse({ request_id: 'req_0123abcd', error: { code: 'unavailable' } }, 503),
        reason: 'uncertain_status',
      },
    ];
    for (const { response, reason } of nonFallbackCases) {
      vi.mocked(fetch).mockResolvedValueOnce(response);
      const res = await workbench.image(cwd, { prompt: `No fallback ${reason}`, out: `assets/nf-${reason}.png` });
      expect(res).toMatchObject({ ok: false, source: 'oiloil', reason });
    }
    expect(vi.mocked(ManagedProcesses.prototype.runCommand).mock.calls.length).toBe(runCallsBefore);
    expect(await readFile(prefPath, 'utf8')).toBe(prefContent);
  });

  it('aligns skillStatus().imageSource with preferences.json when both image-gen and oiloil are available', async () => {
    const { script } = await setupLocalImageGen();
    const prefPath = oilPreferencesPath();
    await mkdir(dirname(prefPath), { recursive: true });
    vi.stubEnv('OIL_TOKEN', 'image-token');

    // Unset preference -> image-gen
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ balance: 50 }));
    const unsetStatus = await skillStatus(undefined, { preferPro: false, imageGenScript: script });
    expect(unsetStatus).toMatchObject({ imageGenAvailable: true, oilLoggedIn: true, imageSource: 'image-gen' });

    // Explicit host preference -> image-gen
    await writeFile(prefPath, JSON.stringify({ image_tool: 'host' }));
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ balance: 50 }));
    const hostStatus = await skillStatus(undefined, { preferPro: false, imageGenScript: script });
    expect(hostStatus).toMatchObject({ imageGenAvailable: true, oilLoggedIn: true, imageSource: 'image-gen' });

    // Explicit oiloil preference with valid login -> oiloil
    await writeFile(prefPath, JSON.stringify({ image_tool: 'oiloil' }));
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ balance: 50 }));
    const oiloilStatus = await skillStatus(undefined, { preferPro: false, imageGenScript: script });
    expect(oiloilStatus).toMatchObject({ imageGenAvailable: true, oilLoggedIn: true, imageSource: 'oiloil' });

    // Explicit oiloil preference when token is expired (401) -> falls back to image-gen
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: { code: 'unauthorized' } }, 401));
    const expiredStatus = await skillStatus(undefined, { preferPro: false, imageGenScript: script });
    expect(expiredStatus).toMatchObject({ imageGenAvailable: true, oilLoggedIn: false, imageSource: 'image-gen' });
  });
});
