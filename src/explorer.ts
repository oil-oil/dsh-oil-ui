import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { parse as parseJavaScript } from 'acorn';
import type { ActiveSkill } from './skill/upstream.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type RecordValue = Record<string, unknown>;
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.js': 'text/javascript',
  '.css': 'text/css',
};
export const STORAGE_SHIM = `<script>(()=>{const mem=()=>{const m=new Map();return{get length(){return m.size},key:i=>[...m.keys()][i]??null,getItem:k=>m.has(String(k))?m.get(String(k)):null,setItem:(k,v)=>{m.set(String(k),String(v))},removeItem:k=>{m.delete(String(k))},clear:()=>m.clear()}};for(const n of['localStorage','sessionStorage']){try{window[n].length}catch{Object.defineProperty(window,n,{value:mem(),configurable:true})}}})();</script>`;
const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; script-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordValue;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value.trim();
}
function viewport(value: unknown): { width: number; height: number } | undefined {
  if (value === undefined) return;
  const match = typeof value === 'string' ? /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(value) : null;
  const v = match ? { width: Number(match[1]), height: Number(match[2]) } : record(value, 'nativeViewport');
  if (![v.width, v.height].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0))
    throw new Error('nativeViewport requires positive integer dimensions');
  return { width: v.width as number, height: v.height as number };
}
export function loopbackUrl(value: unknown): URL {
  const url = new URL(text(value, 'url'));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  )
    throw new Error('URL candidates must use a loopback HTTP(S) URL');
  return url;
}
function children(node: Node): Node[] {
  return 'childNodes' in node ? node.childNodes : [];
}
function elements(node: Node): Element[] {
  const result: Element[] = [];
  if ('tagName' in node) result.push(node);
  for (const child of children(node)) result.push(...elements(child));
  if ('content' in node) result.push(...elements(node.content));
  return result;
}
function attr(node: Element, key: string): string | undefined {
  return node.attrs.find((a) => a.name === key)?.value;
}
function set(node: Element, key: string, value: string) {
  const existing = node.attrs.find((a) => a.name === key);
  if (existing) existing.value = value;
  else node.attrs.push({ name: key, value });
}
function remove(node: Element) {
  const parent = node.parentNode;
  if (parent) parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
}
function setText(node: Element, value: string) {
  node.childNodes = [{ nodeName: '#text', value, parentNode: node }];
}
function nodeText(node: Element): string {
  return node.childNodes.map((n) => ('value' in n ? n.value : '')).join('');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as RecordValue)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Embeds only resources inside the owning project (or the active template's Skill root). */
export class Embedder {
  private realRoot: Promise<string>;
  private cache = new Map<string, Buffer>();
  private total = 0;
  constructor(private root: string) {
    this.realRoot = realpath(root);
  }
  async path(value: string, base: string): Promise<string> {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) throw new Error(`Use local assets, received ${value}`);
    const clean = decodeURIComponent(value.split(/[?#]/, 1)[0]!).replace(/\\/g, '/');
    const path = resolve(base, clean);
    const root = await this.realRoot;
    const actual = await realpath(path);
    const rel = relative(root, actual);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error('Explorer resources must remain within the project');
    return actual;
  }
  async bytes(path: string): Promise<Buffer> {
    if (this.cache.has(path)) return this.cache.get(path)!;
    const data = await readFile(path);
    this.total += data.length;
    if (data.length > 20 * 1024 * 1024 || this.total > 100 * 1024 * 1024)
      throw new Error('Explorer resource size limit exceeded');
    this.cache.set(path, data);
    return data;
  }
  async uri(value: string, base: string): Promise<string> {
    if (/^(?:data:|#)/i.test(value)) return value;
    const path = await this.path(value, base);
    const hash = value.includes('#') ? `#${value.split('#').slice(1).join('#')}` : '';
    return `data:${MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'};base64,${(await this.bytes(path)).toString('base64')}${hash}`;
  }
  async css(source: string, base: string, stack: string[] = []): Promise<string> {
    const tree = postcss.parse(source);
    const imports: postcss.AtRule[] = [];
    tree.walkAtRules('import', (rule) => {
      imports.push(rule);
    });
    for (const rule of imports) {
      const params = valueParser(rule.params);
      const first = params.nodes.find((n) => n.type !== 'space' && n.type !== 'comment');
      const url =
        first?.type === 'string'
          ? first.value
          : first?.type === 'function' && first.value.toLowerCase() === 'url'
            ? valueParser.stringify(first.nodes).replace(/^['"]|['"]$/g, '')
            : '';
      if (!first || !url) throw new Error('Unsupported CSS import');
      const file = await this.path(url, base);
      if (stack.includes(file)) throw new Error('CSS import cycle');
      const css = await this.css((await this.bytes(file)).toString('utf8'), dirname(file), [...stack, file]);
      const tail = valueParser.stringify(params.nodes.slice(params.nodes.indexOf(first) + 1)).trim();
      if (/^(?:layer|supports)\b/i.test(tail))
        throw new Error('Inline layered CSS imports before generating the explorer');
      rule.replaceWith(postcss.parse(tail ? `@media ${tail}{${css}}` : css));
    }
    const declarations: postcss.Declaration[] = [];
    tree.walkDecls((decl) => {
      declarations.push(decl);
    });
    for (const decl of declarations) {
      const parsed = valueParser(decl.value);
      const urls: valueParser.FunctionNode[] = [];
      parsed.walk((node) => {
        if (node.type === 'function' && node.value.toLowerCase() === 'url') {
          urls.push(node);
          return false;
        }
      });
      for (const node of urls) {
        const url = valueParser
          .stringify(node.nodes)
          .trim()
          .replace(/^['"]|['"]$/g, '');
        node.nodes = [
          { type: 'string', quote: '"', value: await this.uri(url, base), sourceIndex: 0, sourceEndIndex: 0 },
        ];
      }
      decl.value = parsed.toString();
    }
    return tree.toString();
  }
  async module(source: string, base: string, stack: string[] = []): Promise<string> {
    const ast = parseJavaScript(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const edits: { start: number; end: number; value: string }[] = [];
    const visit = async (node: unknown): Promise<void> => {
      if (!node || typeof node !== 'object') return;
      const n = node as RecordValue;
      if (
        ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(
          String(n.type),
        ) &&
        n.source
      ) {
        const literal = n.source as { value?: unknown; start: number; end: number };
        if (typeof literal.value !== 'string')
          throw new Error('Use literal local module imports in explorer candidates');
        let url = literal.value;
        if (!url.startsWith('data:')) {
          const path = await this.path(url, base);
          if (stack.includes(path)) throw new Error('Module import cycle; bundle the candidate first');
          const code = await this.module((await this.bytes(path)).toString('utf8'), dirname(path), [...stack, path]);
          url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
        }
        edits.push({ start: literal.start, end: literal.end, value: JSON.stringify(url) });
      }
      for (const value of Object.values(n)) {
        if (Array.isArray(value)) for (const item of value) await visit(item);
        else if (value && typeof value === 'object') await visit(value);
      }
    };
    await visit(ast);
    for (const edit of edits.sort((a, b) => b.start - a.start))
      source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
    return source;
  }
  async html(source: string, base: string, interactive: boolean, template = false): Promise<string> {
    const document = parse(source);
    const nodes = elements(document);
    const deferred: Element[] = [];
    for (const node of nodes) {
      const tag = node.tagName;
      if (
        !template &&
        (['iframe', 'frame', 'object', 'embed', 'base'].includes(tag) ||
          (tag === 'meta' &&
            ['refresh', 'content-security-policy'].includes((attr(node, 'http-equiv') ?? '').toLowerCase())))
      )
        throw new Error('Candidate contains a nested document, redirect or conflicting CSP');
      if (tag === 'script') {
        const type = attr(node, 'type')?.toLowerCase();
        const executable = !type || ['module', 'text/javascript', 'application/javascript'].includes(type);
        if (!template && executable && !interactive) {
          remove(node);
          continue;
        }
        const src = attr(node, 'src');
        if (src) {
          const path = await this.path(src, base);
          let code = (await this.bytes(path)).toString('utf8');
          if (type === 'module') code = await this.module(code, dirname(path), [path]);
          setText(node, code.replace(/<\/script/gi, '<\\/script'));
          if (attr(node, 'defer') !== undefined && type !== 'module') deferred.push(node);
          node.attrs = node.attrs.filter(
            (a) => !['src', 'defer', 'async', 'integrity', 'crossorigin'].includes(a.name),
          );
        } else if (!template && type === 'module') setText(node, await this.module(nodeText(node), base));
        continue;
      }
      if (tag === 'link' && (attr(node, 'rel') ?? '').toLowerCase() === 'stylesheet') {
        const path = await this.path(text(attr(node, 'href'), 'stylesheet href'), base);
        node.tagName = node.nodeName = 'style';
        node.attrs = node.attrs.filter((a) => ['media', 'title'].includes(a.name));
        setText(
          node,
          (await this.css((await this.bytes(path)).toString('utf8'), dirname(path), [path])).replace(
            /<\/style/gi,
            '<\\/style',
          ),
        );
        continue;
      }
      if (tag === 'style') setText(node, await this.css(nodeText(node), base));
      if (attr(node, 'style')) set(node, 'style', (await this.css(`x{${attr(node, 'style')}}`, base)).slice(2, -1));
      if (attr(node, 'srcset')) {
        if (!attr(node, 'src')) set(node, 'src', attr(node, 'srcset')!.split(',').at(-1)!.trim().split(/\s+/)[0]!);
        node.attrs = node.attrs.filter((a) => a.name !== 'srcset');
      }
      for (const key of ['src', 'poster', 'href']) {
        const value = attr(node, key);
        if (!value || value.startsWith('#') || /^data:/i.test(value)) continue;
        if (key === 'href' && tag === 'a') {
          if (!template) set(node, key, '#');
          continue;
        }
        set(node, key, await this.uri(value, base));
      }
    }
    const body = nodes.find((n) => n.tagName === 'body')!;
    for (const node of deferred) {
      remove(node);
      node.parentNode = body;
      body.childNodes.push(node);
    }
    let output = serialize(document);
    if (!template) {
      const policy = interactive
        ? PREVIEW_CSP.replace("script-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval' data:")
        : PREVIEW_CSP;
      output = output.replace(
        /<head>/i,
        `<head><meta http-equiv="Content-Security-Policy" content="${policy}">${interactive ? STORAGE_SHIM : ''}`,
      );
    }
    return output;
  }
}

export async function defaultManifest(
  project: { title: string; request: string; directory: string },
  embed = new Embedder(project.directory),
) {
  const candidates = [];
  for (const id of ['a', 'b', 'c']) {
    let foundPath: string | null = null;
    let foundSource = `${id}.html`;
    for (const rel of [`directions/${id}.html`, `explore/${id}.html`, `direction-${id}.html`, `${id}.html`]) {
      try {
        foundPath = await embed.path(rel, project.directory);
        foundSource = rel;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!foundPath)
      throw new Error(
        `Missing direction candidate ${id}.html (checked directions/, explore/, direction-${id}.html, and workspace root)`,
      );
    const html = (await embed.bytes(foundPath)).toString('utf8');
    const title = elements(parse(html)).find((n) => n.tagName === 'title');
    const palette = [
      ...new Set(
        html.match(/#(?:[a-f\d]{8}|[a-f\d]{6}|[a-f\d]{4}|[a-f\d]{3})(?![a-z\d_])/gi) ?? ['#222222', '#ffffff'],
      ),
    ].slice(0, 6);
    candidates.push({
      id,
      name: title ? nodeText(title).trim() || id.toUpperCase() : id.toUpperCase(),
      concept: project.request,
      typography: '沿用候选页面的字体设置',
      traits: ['比较页面的布局、字体与配色'],
      palette,
      kind: 'html',
      source: foundSource,
    });
  }
  return { schemaVersion: 1, project: project.title, brief: project.request, candidates };
}

export async function buildExplorer(
  input: unknown,
  projectDirectory: string,
  active: ActiveSkill,
  manifestDir?: string,
  outputPath?: string,
  embed = new Embedder(projectDirectory),
): Promise<string> {
  const raw = record(typeof input === 'string' ? JSON.parse(input) : input, 'manifest');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new Error('manifest.schemaVersion must be 1');
  const data: RecordValue = { schemaVersion: 1 };
  for (const key of ['project', 'brief', 'round']) if (raw[key] !== undefined) data[key] = text(raw[key], key);
  if (raw.lang !== undefined) {
    if (!['zh', 'en'].includes(String(raw.lang))) throw new Error('lang must be zh or en');
    data.lang = raw.lang;
  }
  const sharedViewport = viewport(raw.nativeViewport);
  if (raw.serve !== undefined) {
    const serve = record(raw.serve, 'serve');
    text(serve.command, 'serve.command');
    if (serve.cwd !== undefined && !isAbsolute(text(serve.cwd, 'serve.cwd')))
      throw new Error('serve.cwd must be absolute');
    if (serve.url !== undefined) loopbackUrl(serve.url);
    data.serve = serve;
  }
  if (!Array.isArray(raw.candidates) || !raw.candidates.length)
    throw new Error('candidates must contain at least one candidate');
  const ids = new Set<string>();
  const reservedIds = new Set(
    raw.candidates.flatMap((value) =>
      value && typeof value === 'object' && !Array.isArray(value) && typeof (value as RecordValue).id === 'string'
        ? [((value as RecordValue).id as string).trim()]
        : [],
    ),
  );
  const candidates: RecordValue[] = [];
  const origins = new Set<string>();
  const searchBases = [
    ...new Set([
      ...(manifestDir ? [manifestDir] : []),
      resolve(projectDirectory, 'directions'),
      resolve(projectDirectory, 'explore'),
      projectDirectory,
    ]),
  ];
  const resolvedOut = outputPath
    ? await realpath(dirname(outputPath)).then(
        (d) => resolve(d, relative(dirname(outputPath), outputPath)),
        () => resolve(outputPath),
      )
    : resolve(projectDirectory, 'directions/explorer.html');
  for (const value of raw.candidates) {
    const c = record(value, 'candidate');
    let id: string;
    if (c.id === undefined) {
      const stem = `candidate-${candidates.length + 1}`;
      id = stem;
      let suffix = 2;
      while (ids.has(id) || reservedIds.has(id)) id = `${stem}-${suffix++}`;
    } else id = text(c.id, 'candidate.id');
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || ids.has(id)) throw new Error('Invalid or duplicate candidate id');
    ids.add(id);
    const kind = c.kind ?? 'html';
    if (!['html', 'image', 'url'].includes(String(kind))) throw new Error('kind must be html, image or url');
    for (const flag of ['interactive', 'baseline'])
      if (c[flag] !== undefined && typeof c[flag] !== 'boolean') throw new Error(`${flag} must be boolean`);
    if (c.interactive && kind !== 'html') throw new Error('interactive is only available for html candidates');
    let palette: string[] | undefined;
    if (c.palette !== undefined) {
      const colors = JSON.stringify(c.palette).match(/#(?:[a-f\d]{8}|[a-f\d]{6}|[a-f\d]{4}|[a-f\d]{3})(?![a-z\d_])/gi);
      if (!colors?.length) throw new Error('palette requires hexadecimal colors');
      palette = colors;
    }
    let traits: string[] | undefined;
    if (c.traits !== undefined) {
      if (!Array.isArray(c.traits) || !c.traits.length) throw new Error('traits must be nonempty');
      traits = c.traits.map((v) => text(v, 'trait'));
    }
    const concept = c.concept === undefined ? undefined : text(c.concept, 'concept');
    const typography = c.typography === undefined ? undefined : text(c.typography, 'typography');
    let name = c.name === undefined ? undefined : text(c.name, 'name');
    let content: string;
    let sourceLabel: string;
    if (kind === 'url') {
      const url = loopbackUrl(c.url);
      content = url.href;
      sourceLabel = content;
      const urlName = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
      try {
        name ??= decodeURIComponent(urlName) || url.hostname;
      } catch {
        name ??= urlName || url.hostname;
      }
      origins.add(url.origin.replace('[::1]', 'localhost'));
    } else {
      const source = text(c.source, 'source');
      let path: string | undefined;
      let lastError: unknown;
      for (const base of searchBases) {
        try {
          path = await embed.path(source, base);
          break;
        } catch (error) {
          lastError = error;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (!path) throw lastError ?? new Error(`Missing candidate source: ${source}`);
      const relPath = relative(projectDirectory, path).split(sep).join('/');
      if (path === resolvedOut || relPath === 'directions/explorer.html' || relPath === 'style-explorer.html') {
        throw new Error('Explorer cannot overwrite an input candidate');
      }
      sourceLabel = source.split(/[\\/]/).at(-1)!;
      if (!name && kind === 'html') {
        const sourceHtml = (await embed.bytes(path)).toString('utf8');
        const title = elements(parse(sourceHtml)).find((n) => n.tagName === 'title');
        name = title ? nodeText(title).trim() || undefined : undefined;
      }
      name ??= basename(sourceLabel, extname(sourceLabel)) || basename(sourceLabel);
      content =
        kind === 'html'
          ? await embed.html((await embed.bytes(path)).toString('utf8'), dirname(path), Boolean(c.interactive))
          : await embed.uri(path, dirname(path));
      if (kind === 'image' && !/^data:image\//.test(content)) throw new Error('Image candidates require an image file');
    }
    name ??= `Candidate ${candidates.length + 1}`;
    const size = viewport(c.nativeViewport) ?? sharedViewport;
    candidates.push({
      id,
      name,
      ...(concept !== undefined ? { concept } : {}),
      ...(typography !== undefined ? { typography } : {}),
      ...(palette ? { palette } : {}),
      ...(traits ? { traits } : {}),
      kind,
      content,
      sourceLabel,
      baseline: c.baseline ?? false,
      interactive: c.interactive ?? false,
      ...(size ? { nativeViewport: size } : {}),
    });
  }
  if (candidates.filter((c) => c.baseline).length > 1) throw new Error('At most one baseline candidate is allowed');
  candidates.sort((a, b) => Number(b.baseline) - Number(a.baseline));
  data.candidates = candidates;
  data.fingerprint = createHash('sha256').update(canonical(data)).digest('hex').slice(0, 24);
  data.edition = active.edition === 'pro' ? 'pro' : 'open';
  const templateRoot = active.sourceDirectory ?? active.directory;
  const templateEmbedder = new Embedder(templateRoot);
  const templatePath = await templateEmbedder.path('assets/style-explorer.html', templateRoot);
  const rawTemplate = await templateEmbedder.html(
    (await templateEmbedder.bytes(templatePath)).toString('utf8'),
    dirname(templatePath),
    true,
    true,
  );
  const needsOptionalFieldsCompatibility =
    ['project', 'brief', 'round'].some((key) => data[key] === undefined) ||
    candidates.some((candidate) =>
      ['concept', 'typography', 'palette', 'traits'].some((key) => candidate[key] === undefined),
    );
  const template = needsOptionalFieldsCompatibility ? makeOptionalFieldsTemplateCompatible(rawTemplate) : rawTemplate;
  const marker = '/*__OIL_UI_DATA__*/ null';
  if (template.split(marker).length !== 2 || template.split("connect-src 'none'").length !== 2)
    throw new Error('Invalid style-explorer template markers');
  const payload = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return template
    .replace("connect-src 'none'", `connect-src ${origins.size ? [...origins].sort().join(' ') : "'none'"}`)
    .replace(marker, () => payload);
}

/** Bring older bundled templates up to the optional-field rendering contract. */
function makeOptionalFieldsTemplateCompatible(template: string): string {
  return template
    .replace("$('#project').textContent=DATA.project;", "$('#project').textContent=DATA.project||'';")
    .replace(
      "function stripMini(c){const s=el('span','strip-mini');(c.palette||[]).forEach(h=>{const i=el('i');i.style.background=h;s.append(i);});return s;}",
      "function stripMini(c){if(!c.palette?.length)return null;const s=el('span','strip-mini');c.palette.forEach(h=>{const i=el('i');i.style.background=h;s.append(i);});return s;}",
    )
    .replace(
      "function specList(c){\n  const dl=el('dl','spec');const row=(k,v)=>{dl.append(el('dt',null,k),el('dd',null,v));};\n  row(t('fonts'),c.typography);row(t('traits'),(c.traits||[]).join(' · '));return dl;\n }",
      "function specList(c){\n  const dl=el('dl','spec');const row=(k,v)=>{dl.append(el('dt',null,k),el('dd',null,v));};\n  if(c.typography)row(t('fonts'),c.typography);if(c.traits?.length)row(t('traits'),c.traits.join(' · '));return dl.children.length?dl:null;\n }",
    )
    .replace(
      "const cap=el('div','cap');cap.style.viewTransitionName=`cap-${C.indexOf(c)}`;cap.append(el('span',c.baseline?'no base':'no',no(c)),el('h2','name',c.name),stripMini(c),pickButton(c));\n  const lede=el('p','lede',c.concept);lede.title=c.concept;lede.style.viewTransitionName=`lede-${C.indexOf(c)}`;\n  a.append(frame,cap,lede);return a;",
      "const cap=el('div','cap');cap.style.viewTransitionName=`cap-${C.indexOf(c)}`;cap.append(el('span',c.baseline?'no base':'no',no(c)),el('h2','name',c.name));const mini=stripMini(c);if(mini)cap.append(mini);cap.append(pickButton(c));\n  a.append(frame,cap);if(c.concept){const lede=el('p','lede',c.concept);lede.title=c.concept;lede.style.viewTransitionName=`lede-${C.indexOf(c)}`;a.append(lede);}return a;",
    )
    .replace(
      "blocks.push(el('p','north',c.concept),sw,specList(c));",
      "if(c.concept)blocks.push(el('p','north',c.concept));if(sw.children.length)blocks.push(sw);const spec=specList(c);if(spec)blocks.push(spec);",
    );
}
