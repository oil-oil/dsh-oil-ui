#!/usr/bin/env node
// Local web-image preparation. Node 22+, Chrome/Chromium/Edge, no npm dependencies.
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, extname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChrome } from './chrome.mjs';

const HELP = `常用命令：
  node <skill>/scripts/prep-image.mjs image.png --out assets/web
  node <skill>/scripts/prep-image.mjs a.png b.jpg --width 960px --out assets/web
  node <skill>/scripts/prep-image.mjs originals --widths 480,960,1600 --sizes "(max-width: 600px) 100vw, 50vw"
  node <skill>/scripts/prep-image.mjs image.png --crop 16:9 --focus right --width 1200
  node <skill>/scripts/prep-image.mjs cutout.png --trim

用法：node <skill>/scripts/prep-image.mjs <本地图片或目录> [...] [选项]
  --out <目录>       默认 ./web-images；--dir、--output 同义。不覆盖任何已有文件，重名加编号。
  --width <最大宽度> 默认 1600；--max-width、--resize 同义。只缩小，不放大。
  --widths <列表>    一次输出多档，逗号或空格分隔；超出原宽的档位合并为原宽。
  --sizes <值>       HTML sizes，默认 100vw；按页面实际布局填写。
  --format <格式>   webp（默认）、png、jpeg/jpg；透明图片转 JPEG 会报错，改用 WebP/PNG。
  --quality <质量>  默认 82，范围 1–100；可写 82%、0.82。PNG 不接受此项。
  --crop <比例>     如 16:9、16/9、16x9 或 1.5；--ratio 同义。先裁边，再裁比例，再缩小。
  --focus <位置>    center/centre、left/right/top/bottom、top-left 等，或 0%–100%,0%–100%。
                    表示裁切窗口在可移动范围里的位置，默认 center；必须配 --crop。
  --trim             只裁完全透明的外围像素，保留半透明边缘；不去背景、不裁白边。
  --help, -h         帮助。选项、格式、位置不区分大小写，可写 --名字=值。

输入为静态 PNG/JPEG/WebP（按文件签名识别）；动画报错，避免静默丢帧。
目录只读直接子文件，不递归、不跟随符号链接；忽略其他格式。也可传 shell 展开的多文件。
宽度接受 px、k（1k=1000）；大幅缩小时分步缩放。透明通道随 WebP/PNG 保留。
每档编码后若不比原文件小，就原样复制原文件并说明，尺寸也以原图为准（裁切/缩放未应用）。
原图始终保留；输出扩展名对应真实格式。多尺寸回退到同一原图时只留一个候选。
报错里的重跑命令用于 macOS/Linux shell 或 Windows PowerShell，也附无 shell 的 argv。
标准输出为 JSON：每文件原始/结果尺寸、字节数、警告和可粘贴的 <img srcset sizes>。
片段路径相对当前目录，含空格等字符会 URL 编码；在项目根目录运行，alt 按内容填写。
Windows 跨盘输出使用 file:/// 绝对地址；本地预览、截图验收和部署时，请把图片放在站点目录内并使用相对路径。
进度和未转义的 HTML 片段在标准错误，可直接复制；单项失败继续整批，errors 列出失败及重跑命令，退出码 1。
需要 Node 22+ 及本机 Chrome/Chromium/Edge，也可设 CHROME_PATH；不会自动安装工具。`;
const example = 'node <skill>/scripts/prep-image.mjs image.png --width 960 --out assets/web';
const usage = message => { throw new Error(`${message}\n示例：${example}\n全部选项：node <skill>/scripts/prep-image.mjs --help`); };
export function parseArgs(argv) {
  const end = argv.indexOf('--'), beforeTerminator = end < 0 ? argv : argv.slice(0, end);
  if (!argv.length || beforeTerminator.some(a => /^(--help|-h)$/i.test(a))) return { help: true };
  const opts = {}, inputs = [], aliases = { dir: 'out', output: 'out', 'max-width': 'width', resize: 'width', ratio: 'crop' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { inputs.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { inputs.push(arg); continue; }
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) usage(`不认识的选项：${arg}`);
    const key = aliases[m[1].toLowerCase()] ?? m[1].toLowerCase();
    if (!['out', 'width', 'widths', 'sizes', 'format', 'quality', 'crop', 'focus', 'trim'].includes(key)) usage(`不认识的选项：${arg}`);
    if (key in opts) usage(`--${key} 重复；多档宽度请用 --widths 480,960,1600`);
    if (key === 'trim') { if (m[2] !== undefined) usage('--trim 不带值；用 --trim'); opts.trim = true; }
    else { const v = m[2] ?? argv[++i]; if (!v || v.startsWith('--')) usage(`--${key} 缺少值`); opts[key] = v; }
  }
  if (!inputs.length) usage('缺少本地图片或目录');
  if (opts.width && opts.widths) usage('--width 与 --widths 选一个；多档用 --widths 480,960');
  const width = s => {
    const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(px|k)?$/i), n = m ? Number(m[1]) * (m[2]?.toLowerCase() === 'k' ? 1000 : 1) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 32768) usage(`无效宽度 ${s}；用 --width 960px 或 --widths 480,960,1.6k`);
    return n;
  };
  const widths = [...new Set((opts.widths ?? opts.width ?? '1600').split(/[,\s]+/).filter(Boolean).map(width))].sort((a, b) => a - b);
  if (!widths.length) usage('宽度列表为空；用 --widths 480,960');
  const format = (opts.format ?? 'webp').toLowerCase().replace(/^jpg$/, 'jpeg');
  if (!['webp', 'png', 'jpeg'].includes(format)) usage('格式不支持；用 --format webp、png 或 jpeg');
  let quality = 0.82;
  if (opts.quality !== undefined) {
    const s = opts.quality.trim(), n = Number(s.replace(/%$/, ''));
    quality = s.endsWith('%') || n >= 1 ? n / 100 : n;
    if (!Number.isFinite(quality) || quality < .01 || quality > 1) usage('质量无效；用 --quality 82');
    if (format === 'png') usage('PNG 不使用有损质量；去掉 --quality，或改用 --format webp');
  }
  let ratio;
  if (opts.crop !== undefined) {
    const parts = opts.crop.trim().split(/\s*[:/x×]\s*/i);
    if (!parts.every(p => /^\d+(?:\.\d+)?$/.test(p))) usage('裁切比例无效；用 --crop 16:9');
    ratio = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : parts.length === 1 ? Number(parts[0]) : NaN;
    if (!Number.isFinite(ratio) || ratio < 1 / 100 || ratio > 100) usage('裁切比例无效；用 --crop 16:9');
  }
  let focus = [.5, .5];
  if (opts.focus !== undefined) {
    if (!ratio) usage('--focus 需要 --crop；例如 --crop 16:9 --focus right');
    const named = { center: [.5, .5], centre: [.5, .5], left: [0, .5], right: [1, .5], top: [.5, 0], bottom: [.5, 1], 'top-left': [0, 0], 'top-right': [1, 0], 'bottom-left': [0, 1], 'bottom-right': [1, 1] };
    const s = opts.focus.trim().toLowerCase();
    if (named[s]) focus = named[s];
    else if (/^\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%$/.test(s)) focus = s.split(',').map(x => Number(x.trim().slice(0, -1)) / 100);
    else usage('焦点无效；用 --focus right 或 --focus 75%,25%');
    if (focus.some(x => x > 1)) usage('焦点超出范围；用 --focus 75%,25%');
  }
  return { inputs, out: resolve(opts.out ?? 'web-images'), widths, format, quality, ratio, focus, trim: Boolean(opts.trim), sizes: opts.sizes ?? '100vw' };
}

// Use the same isolated launch/hand-off/cleanup logic as shoot, with a small bounded CDP transport.
export async function canvasBrowser() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node 22+；安装后重跑原命令');
  const browser = createChrome({ prefix: 'oil-image-', label: 'prep-image' });
  let ws, seq = 0, sessionId, closing = false;
  const pending = new Map();
  const rejectAll = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.no(error); } pending.clear(); };
  const dispose = () => browser.dispose();
  const close = async () => {
    closing = true; rejectAll(new Error('浏览器已关闭'));
    await browser.stop(ws); ws?.close();
    process.off('exit', dispose); process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
  };
  const sigint = () => { void close().finally(() => process.exit(130)); };
  const sigterm = () => { void close().finally(() => process.exit(143)); };
  process.on('exit', dispose); process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  const send = (method, params = {}, targetSession = sessionId) => new Promise((ok, no) => {
    if (ws?.readyState !== WebSocket.OPEN) { no(new Error('浏览器连接已断开；重跑原命令')); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); no(new Error(`CDP ${method} 超过 90 秒；稍后重跑原命令`)); }, 90000);
    pending.set(id, { ok, no, timer });
    try { ws.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) })); }
    catch (error) { clearTimeout(timer); pending.delete(id); no(error); }
  });
  try {
    let url;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { url = await browser.launch(); break; }
      catch (e) { await browser.stop(); if (e.message !== 'timeout' || attempt) throw e; console.error('prep-image：浏览器启动超时，重试一次'); }
    }
    ws = new WebSocket(url);
    await new Promise((ok, no) => {
      const timer = setTimeout(() => { ws.close(); no(new Error('连接浏览器超时')); }, 30000);
      ws.onopen = () => { clearTimeout(timer); ok(); };
      ws.onerror = ws.onclose = () => { clearTimeout(timer); no(new Error('连接浏览器失败')); };
    });
    ws.onmessage = event => {
      const msg = JSON.parse(event.data), p = pending.get(msg.id);
      if (!p) return; pending.delete(msg.id); clearTimeout(p.timer);
      msg.error ? p.no(new Error(msg.error.message)) : p.ok(msg.result);
    };
    ws.onerror = ws.onclose = () => { if (!closing) rejectAll(new Error('浏览器连接意外断开；重跑原命令')); };
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
    return { send, close, async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    } };
  } catch (error) { await close(); throw error; }
}

function imageType(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let i = 8; i + 12 <= buf.length;) { const n = buf.readUInt32BE(i); if (buf.toString('ascii', i + 4, i + 8) === 'acTL') throw new Error('不处理 APNG 动画；请提供静态 PNG'); i += n + 12; }
    return 'png';
  }
  if (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return 'jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    for (let i = 12; i + 8 <= buf.length;) { const n = buf.readUInt32LE(i + 4); if (['ANIM', 'ANMF'].includes(buf.toString('ascii', i, i + 4))) throw new Error('不处理 WebP 动画；请提供静态 WebP'); i += 8 + n + (n % 2); }
    return 'webp';
  }
  throw new Error('不是静态 PNG/JPEG/WebP（可能是下载错误页或动画）；请换用可解码的静态图片');
}

// Executed inside Chrome. Read alpha once; derive all variants from the same decoded original.
export async function renderImage(data, opts) {
  const img = new Image(); img.src = data;
  try { await img.decode(); } catch { throw new Error('图片解码失败；请检查文件是否完整，或重新下载'); }
  const width = img.naturalWidth, height = img.naturalHeight;
  if (width * height > 40000000 || Math.max(width, height) > 32768) throw new Error('图片超过 4000 万像素或单边 32768；请先提供较小原图');
  const make = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  let source = make(width, height), ctx = source.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1, alpha = false;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = pixels[(y * width + x) * 4 + 3];
    if (a < 255) alpha = true;
    if (a && opts.trim) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  if (alpha && opts.format === 'jpeg') throw new Error('图片含透明像素；改用 --format webp 或 --format png 后重跑');
  if (!opts.trim) { x0 = 0; y0 = 0; x1 = width - 1; y1 = height - 1; }
  else if (x1 < 0) throw new Error('整张图片完全透明，无法裁边；去掉 --trim 或提供有内容的图片');
  let w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (opts.ratio) {
    const cw = Math.max(1, Math.min(w, Math.round(h * opts.ratio))), ch = Math.max(1, Math.min(h, Math.round(w / opts.ratio)));
    x0 += Math.round((w - cw) * opts.focus[0]); y0 += Math.round((h - ch) * opts.focus[1]); w = cw; h = ch;
  }
  const cropped = make(w, h); cropped.getContext('2d').drawImage(source, x0, y0, w, h, 0, 0, w, h); source.width = source.height = 1; source = cropped;
  const variants = [];
  for (const tw of [...new Set(opts.widths.map(v => Math.min(v, w)))]) {
    const th = Math.max(1, Math.round(h * tw / w)); let c = source;
    // Halve large reductions before the final high-quality sample to avoid fine-detail aliasing.
    while (c.width > tw * 2) {
      const next = make(Math.max(tw, Math.round(c.width / 2)), Math.max(th, Math.round(c.height / 2)));
      const cx = next.getContext('2d'); cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high'; cx.drawImage(c, 0, 0, next.width, next.height);
      if (c !== source) c.width = c.height = 1; c = next;
    }
    const dest = make(tw, th), dc = dest.getContext('2d'); dc.imageSmoothingEnabled = true; dc.imageSmoothingQuality = 'high'; dc.drawImage(c, 0, 0, tw, th);
    const url = dest.toDataURL('image/' + opts.format, opts.quality);
    if (!url.startsWith('data:image/' + opts.format + ';')) throw new Error('浏览器不支持目标编码；改用 --format png 后重跑');
    variants.push({ width: tw, height: th, data: url.split(',')[1] });
    dest.width = dest.height = 1; if (c !== source) c.width = c.height = 1;
  }
  return { width, height, alpha, crop: { x: x0, y: y0, width: w, height: h }, variants };
}
const htmlEscape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const outputUrl = saved => fileUrl(realpathSync(saved), realpathSync(process.cwd()));
export function fileUrl(p, cwd = process.cwd(), platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix, rel = path.relative(cwd, p);
  if (path.isAbsolute(rel)) return pathToFileURL(p, { windows: platform === 'win32' }).href;
  return rel.split(path.sep).map(x => encodeURIComponent(x).replace(/'/g, '%27')).join('/');
}
function deliver(buf, dir, name, ext) {
  for (let i = 0; i < 10000; i++) {
    const file = join(dir, name + (i ? '-' + i : '') + '.' + ext);
    try { writeFileSync(file, buf, { flag: 'wx' }); return file; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('重名文件过多；请用 --out 指定空目录');
}
const commandArg = s => "'" + String(s).replace(/'/g, process.platform === 'win32' ? "''" : "'\"'\"'") + "'";
function rerun(file, opts) {
  // JSON carries argv as well, so callers can spawn without shell quoting on every OS.
  const args = [fileURLToPath(import.meta.url), file, '--out', opts.out, '--widths', opts.widths.join(','), '--format', opts.format];
  if (opts.format !== 'png') args.push('--quality', String(opts.quality * 100) + '%');
  if (opts.trim) args.push('--trim'); if (opts.ratio) args.push('--crop', String(opts.ratio), '--focus', opts.focus.map(v => v * 100 + '%').join(','));
  args.push('--sizes', opts.sizes);
  return { argv: [process.execPath, ...args], command: 'node ' + args.map(commandArg).join(' ') };
}
export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv); if (opts.help) { console.log(HELP); return; }
  fileUrl(opts.out);
  const files = [], errors = [];
  for (const input of opts.inputs) {
    try {
      const p = resolve(input), st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error('不跟随符号链接；请传真实本地路径');
      if (st.isDirectory()) {
        const entries = readdirSync(p, { withFileTypes: true }).filter(e => e.isFile() && /\.(png|jpe?g|webp)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
        if (!entries.length) throw new Error('目录没有静态 PNG/JPEG/WebP；请传图片文件或含图片的目录');
        files.push(...entries.map(e => join(p, e.name)));
      } else if (st.isFile()) files.push(p);
      else throw new Error('不是普通本地文件');
    } catch (e) { errors.push({ input, message: e.message, ...rerun(input, opts) }); }
  }
  let browser; const records = [];
  try {
    for (const file of [...new Set(files.map(p => realpathSync(p)))]) {
      try {
        const original = readFileSync(file), type = imageType(original);
        browser ??= await canvasBrowser();
        const rendered = await browser.evaluate(`(${renderImage.toString()})(${JSON.stringify('data:image/' + type + ';base64,' + original.toString('base64'))},${JSON.stringify(opts)})`);
        mkdirSync(opts.out, { recursive: true });
        const outputs = [], warnings = []; let kept;
        if (opts.trim && !rendered.alpha) warnings.push('图片没有透明像素，透明裁边未改变图片；--trim 不会去除不透明背景');
        let variants = rendered.variants;
        const changedCrop = rendered.crop.width !== rendered.width || rendered.crop.height !== rendered.height;
        // A srcset must share one composition; never mix an uncropped fallback with cropped variants.
        if (changedCrop && variants.some(v => Buffer.byteLength(v.data, 'base64') >= original.length)) {
          variants = [variants.find(v => Buffer.byteLength(v.data, 'base64') >= original.length)];
          warnings.push('裁切结果有档位不比原图小，整组回退到原图，避免 srcset 混用不同构图');
        }
        for (const variant of variants) {
          const encoded = Buffer.from(variant.data, 'base64'), keep = encoded.length >= original.length;
          if (keep && kept) continue;
          const ext = keep ? type.replace('jpeg', 'jpg') : opts.format.replace('jpeg', 'jpg');
          const name = basename(file, extname(file)) + (keep ? '-original' : '-' + variant.width);
          const saved = deliver(keep ? original : encoded, opts.out, name, ext);
          const result = { saved, width: keep ? rendered.width : variant.width, height: keep ? rendered.height : variant.height, bytes: keep ? original.length : encoded.length, keptOriginal: keep };
          outputs.push(result);
          if (keep) { kept = true; warnings.push(`编码 ${variant.width}×${variant.height} 为 ${encoded.length} B，不小于原图 ${original.length} B；保留原图，裁切/缩放未应用`); }
          console.error(`prep-image：${file} ${rendered.width}×${rendered.height} / ${original.length} B → ${saved} ${result.width}×${result.height} / ${result.bytes} B${keep ? '（保留原图）' : `（节省 ${(100 * (1 - result.bytes / original.length)).toFixed(1)}%）`}`);
        }
        outputs.sort((a, b) => a.width - b.width || a.bytes - b.bytes);
        const candidates = outputs.filter((o, i) => !i || o.width !== outputs[i - 1].width), last = candidates.at(-1);
        const html = `<img src="${htmlEscape(outputUrl(last.saved))}" srcset="${htmlEscape(candidates.map(o => outputUrl(o.saved) + ' ' + o.width + 'w').join(', '))}" sizes="${htmlEscape(opts.sizes)}" width="${last.width}" height="${last.height}" alt="">`;
        records.push({ input: file, original: { width: rendered.width, height: rendered.height, bytes: original.length, alpha: rendered.alpha }, crop: rendered.crop, outputs, warnings, html });
        for (const warning of warnings) console.error('prep-image：' + warning);
        console.error(html);
      } catch (e) {
        const recovery = e.message.includes('含透明像素') ? { ...opts, format: 'webp' } : e.message.includes('完全透明') ? { ...opts, trim: false } : opts;
        const error = { input: file, message: e.message, ...rerun(file, recovery) }; errors.push(error); console.error(`prep-image：${file}：${e.message}\n重跑：${error.command}`); }
    }
  } finally { await browser?.close(); }
  console.log(JSON.stringify({ files: records, errors }, null, 2));
  for (const e of errors.filter(e => !files.includes(e.input))) console.error(`prep-image：${e.input}：${e.message}\n重跑：${e.command}`);
  if (errors.length) process.exitCode = 1;
}
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().catch(e => { console.error('prep-image：' + e.message); process.exitCode = 1; });
}
