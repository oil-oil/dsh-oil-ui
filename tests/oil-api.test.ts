import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesignWorkbench } from '../src/workbench.ts';
import { readOilToken, requestOilApi } from '../src/oil-api.ts';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async original => ({ ...(await original<typeof import('node:os')>()), homedir: () => fixture.home }));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-oil-api-'));
  fixture.home = root;
  vi.stubEnv('OIL_TOKEN', '');
  vi.stubEnv('OIL_API', '');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`Unexpected real or unconfigured fetch: ${String(input)}`);
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('oiloil authentication and client requests', () => {
  it('prefers OIL_TOKEN, reads config token otherwise, and ignores the login-site api field', async () => {
    await mkdir(join(root, '.config', 'oil'), { recursive: true });
    await writeFile(join(root, '.config', 'oil', 'config.json'), JSON.stringify({ token: 'cli-token', api: 'https://login.example' }));
    expect(await readOilToken()).toBe('cli-token');
    vi.stubEnv('OIL_TOKEN', ' env-token ');
    expect(await readOilToken()).toBe('env-token');

    vi.stubEnv('OIL_API', 'https://custom-api.example/');
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ balance: 19 }));
    await expect(requestOilApi('/credits')).resolves.toEqual({ balance: 19 });
    expect(fetch).toHaveBeenCalledWith('https://custom-api.example/v1/credits', expect.objectContaining({
      headers: { Authorization: 'Bearer env-token' },
    }));
  });

});

describe('oiloil image fallback', () => {
  it('saves image bytes, sends a fresh idempotency key, and reports the charge and balance', async () => {
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    vi.stubEnv('OIL_TOKEN', 'image-token');
    vi.stubEnv('OIL_API', 'https://mock-api.example');
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      id: 'req_image',
      image: { mime_type: 'image/png', data: imageBytes.toString('base64') },
      size: '1024x1024',
      usage: { credits: 1.5, balance: 18.5 },
    }));
    const workbench = new DesignWorkbench(0, { preferPro: false, imageGenScript: join(root, 'missing-image-gen.py') });
    try {
      const result = await workbench.image(cwd, { prompt: 'A simple image', size: '1K' });
      expect(result).toMatchObject({
        ok: true,
        source: 'oiloil',
        size: '1024x1024',
        usage: { credits: 1.5, balance: 18.5 },
        agentInstruction: `本次生图扣除 1.5 积分，剩余 18.5 积分。图片已保存到 ${join(await realpath(cwd), 'assets/generated.png')}。`,
      });
      const output = result.outputFiles?.[0];
      expect(output).toBe(join(await realpath(cwd), 'assets/generated.png'));
      expect(await readFile(output!)).toEqual(imageBytes);
      const [url, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toBe('https://mock-api.example/v1/images');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer image-token' });
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i);
      expect(JSON.parse(String(init?.body))).toEqual({ prompt: 'A simple image', size: '1K', quality: 'medium' });
    } finally {
      await workbench.dispose();
    }
  });

  it('passes a transparent background through to oiloil instead of only rewording the prompt', async () => {
    const cwd = join(root, 'workspace');
    await mkdir(join(cwd, 'assets'), { recursive: true });
    vi.stubEnv('OIL_TOKEN', 'image-token');
    vi.stubEnv('OIL_API', 'https://mock-api.example');
    const imageBytes = Buffer.from('RIFF0000WEBPVP8L', 'ascii');
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      id: 'req_image_transparent',
      image: { mime_type: 'image/webp', data: imageBytes.toString('base64') },
      size: '1024x1024',
      usage: { credits: 1.5, balance: 18.5 },
    }));
    const workbench = new DesignWorkbench(0, { preferPro: false, imageGenScript: join(root, 'missing-image-gen.py') });
    try {
      await workbench.image(cwd, { prompt: 'A product cutout', out: 'assets/cutout.webp', background: 'transparent' });
      const [, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(JSON.parse(String(init?.body))).toMatchObject({ background: 'transparent' });
    } finally {
      await workbench.dispose();
    }
  });

  it('saves a charged image under the returned format and tells the agent the actual path', async () => {
    const cwd = join(root, 'workspace');
    await mkdir(join(cwd, 'assets'), { recursive: true });
    vi.stubEnv('OIL_TOKEN', 'image-token');
    vi.stubEnv('OIL_API', 'https://mock-api.example');
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 0xff, 0xd9]);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      id: 'req_image_jpeg',
      image: { mime_type: 'image/jpeg', data: imageBytes.toString('base64') },
      size: '1024x1024',
      usage: { credits: 2, balance: 16.5 },
    }));
    const workbench = new DesignWorkbench(0, { preferPro: false, imageGenScript: join(root, 'missing-image-gen.py') });
    try {
      const result = await workbench.image(cwd, { prompt: 'A product image', out: 'assets/product.png' });
      const actualPath = join(await realpath(cwd), 'assets/product.jpg');
      expect(result).toMatchObject({
        ok: true,
        source: 'oiloil',
        outputFiles: [actualPath],
        usage: { credits: 2, balance: 16.5 },
        agentInstruction: `本次生图扣除 2 积分，剩余 16.5 积分。图片已保存到 ${actualPath}。`,
      });
      expect(await readFile(actualPath)).toEqual(imageBytes);
      expect(await readFile(join(cwd, 'assets/product.png')).catch(() => null)).toBeNull();
      const [, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(JSON.parse(String(init?.body))).toEqual({ prompt: 'A product image', size: '1K', quality: 'medium' });
    } finally {
      await workbench.dispose();
    }
  });

  it('keeps a charged format-mismatched result when the corrected output path already exists', async () => {
    const cwd = join(root, 'workspace');
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await writeFile(join(cwd, 'assets/product.jpg'), 'existing image');
    vi.stubEnv('OIL_TOKEN', 'image-token');
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6, 0xff, 0xd9]);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      id: 'req_image_jpeg_collision',
      image: { mime_type: 'image/jpeg', data: imageBytes.toString('base64') },
      size: '1024x1024',
      usage: { credits: 2, balance: 14.5 },
    }));
    const workbench = new DesignWorkbench(0, { preferPro: false, imageGenScript: join(root, 'missing-image-gen.py') });
    try {
      const result = await workbench.image(cwd, { prompt: 'A product image', out: 'assets/product.png' });
      const actualPath = join(await realpath(cwd), 'assets/product-1.jpg');
      expect(result).toMatchObject({ ok: true, outputFiles: [actualPath], agentInstruction: expect.stringContaining(actualPath) });
      expect(await readFile(actualPath)).toEqual(imageBytes);
      expect(await readFile(join(cwd, 'assets/product.jpg'), 'utf8')).toBe('existing image');
    } finally {
      await workbench.dispose();
    }
  });

  it('returns guidance instead of throwing when no image tool or credits are available', async () => {
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const workbench = new DesignWorkbench(0, { preferPro: false, imageGenScript: join(root, 'missing-image-gen.py') });
    try {
      await expect(workbench.image(cwd, { prompt: 'Generate' })).resolves.toMatchObject({
        ok: false,
        reason: 'no_image_tool',
        agentInstruction: expect.stringContaining('任务照常继续'),
      });
      expect(fetch).not.toHaveBeenCalled();

      vi.stubEnv('OIL_TOKEN', 'image-token');
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: { code: 'insufficient_credits', message: '余额不足' } }, 402));
      await expect(workbench.image(cwd, { prompt: 'Generate' })).resolves.toMatchObject({
        ok: false,
        reason: 'insufficient_credits',
        agentInstruction: expect.stringContaining('本次生图未开始'),
      });
    } finally {
      await workbench.dispose();
    }
  });
});
