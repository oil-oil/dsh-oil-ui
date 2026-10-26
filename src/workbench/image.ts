import { lstat, open, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveImageGenScript, type ImageGenOptions, type SkillOptions } from '../skill/upstream.ts';
import { OilApiError, readOilToken, requestOilApi, type OilImageResponse } from '../oil-api.ts';
import { timeout, type ManagedProcesses } from '../processes.ts';
import type { ImageRequest } from '../tool-requests.ts';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export interface ImageResult {
  ok: boolean;
  mode?: 'generate' | 'edit';
  outputFiles: string[];
  source?: 'image-gen' | 'oiloil';
  model?: string | null;
  size?: string;
  background?: unknown;
  data?: Record<string, unknown> | null;
  stdout?: string;
  stderr?: string;
  usage?: { credits: number; balance: number };
  reason?: string;
  agentInstruction?: string;
}

interface ImageDependencies {
  skillOptions: SkillOptions & ImageGenOptions;
  processes: ManagedProcesses;
  scopedPath(workspace: string, inputPath: string): Promise<string>;
  safeOutput(directory: string): Promise<void>;
}

export async function generateImage(
  workspace: string,
  input: ImageRequest,
  dependencies: ImageDependencies,
  signal?: AbortSignal,
): Promise<ImageResult> {
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('prompt must be nonempty');
  if (
    input.images !== undefined &&
    (!Array.isArray(input.images) || input.images.some((path) => typeof path !== 'string' || !path.trim()))
  ) {
    throw new Error('images must be local file paths');
  }
  const images = input.images ?? [];
  if (images.length > 16) throw new Error('At most 16 reference images are supported');
  const mode = input.mode ?? (images.length ? 'edit' : 'generate');
  if (!['generate', 'edit'].includes(mode)) throw new Error('mode must be generate or edit');
  if (mode === 'edit' && !images.length) throw new Error('edit requires 1–16 reference images');
  if (mode === 'generate' && images.length) throw new Error('Use edit mode with reference images');

  const script = await resolveImageGenScript({ ...dependencies.skillOptions, cwd: workspace });
  if (!script) return oilImage(workspace, input, mode, images, dependencies, signal);

  const size = input.size ?? '1024x1024';
  const dimensions = /^(\d+)x(\d+)$/.exec(size);
  if (
    size !== 'auto' &&
    (!dimensions || !dimensions.slice(1).every((n) => Number.isSafeInteger(Number(n)) && Number(n) > 0))
  ) {
    throw new Error('size must be auto or positive WIDTHxHEIGHT dimensions');
  }
  if (input.background !== undefined && !['auto', 'opaque', 'transparent'].includes(input.background)) {
    throw new Error('Invalid image background');
  }
  if (input.model !== undefined && !input.model.trim()) throw new Error('model must be nonempty');

  const timeoutMs = timeout(input.timeoutMs, 180_000);
  let out = await dependencies.scopedPath(workspace, input.out ?? 'assets/generated.png');
  if (!input.out && input.force !== true) {
    let suffix = 1;
    while (
      await lstat(out).then(
        () => true,
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return false;
          throw e;
        },
      )
    ) {
      out = await dependencies.scopedPath(workspace, `assets/generated-${suffix++}.png`);
    }
  }
  const extension = extname(out).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) throw new Error('out must be PNG, JPEG or WebP');
  if (input.background === 'transparent' && ['.jpg', '.jpeg'].includes(extension)) {
    throw new Error('Transparent backgrounds require PNG or WebP');
  }
  if (
    input.force !== true &&
    (await lstat(out).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    ))
  ) {
    throw new Error('Output already exists; enable force to overwrite');
  }

  const references: string[] = [];
  for (const image of images) {
    const path = await dependencies.scopedPath(workspace, image);
    if (!(await stat(path)).isFile()) throw new Error('Reference images must be local files');
    references.push(path);
  }

  await dependencies.safeOutput(dirname(out));
  const promptPath = join(dirname(out), `.prompt-${randomUUID()}.txt`);
  let promptCreated = false;
  try {
    const promptFile = await open(promptPath, 'wx', 0o600);
    promptCreated = true;
    try {
      await promptFile.writeFile(input.prompt);
    } finally {
      await promptFile.close();
    }
    const args = [script, mode, '--prompt-file', promptPath, '--out', out, '--size', size, '--json'];
    if (input.background) args.push('--background', input.background);
    if (input.model) args.push('--model', input.model.trim());
    if (input.force === true) args.push('--force');
    for (const reference of references) args.push('--image', reference);
    const result = await dependencies.processes.runCommand('python3', args, workspace, timeoutMs, signal);
    let data: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
      data = parsed as Record<string, unknown>;
    } catch {
      result.ok = false;
      result.stderr += '\nImage script returned invalid JSON';
    }
    const reported: unknown[] = [];
    for (const value of [data?.files, data?.outputs, data?.outputFiles])
      if (Array.isArray(value)) reported.push(...value);
    for (const key of ['saved', 'path', 'out', 'output']) if (typeof data?.[key] === 'string') reported.push(data[key]);
    const outputFiles: string[] = [];
    if (!reported.length && result.ok) reported.push(out);
    for (const entry of reported) {
      const value =
        typeof entry === 'string'
          ? entry
          : entry && typeof entry === 'object'
            ? ((entry as Record<string, unknown>).path ??
              (entry as Record<string, unknown>).saved ??
              (entry as Record<string, unknown>).file)
            : undefined;
      if (typeof value !== 'string') continue;
      const path = resolve(workspace, value);
      if (path !== out || outputFiles.includes(path)) continue;
      if (
        await lstat(path).then(
          (info) => info.isFile(),
          () => false,
        )
      )
        outputFiles.push(path);
    }
    return {
      ok: result.ok && outputFiles.length > 0,
      source: 'image-gen',
      mode,
      outputFiles,
      model: typeof data?.model === 'string' ? data.model : (input.model ?? null),
      size,
      background: input.background ?? data?.background ?? null,
      data,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    if (promptCreated) await rm(promptPath, { force: true });
  }
}

async function oilImage(
  workspace: string,
  input: ImageRequest,
  mode: 'generate' | 'edit',
  images: string[],
  dependencies: ImageDependencies,
  signal?: AbortSignal,
): Promise<ImageResult> {
  const token = await readOilToken();
  if (!token) {
    return {
      ok: false,
      outputFiles: [],
      reason: 'no_image_tool',
      agentInstruction:
        '没有可用的生图工具。合适的时候友好提示用户一次：可运行 `npx github:oil-oil/oil-cli login` 登录 oiloil 并在 https://ui.oiloil.org/account 充值，或自行配置生图工具；任务照常继续。',
    };
  }
  if (images.length > 1) {
    return {
      ok: false,
      outputFiles: [],
      reason: 'unsupported_reference_count',
      agentInstruction: 'oiloil 生图一次只支持一张参考图；请选择一张后重试，或调整提示词后继续。',
    };
  }
  if (input.model?.trim()) {
    return {
      ok: false,
      outputFiles: [],
      reason: 'unsupported_model_option',
      agentInstruction: 'oiloil 生图不支持指定模型；去掉 model 参数后重试，或继续其他任务。',
    };
  }

  const requestedSize = input.size ?? '1K';
  const size = requestedSize === 'auto' ? '1K' : requestedSize;
  if (!['1K', '2K', '4K'].includes(size) && !/^\d{3,4}x\d{3,4}$/.test(size)) {
    throw new Error('size must be 1K, 2K, 4K or supported WIDTHxHEIGHT dimensions');
  }

  let referenceImage: string | undefined;
  if (images.length === 1) {
    const reference = await dependencies.scopedPath(workspace, images[0]!);
    const info = await stat(reference);
    if (!info.isFile()) throw new Error('Reference images must be local files');
    if (info.size > 2 * 1024 * 1024) {
      return {
        ok: false,
        outputFiles: [],
        reason: 'reference_image_too_large',
        agentInstruction: 'oiloil 参考图上限为 2 MiB，请缩小图片后重试，或去掉参考图继续。',
      };
    }
    const mimeType = IMAGE_MIME_BY_EXTENSION[extname(reference).toLowerCase()];
    if (!mimeType) throw new Error('Reference images must be PNG, JPEG or WebP files');
    referenceImage = `data:${mimeType};base64,${(await readFile(reference)).toString('base64')}`;
  }

  let target = await dependencies.scopedPath(workspace, input.out ?? 'assets/generated.png');
  const explicitOutput = Boolean(input.out);
  const requestedExtension = extname(target).toLowerCase();
  if (explicitOutput && !IMAGE_MIME_BY_EXTENSION[requestedExtension]) {
    throw new Error('out must be PNG, JPEG or WebP');
  }
  if (
    input.force !== true &&
    explicitOutput &&
    (await lstat(target).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    ))
  ) {
    throw new Error('Output already exists; enable force to overwrite');
  }
  const requestedTarget = target;
  await dependencies.safeOutput(dirname(target));

  const prompt =
    input.background === 'transparent' && !/transparent|透明/i.test(input.prompt)
      ? `${input.prompt}\n请使用透明背景。`
      : input.prompt;
  let result: OilImageResponse;
  try {
    result = await requestOilApi<OilImageResponse>('/images', {
      method: 'POST',
      body: {
        prompt,
        size,
        quality: 'medium',
        ...(input.background && input.background !== 'auto' ? { background: input.background } : {}),
        ...(referenceImage ? { reference_image: referenceImage } : {}),
      },
      idempotencyKey: true,
      signal,
      token,
    });
  } catch (error) {
    if (error instanceof OilApiError && error.status === 402 && error.code === 'insufficient_credits') {
      return {
        ok: false,
        outputFiles: [],
        reason: 'insufficient_credits',
        agentInstruction:
          'oiloil 余额不足，本次生图未开始。合适的时候友好提示用户一次，可在 https://ui.oiloil.org/account 充值；任务照常继续。',
      };
    }
    if (error instanceof OilApiError && error.status === 401) {
      return {
        ok: false,
        outputFiles: [],
        reason: 'not_logged_in',
        agentInstruction:
          'oiloil 登录状态已失效，暂时没有可用的生图工具。合适的时候友好提示用户一次：可运行 `npx github:oil-oil/oil-cli login` 重新登录，并在 https://ui.oiloil.org/account 充值，或自行配置生图工具；任务照常继续。',
      };
    }
    throw error;
  }

  const extension = IMAGE_EXTENSION_BY_MIME[result.image?.mime_type];
  if (!extension || typeof result.image.data !== 'string') {
    throw new Error('Oil API returned an unsupported image format.');
  }
  const bytes = Buffer.from(result.image.data, 'base64');
  if (!bytes.length || bytes.toString('base64') !== result.image.data) {
    throw new Error('Oil API returned an empty or malformed image.');
  }
  if (explicitOutput) {
    const outputMime = IMAGE_MIME_BY_EXTENSION[requestedExtension];
    if (outputMime !== result.image.mime_type) {
      const stem = basename(requestedTarget, extname(requestedTarget));
      target = join(dirname(requestedTarget), `${stem}${extension}`);
    }
  } else {
    const base = 'assets/generated';
    target = await dependencies.scopedPath(workspace, `${base}${extension}`);
  }

  const canOverwriteRequestedPath = input.force === true && (!explicitOutput || target === requestedTarget);
  const actualExtension = extname(target);
  const actualStem = basename(target, actualExtension);
  let suffix = 1;
  while (true) {
    try {
      const handle = await open(target, canOverwriteRequestedPath ? 'w' : 'wx', 0o644);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || canOverwriteRequestedPath) throw error;
      target = await dependencies.scopedPath(
        workspace,
        join(relative(workspace, dirname(target)), `${actualStem}-${suffix++}${actualExtension}`),
      );
    }
  }
  return {
    ok: true,
    source: 'oiloil',
    mode,
    size: result.size,
    outputFiles: [target],
    usage: result.usage,
    agentInstruction: `本次生图扣除 ${result.usage.credits} 积分，剩余 ${result.usage.balance} 积分。图片已保存到 ${target}。`,
  };
}
