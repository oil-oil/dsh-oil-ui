import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createServer, type Server } from 'node:http';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveActiveSkill, resolveImageGenScript, type ImageGenOptions, type SkillOptions } from './upstream.ts';
import { buildExplorer, defaultManifest, Embedder } from './explorer.ts';
import { ManagedProcesses, timeout } from './processes.ts';
import type { ExplorerRequest, ImageRequest, MediaRequest, ShootRequest } from './tool-requests.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

const KNOWN_KINDS = ['all', 'texture', 'design', 'photo', 'blueprint', 'map', 'plate', 'science', 'video'];
const KNOWN_SOURCES = ['polyhaven', 'vam', 'loc', 'wellcome', 'nasa', 'commons', 'met', 'aic', 'cleveland', 'japan', 'rijks'];

function isPrivateSegment(relPath: string): boolean {
  return relPath.split(/[\\/]/).some(
    part => part.startsWith('.') || /^(?:credentials?|secrets?|id_(?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$)/i.test(part),
  );
}

export class DesignWorkbench {
  readonly defaultRoot: string;
  private readonly port: number;
  private readonly skillOptions: SkillOptions & ImageGenOptions;
  private disposed = false;
  private servers = new Map<string, { server: Server; url: string }>();
  private pendingServers = new Map<string, Promise<string>>();
  private processes = new ManagedProcesses();

  constructor(
    defaultRootOrPort: string | number = '',
    portOrOptions: number | (SkillOptions & ImageGenOptions) = 0,
    skillOptions: SkillOptions & ImageGenOptions = {},
  ) {
    if (typeof defaultRootOrPort === 'number') {
      this.defaultRoot = process.cwd();
      this.port = defaultRootOrPort;
      this.skillOptions = typeof portOrOptions === 'object' && portOrOptions ? portOrOptions : {};
    } else {
      this.defaultRoot = defaultRootOrPort ? resolve(defaultRootOrPort) : process.cwd();
      this.port = typeof portOrOptions === 'number' ? portOrOptions : 0;
      this.skillOptions = skillOptions;
    }
  }

  async resolveWorkspace(cwd?: string): Promise<string> {
    if (this.disposed) throw new Error('Workbench is disposed');
    const target = resolve(cwd?.trim() || this.defaultRoot || process.cwd());
    await mkdir(target, { recursive: true });
    const real = await realpath(target);
    if (this.disposed) throw new Error('Workbench is disposed');
    return real;
  }

  async scopedPath(workspace: string, inputPath: string, allowDotFile = false): Promise<string> {
    if (!inputPath || !inputPath.trim() || inputPath.includes('\0')) {
      throw new Error('A valid workspace path is required');
    }
    const clean = inputPath.trim().replace(/\\/g, '/');
    const resolved = isAbsolute(clean) ? resolve(clean) : resolve(workspace, clean);

    // Resolve the deepest existing ancestor to verify no symlink escapes the workspace
    let ancestor = resolved;
    const suffix: string[] = [];
    while (true) {
      try {
        const realAncestor = await realpath(ancestor);
        const full = resolve(realAncestor, ...suffix);
        const rel = relative(workspace, full);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error('Path must remain within the current workspace');
        }
        if (rel && !allowDotFile && rel.split(sep).some(part => part === '..' || part.startsWith('.'))) {
          throw new Error('Use a workspace path without hidden segments');
        }
        let current = full;
        while (current !== workspace && dirname(current) !== current) {
          const info = await lstat(current).catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          });
          if (info?.isSymbolicLink()) throw new Error('Workspace paths cannot traverse symlinks');
          current = dirname(current);
        }
        return full;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
        suffix.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
      }
    }
  }

  private async safeOutput(directory: string): Promise<void> {
    let current = directory;
    while (dirname(current) !== current) {
      const info = await lstat(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (info?.isSymbolicLink()) throw new Error('Output paths cannot traverse symlinks');
      current = dirname(current);
    }
    await mkdir(directory, { recursive: true });
  }

  private async collectFiles(directory: string, prefix = ''): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    const paths: string[] = [];
    for (const item of entries) {
      if (item.name.startsWith('.') || item.isSymbolicLink() || item.name === 'node_modules') continue;
      const name = prefix + item.name;
      if (item.isDirectory()) paths.push(...(await this.collectFiles(join(directory, item.name), `${name}/`)));
      else if (item.isFile()) paths.push(name);
    }
    return paths.sort();
  }

  private async script(name: string, cwd?: string): Promise<string> {
    const active = await resolveActiveSkill({ ...this.skillOptions, cwd });
    const scriptRoot = active.sourceDirectory ?? active.directory;
    const path = await realpath(join(scriptRoot, 'scripts', name));
    const rel = relative(scriptRoot, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Skill script cannot escape its installation');
    if (!(await stat(path)).isFile()) throw new Error('Skill script is missing');
    return path;
  }

  async preview(cwd?: string): Promise<string> {
    const workspace = await this.resolveWorkspace(cwd);
    const existing = this.servers.get(workspace);
    if (existing) return existing.url;
    const pending = this.pendingServers.get(workspace);
    if (pending) return pending;

    const promise = this.startServer(workspace);
    this.pendingServers.set(workspace, promise);
    try {
      return await promise;
    } finally {
      this.pendingServers.delete(workspace);
    }
  }

  private async startServer(workspace: string): Promise<string> {
    const server = createServer(async (req, res) => {
      try {
        if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
          res.writeHead(405).end();
          return;
        }
        const rawPath = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
        const relPath = rawPath.replace(/^\/+/, '') || 'index.html';
        if (isPrivateSegment(relPath)) {
          res.writeHead(404).end();
          return;
        }
        let target = await this.scopedPath(workspace, relPath);
        const info = await stat(target).catch(() => null);
        if (info?.isDirectory()) {
          target = await this.scopedPath(workspace, `${relPath.replace(/\/+$/, '')}/index.html`);
        }
        const fileInfo = await stat(target);
        if (!fileInfo.isFile()) { res.writeHead(404).end(); return; }
        let start = 0, end = fileInfo.size - 1;
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'content-range': `bytes */${fileInfo.size}` }).end(); return; }
          if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
          else start = Math.max(0, fileInfo.size - Number(match[2]));
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= fileInfo.size) {
            res.writeHead(416, { 'content-range': `bytes */${fileInfo.size}` }).end(); return;
          }
        }
        const ext = extname(target).toLowerCase();
        const isExplorer = basename(target) === 'style-explorer.html' || basename(target) === 'explorer.html';
        res.writeHead(range ? 206 : 200, {
          'accept-ranges': 'bytes',
          'content-length': Math.max(0, end - start + 1),
          ...(range ? { 'content-range': `bytes ${start}-${end}/${fileInfo.size}` } : {}),
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': isExplorer
            ? "frame-ancestors 'none'"
            : "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; media-src 'self' data: blob: https:; connect-src 'self' https:; frame-ancestors 'none'",
        });
        if (req.method === 'HEAD') res.end();
        else if (!fileInfo.size) res.end();
        else await pipeline(createReadStream(target, { start, end }), res);
      } catch {
        if (!res.headersSent) res.writeHead(404).end();
        else res.destroy();
      }
    });

    const listenPort = this.servers.size === 0 ? this.port : 0;
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(listenPort, '127.0.0.1', () => {
        server.off('error', fail);
        done();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Preview server did not bind');
    const url = `http://127.0.0.1:${address.port}`;
    this.servers.set(workspace, { server, url });
    return url;
  }

  async explorer(cwd: string, input: ExplorerRequest = {}) {
    const workspace = await this.resolveWorkspace(cwd);
    const embedder = new Embedder(workspace);
    let manifest: unknown = input.manifest;
    let manifestDir = workspace;
    let manifestFilePath: string | null = null;

    if (typeof manifest === 'string') {
      const trimmed = manifest.trim();
      if (trimmed.startsWith('{')) {
        manifest = JSON.parse(trimmed);
      } else {
        manifestFilePath = await this.scopedPath(workspace, trimmed);
        manifestDir = dirname(manifestFilePath);
        manifest = JSON.parse(await readFile(manifestFilePath, 'utf8'));
      }
    } else if (manifest === undefined) {
      for (const candidate of ['manifest.json', 'directions/manifest.json', 'explore/manifest.json']) {
        try {
          const p = await this.scopedPath(workspace, candidate);
          if ((await stat(p)).isFile()) {
            manifestFilePath = p;
            manifestDir = dirname(p);
            manifest = JSON.parse(await readFile(p, 'utf8'));
            break;
          }
        } catch {
          // Continue searching
        }
      }
      if (manifest === undefined) {
        manifest = await defaultManifest({
          title: input.title?.trim() || basename(workspace) || 'Design Exploration',
          request: input.brief?.trim() || input.request?.trim() || 'Compare candidate directions side by side',
          directory: workspace,
        }, embedder);
        const firstSource = String((manifest as { candidates?: { source?: string }[] }).candidates?.[0]?.source ?? '').replace(/\\/g, '/');
        if (firstSource.startsWith('directions/')) manifestDir = join(workspace, 'directions');
        else if (firstSource.startsWith('explore/')) manifestDir = join(workspace, 'explore');
      }
    }

    const outPath = await this.scopedPath(workspace, input.out ?? 'style-explorer.html');
    await this.safeOutput(dirname(outPath));

    const active = await resolveActiveSkill({ ...this.skillOptions, cwd: workspace });
    const html = await buildExplorer(manifest, workspace, active, manifestDir, outPath, embedder);

    if (!manifestFilePath) {
      await this.safeOutput(manifestDir);
      manifestFilePath = await this.scopedPath(workspace, join(manifestDir, 'manifest.json'));
      await writeFile(manifestFilePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    await writeFile(outPath, html, 'utf8');

    const explorerPath = relative(workspace, outPath).split(sep).join('/');
    const baseUrl = await this.preview(workspace);
    const explorerUrl = `${baseUrl}/${explorerPath.split('/').map(encodeURIComponent).join('/')}`;
    return {
      ok: true,
      explorerPath,
      outputPath: outPath,
      manifestPath: relative(workspace, manifestFilePath).split(sep).join('/'),
      explorerUrl,
      message: '已生成风格对比页 style-explorer.html。',
    };
  }

  private validateSizeToken(raw: string): string {
    const tokens = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!tokens.length) throw new Error('viewport/size must be desktop, mobile, phone, or WIDTHxHEIGHT');
    for (const token of tokens) {
      if (['desktop', 'mobile', 'phone'].includes(token.toLowerCase())) continue;
      const m = /^(\d+)[xX](\d+)$/.exec(token);
      if (!m || ![m[1], m[2]].every(n => Number(n) > 0 && Number(n) <= 16384)) {
        throw new Error('viewport/size must be desktop, mobile, phone, or WIDTHxHEIGHT (1..16384)');
      }
    }
    return tokens.map(token => token.toLowerCase()).join(',');
  }

  async shoot(cwd: string, input: ShootRequest = {}, signal?: AbortSignal) {
    const workspace = await this.resolveWorkspace(cwd);
    const mode = input.mode ?? (input.evidence ? 'evidence' : input.compare || input.before ? 'compare' : 'shot');
    if (!['shot', 'compare', 'evidence'].includes(mode)) {
      throw new Error('mode must be shot, compare or evidence');
    }
    const timeoutMs = timeout(input.timeoutMs, 90_000);
    const sizeStr = this.validateSizeToken(input.size ?? input.viewport ?? '1440x900');

    if (input.waitMs !== undefined && (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 120_000)) {
      throw new Error('waitMs must be between 0 and 120000');
    }
    if (input.holdMs !== undefined && (!Number.isInteger(input.holdMs) || input.holdMs < 0 || input.holdMs > 120_000)) {
      throw new Error('holdMs must be between 0 and 120000');
    }
    if (input.selector !== undefined && (!input.selector.trim() || /[\r\n;]/.test(input.selector))) {
      throw new Error('selector must be a single nonempty selector');
    }
    const compareRef = input.compare ?? input.before;
    if (mode === 'compare' && !compareRef && !input.stitch?.length) {
      throw new Error('compare requires compare (or before) reference image');
    }

    const bool = (value: boolean | string | undefined) => value !== undefined && value !== false && value !== 'false' && value !== '0' && value !== '';
    const record = bool(input.record), motion = bool(input.motion);
    let batchTargets = false;
    const targets: string[] = [];
    let previewTarget: string | undefined;
    if (!input.stitch?.length && !(mode === 'compare' && compareRef && input.after)) {
      batchTargets = Array.isArray(input.target);
      const rawTarget = Array.isArray(input.target) ? input.target : (input.target ?? 'index.html').trim();
      const rawTargets = Array.isArray(rawTarget) ? rawTarget :
        !/^https?:\/\//i.test(rawTarget) && rawTarget.split(',').every(p => /\.html?$/i.test(p.trim()))
          ? rawTarget.split(',') : [rawTarget];
      if (!rawTargets.length) throw new Error('Provide target HTML file or URL');
      batchTargets ||= rawTargets.length > 1;
      for (const target of rawTargets) {
        const trimmed = target.trim();
        if (!trimmed) throw new Error('Provide target HTML file or URL');
        if (/^https?:\/\//i.test(trimmed)) {
          const url = new URL(trimmed);
          if (url.username || url.password) throw new Error('Target URL cannot contain credentials');
          targets.push(trimmed);
          continue;
        }
        const match = /^([^?#]*)(.*)$/.exec(trimmed);
        const filePart = match?.[1] || 'index.html';
        const suffix = match?.[2] || '';
        const resolvedTarget = await this.scopedPath(workspace, filePart);
        const targetStat = await stat(resolvedTarget).catch(() => null);
        if (!targetStat) throw new Error(`Target file not found: ${filePart}`);
        if (targetStat.isDirectory()) {
          const hasManifest = await stat(join(resolvedTarget, 'manifest.json')).then(() => true, () => false);
          const hasIndex = await stat(join(resolvedTarget, 'index.html')).then(info => info.isFile(), () => false);
          batchTargets ||= hasManifest || !hasIndex;
        } else {
          batchTargets ||= basename(resolvedTarget).toLowerCase() === 'manifest.json';
        }
        targets.push(`${resolvedTarget}${suffix}`);
        previewTarget = relative(workspace, targetStat.isDirectory() ? join(resolvedTarget, 'index.html') : resolvedTarget)
          .split(sep).map(encodeURIComponent).join('/') + suffix;
      }
    }
    const multiOutput = batchTargets || mode === 'evidence' || input.evidence || sizeStr.includes(',') ||
      Boolean(Array.isArray(input.states) ? input.states.length : input.states?.trim()) || record || motion ||
      Boolean(input.zoom !== undefined && String(input.zoom).includes(','));
    const defaultOut = mode === 'evidence' ? 'evidence' : multiOutput ? 'shots' : 'shots/desktop.png';
    const requestedOut = input.out ?? defaultOut;
    const outResolved = await this.scopedPath(workspace, requestedOut);
    const isSinglePngOut = extname(outResolved).toLowerCase() === '.png';

    if (isSinglePngOut && multiOutput) throw new Error('Multiple screenshots/recordings require a directory out instead of a single PNG');

    if (isSinglePngOut) {
      await this.safeOutput(dirname(outResolved));
      if ((await lstat(outResolved).catch(() => null))?.isSymbolicLink()) {
        throw new Error('Output cannot be a symlink');
      }
    } else {
      if (extname(outResolved) !== '') {
        throw new Error('out must be a PNG file path (e.g. shots/desktop.png) or a directory path (e.g. shots)');
      }
      await this.safeOutput(outResolved);
    }

    const runOutDir = isSinglePngOut
      ? join(dirname(outResolved), `.shoot-tmp-${randomUUID()}`)
      : outResolved;
    if (isSinglePngOut) await mkdir(runOutDir, { recursive: true });

    const localFile = async (p: string) => {
      const resolved = await this.scopedPath(workspace, p);
      if (!(await stat(resolved)).isFile()) throw new Error(`Input must be an existing local file: ${p}`);
      return resolved;
    };

    try {
      const args: string[] = [];
      if (input.stitch?.length) {
        for (const item of input.stitch) {
          if (typeof item === 'string') {
            args.push('--stitch', await localFile(item));
          } else {
            args.push('--stitch', await localFile(item.path));
            if (item.label) args.push('--label', item.label);
          }
        }
        if (input.columns !== undefined) args.push('--columns', String(input.columns));
      } else if (mode === 'compare' && compareRef && input.after) {
        args.push('--stitch', await localFile(compareRef), '--label', 'Before', '--stitch', await localFile(input.after), '--label', 'After');
        if (input.columns !== undefined) args.push('--columns', String(input.columns));
      } else {
        if (!batchTargets && previewTarget !== undefined) {
          args.push(`${await this.preview(workspace)}/${previewTarget}`);
        } else {
          args.push(...targets);
        }

        args.push('--size', sizeStr);
        if (mode === 'compare' && compareRef) args.push('--compare', await localFile(compareRef));
        if (mode === 'evidence' || input.evidence) args.push('--evidence');
        if (input.states !== undefined) {
          const states = Array.isArray(input.states) ? input.states.join(',') : String(input.states);
          if (states.trim()) args.push('--states', states.trim());
        }
        if (input.param) args.push('--param', input.param.trim());
        if (input.query) args.push('--query', input.query.trim());
        if (input.zoom !== undefined) {
          const zoom = Array.isArray(input.zoom) ? input.zoom.join(',') : String(input.zoom);
          if (zoom.trim()) args.push('--zoom', zoom.trim());
        }
        if (input.fullPage) args.push('--full');
        if (input.thumb) args.push('--thumb');
        if (input.mask) args.push('--mask');
        if (input.sheet) args.push('--sheet');
        if (input.noSheet) args.push('--no-sheet');
        if (input.mark) args.push('--mark', input.mark);
        if (input.steps !== undefined) {
          const stepsList = Array.isArray(input.steps) ? input.steps : [input.steps];
          for (const stepGroup of stepsList) {
            if (typeof stepGroup === 'string' && stepGroup.trim()) args.push('--steps', stepGroup.trim());
          }
        }
        if (input.selector) {
          args.push('--selector', input.selector.trim());
        }
        if (record) args.push('--record');
        if (input.entry) args.push('--entry');
        if (input.holdMs !== undefined) args.push('--hold', String(input.holdMs));
        if (motion) args.push('--motion');
        if (input.frames !== undefined) args.push('--frames', String(input.frames));
        if (input.columns !== undefined) args.push('--columns', String(input.columns));
        if (input.waitMs !== undefined) args.push('--wait', String(input.waitMs));
        if (input.timeoutScale !== undefined) args.push('--timeout-scale', String(input.timeoutScale));
        if (input.dryRun) args.push('--dry-run');
      }

      args.push('--out', runOutDir);
      const result = await this.processes.run(await this.script('shoot.mjs', workspace), args, workspace, timeoutMs, signal);

      if (input.dryRun) {
        return { ok: result.ok, mode, outputFiles: [], domHints: [], stdout: result.stdout, stderr: result.stderr };
      }

      const generatedRel = await this.collectFiles(runOutDir);
      const outputFiles: string[] = [];

      if (isSinglePngOut) {
        const fullPaths = generatedRel.map(name => join(runOutDir, name));
        const primary =
          fullPaths.find(p => /-(?:compare|marked)\.png$/.test(p)) ??
          fullPaths.find(p => basename(p) === 'stitch.png') ??
          fullPaths.find(p => p.endsWith('.png'));
        if (primary) {
          await copyFile(primary, outResolved);
          outputFiles.push(outResolved);
          const stem = outResolved.slice(0, -4);
          for (const f of fullPaths) {
            if (f === primary) continue;
            if (/\.(?:png|webp|jpe?g|mp4|webm|json)$/i.test(f)) {
              const dest = `${stem}-${basename(f)}`;
              await copyFile(f, dest);
              if (/\.(?:png|webp|jpe?g|mp4|webm)$/i.test(dest)) outputFiles.push(dest);
            }
          }
        }
      } else {
        for (const name of generatedRel) {
          const full = join(runOutDir, name);
          if (/\.(?:png|webp|jpe?g|mp4|webm)$/i.test(full)) outputFiles.push(full);
        }
      }

      const domHints = result.stdout
        .split(/\r?\n/)
        .filter(line => /默认做法提示|DOM|横向溢出|加载失败|控制台错误|可读性/.test(line));

      return {
        ok: result.ok && outputFiles.length > 0,
        mode,
        outputFiles,
        domHints,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(input.selector
          ? { selectorMode: 'crop', message: '已截取 selector 对应元素的区域。' }
          : {}),
        ...((mode === 'compare' && input.after) || input.stitch?.length ? { comparison: 'side-by-side' } : {}),
      };
    } finally {
      if (isSinglePngOut) {
        await rm(runOutDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async media(cwd: string, input: MediaRequest, signal?: AbortSignal) {
    const workspace = await this.resolveWorkspace(cwd);
    const action = input.action ?? (input.refs ? 'fetch' : 'search_and_fetch');
    if (!['search', 'preview', 'fetch', 'search_and_fetch'].includes(action)) {
      throw new Error('action must be search, preview, fetch or search_and_fetch');
    }

    const kind = input.kind ?? 'all';
    if (!KNOWN_KINDS.includes(kind)) {
      throw new Error(`kind must be one of: ${KNOWN_KINDS.join(', ')}`);
    }
    const limit = input.limit ?? 6;
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
      throw new Error('limit must be between 1 and 30');
    }
    const use = input.use ?? 'page';
    if (!['page', 'reference', 'all'].includes(use)) {
      throw new Error('use must be page, reference or all');
    }
    const sourceList = input.sources === undefined ? [] : (Array.isArray(input.sources) ? input.sources : input.sources.split(',')).map(s => s.trim().toLowerCase()).filter(Boolean);
    const sources = sourceList.length ? sourceList : undefined;
    const maps = Array.isArray(input.maps) ? input.maps.join(',') : input.maps;
    if (sources?.some(s => !KNOWN_SOURCES.includes(s))) {
      throw new Error(`sources must use: ${KNOWN_SOURCES.join(', ')}`);
    }

    const timeoutMs = timeout(input.timeoutMs, 90_000);
    const outputDir = await this.scopedPath(workspace, input.dir ?? 'assets/media');
    await this.safeOutput(outputDir);
    const cache = await this.scopedPath(workspace, '.curate-cache.json', true);
    // Validate only the engine's fixed writable paths, not unrelated assets in this directory.
    for (const name of ['SOURCES.md', 'candidates.html', 'candidates.png', 'sheet.html', 'sheet.png']) {
      await this.scopedPath(workspace, join(outputDir, name));
    }
    const script = await this.script('curate-media.mjs', workspace);
    const deadline = Date.now() + timeoutMs;

    const run = async (args: string[]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          result: { ok: false, stdout: '', stderr: 'Media operation timed out', timedOut: true, exitCode: null },
          data: { items: [], files: [], errors: [{ message: 'Media operation timed out' }] } as Record<string, unknown>,
        };
      }
      const result = await this.processes.run(script, [...args, '--cache', cache], workspace, remaining, signal);
      let data: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(result.stdout);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
        data = value as Record<string, unknown>;
      } catch {
        data = { items: [], files: [], errors: [{ message: 'Media script returned invalid JSON', stdout: result.stdout, stderr: result.stderr }] };
        result.ok = false;
      }
      return { result, data };
    };

    const normalizeRefs = (allowQuery = false): string => {
      const raw = Array.isArray(input.refs) ? input.refs.join(',') : String(input.refs ?? (allowQuery ? input.query : '') ?? '');
      const cleaned = raw.trim();
      if (!cleaned) throw new Error('refs is required for preview or fetch');
      return cleaned;
    };

    if (action === 'preview') {
      const refs = normalizeRefs(true);
      const previewArgs = ['preview', refs, '--dir', outputDir, ...(input.sheet !== false ? ['--sheet'] : [])];
      let outFile: string | null = null;
      if (input.out) {
        outFile = await this.scopedPath(workspace, input.out);
        await this.safeOutput(dirname(outFile));
      }
      const previewed = await run(previewArgs);
      let sheetPath = typeof previewed.data.sheetImage === 'string' ? resolve(outputDir, previewed.data.sheetImage) : null;
      if (outFile && !sheetPath && previewed.result.ok) throw new Error('Media preview did not produce a sheet to copy');
      if (outFile && sheetPath && sheetPath !== outFile) {
        await copyFile(await this.scopedPath(workspace, sheetPath), outFile);
        sheetPath = outFile;
      }
      return {
        ok: previewed.result.ok,
        action,
        outputDir,
        sheetPath,
        items: (previewed.data.items as unknown[]) ?? [],
        errors: previewed.data.errors ?? [],
        stderr: previewed.result.stderr,
      };
    }

    if (action === 'fetch') {
      const refs = normalizeRefs();
      const fetchArgs = ['fetch', refs];
      if (input.out) {
        const outFile = await this.scopedPath(workspace, input.out);
        await this.safeOutput(dirname(outFile));
        await this.scopedPath(workspace, join(dirname(outFile), 'SOURCES.md'));
        fetchArgs.push('--out', outFile);
      } else {
        fetchArgs.push('--dir', outputDir);
      }
      if (input.sheet !== false && !input.out) fetchArgs.push('--sheet');
      if (maps) fetchArgs.push('--maps', maps);
      if (input.resolution) fetchArgs.push('--resolution', input.resolution);
      if (input.videoSize) fetchArgs.push('--video-size', input.videoSize);
      if (input.note) fetchArgs.push('--note', input.note);
      const fetched = await run(fetchArgs);
      const downloaded = (Array.isArray(fetched.data.files) ? fetched.data.files : []) as Record<string, unknown>[];
      return {
        ok: fetched.result.ok,
        action,
        count: downloaded.length,
        outputDir,
        sheetPath: typeof fetched.data.sheetImage === 'string' ? resolve(outputDir, fetched.data.sheetImage) : null,
        items: downloaded,
        errors: fetched.data.errors ?? [],
        stderr: fetched.result.stderr,
      };
    }

    if (typeof input.query !== 'string' || !input.query.trim() || input.query.trim().startsWith('-')) {
      throw new Error('query must be nonempty search terms');
    }
    const searchArgs = [
      'search',
      input.query.trim(),
      '--kind',
      kind,
      '--dir',
      outputDir,
      '--use',
      use === 'page' ? 'page' : 'all',
      '--limit',
      String(sources || use === 'reference' ? 30 : limit),
    ];
    if (input.refresh) searchArgs.push('--refresh');
    if (action === 'search' && input.sheet) searchArgs.push('--sheet');

    const search = await run(searchArgs);
    let items = (Array.isArray(search.data.items) ? search.data.items : []) as Record<string, unknown>[];
    items = items
      .filter(item => (use !== 'reference' || item.use === 'reference') && (!sources || sources.includes(String(item.provider).toLowerCase())))
      .slice(0, limit);

    if (action === 'search' || !items.length) {
      return {
        ok: search.result.ok,
        action,
        count: items.length,
        outputDir,
        sheetPath: typeof search.data.sheetImage === 'string' ? resolve(outputDir, search.data.sheetImage) : null,
        items,
        errors: search.data.errors ?? [],
        stderr: search.result.stderr,
      };
    }

    const refs = items.map(item => String(item.ref ?? item.id));
    if (refs.some(ref => !/^[A-Z]\d+$/.test(ref))) {
      throw new Error('Media script returned invalid asset references');
    }
    const fetchArgs = ['fetch', refs.join(','), '--dir', outputDir];
    if (input.sheet !== false) fetchArgs.push('--sheet');
    if (maps) fetchArgs.push('--maps', maps);
    if (input.resolution) fetchArgs.push('--resolution', input.resolution);
    if (input.videoSize) fetchArgs.push('--video-size', input.videoSize);
    const fetched = await run(fetchArgs);
    const downloaded = (Array.isArray(fetched.data.files) ? fetched.data.files : []) as Record<string, unknown>[];
    let sheetPath: string | null = null;
    if (typeof fetched.data.sheetImage === 'string') {
      const rawSheet = resolve(outputDir, fetched.data.sheetImage);
      const targetSheet = await this.scopedPath(workspace, input.out ?? 'shots/media-sheet.png');
      await this.safeOutput(dirname(targetSheet));
      await copyFile(rawSheet, targetSheet);
      sheetPath = targetSheet;
    }

    return {
      ok: search.result.ok && fetched.result.ok,
      action,
      count: downloaded.length,
      outputDir,
      sheetPath,
      items: downloaded.map(item => ({ ...items.find(source => source.ref === item.ref), ...item })),
      errors: fetched.data.errors ?? [],
      stderr: [search.result.stderr, fetched.result.stderr].filter(Boolean).join('\n'),
    };
  }

  async image(cwd: string, input: ImageRequest, signal?: AbortSignal) {
    const workspace = await this.resolveWorkspace(cwd);
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('prompt must be nonempty');
    if (input.images !== undefined && (!Array.isArray(input.images) || input.images.some(path => typeof path !== 'string' || !path.trim()))) {
      throw new Error('images must be local file paths');
    }
    const images = input.images ?? [];
    if (images.length > 16) throw new Error('At most 16 reference images are supported');
    const mode = input.mode ?? (images.length ? 'edit' : 'generate');
    if (!['generate', 'edit'].includes(mode)) throw new Error('mode must be generate or edit');
    if (mode === 'edit' && !images.length) throw new Error('edit requires 1–16 reference images');
    if (mode === 'generate' && images.length) throw new Error('Use edit mode with reference images');

    const size = input.size ?? '1024x1024';
    const dimensions = /^(\d+)x(\d+)$/.exec(size);
    if (size !== 'auto' && (!dimensions || !dimensions.slice(1).every(n => Number.isSafeInteger(Number(n)) && Number(n) > 0))) {
      throw new Error('size must be auto or positive WIDTHxHEIGHT dimensions');
    }
    const quality = input.quality ?? 'medium';
    if (!['auto', 'low', 'medium', 'high'].includes(quality)) throw new Error('Invalid image quality');
    if (input.background !== undefined && !['auto', 'opaque', 'transparent'].includes(input.background)) {
      throw new Error('Invalid image background');
    }
    if (input.model !== undefined && !input.model.trim()) throw new Error('model must be nonempty');

    const timeoutMs = timeout(input.timeoutMs, 180_000);
    let out = await this.scopedPath(workspace, input.out ?? 'assets/generated.png');
    if (!input.out && input.force !== true) {
      let suffix = 1;
      while (await lstat(out).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; })) {
        out = await this.scopedPath(workspace, `assets/generated-${suffix++}.png`);
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
      const path = await this.scopedPath(workspace, image);
      if (!(await stat(path)).isFile()) throw new Error('Reference images must be local files');
      references.push(path);
    }

    const script = await resolveImageGenScript({ ...this.skillOptions, cwd: workspace });
    if (!script) {
      throw new Error('Local image-gen script not found. Install image-gen or configure imageGenScript / OIL_UI_IMAGE_GEN_SCRIPT.');
    }
    await this.safeOutput(dirname(out));
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
      const args = [script, mode, '--prompt-file', promptPath, '--out', out, '--size', size, '--quality', quality, '--json'];
      if (input.background) args.push('--background', input.background);
      if (input.model) args.push('--model', input.model.trim());
      if (input.force === true) args.push('--force');
      for (const reference of references) args.push('--image', reference);
      const result = await this.processes.runCommand('python3', args, workspace, timeoutMs, signal);
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
      for (const value of [data?.files, data?.outputs, data?.outputFiles]) if (Array.isArray(value)) reported.push(...value);
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
        if (await lstat(path).then(info => info.isFile(), () => false)) outputFiles.push(path);
      }
      return {
        ok: result.ok && outputFiles.length > 0,
        mode,
        outputFiles,
        model: typeof data?.model === 'string' ? data.model : input.model ?? null,
        size,
        quality,
        background: input.background ?? data?.background ?? null,
        data,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } finally {
      if (promptCreated) await rm(promptPath, { force: true });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.processes.dispose();
    await Promise.all([...this.pendingServers.values()].map(p => p.catch(() => undefined)));
    const activeServers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      activeServers.map(
        ({ server }) =>
          new Promise<void>((done, fail) => {
            server.close(error => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      ),
    );
  }
}
