import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesignWorkbench } from '../src/workbench.ts';
import { buildExplorer, Embedder } from '../src/explorer.ts';
import { bundledSkillDirectory, type ActiveSkill } from '../src/upstream.ts';
import { ManagedProcesses } from '../src/processes.ts';
import type { ImageRequest } from '../src/tool-requests.ts';

vi.mock('node:fs/promises', { spy: true });

const localHome = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => localHome.path || os.homedir() };
});

const instances: DesignWorkbench[] = [];
const roots: string[] = [];

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-ui-test-')));
  roots.push(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const w = new DesignWorkbench(0, { preferPro: false });
  instances.push(w);
  return { w, cwd, root };
}

beforeEach(async () => {
  localHome.path = await realpath(await mkdtemp(join(tmpdir(), 'oil-workbench-home-')));
  roots.push(localHome.path);
  vi.stubEnv('DSH_HOME', join(localHome.path, '.dsh'));
  vi.stubEnv('OIL_UI_PRO_DIR', '');
  vi.stubEnv('OIL_UI_IMAGE_GEN_SCRIPT', '');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  localHome.path = '';
  for (const w of instances.splice(0)) await w.dispose();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

function explorerData(html: string): {
  edition: string;
  fingerprint: string;
  candidates: { content: string; kind: string; id: string; name: string }[];
} {
  const payload = /const DATA = ([\s\S]*?);\n/.exec(html) ?? /const DATA=([\s\S]*?);\n/.exec(html);
  if (!payload) throw new Error('Explorer data marker not found');
  return JSON.parse(payload[1]!);
}

async function scriptedWorkbench(script: string, mediaScript?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-native-')));
  roots.push(root);
  const skill = join(root, 'pro');
  const cwd = join(root, 'workspace');
  await mkdir(join(skill, 'scripts'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: oil-ui-pro\ndescription: Test local tools\n---\nInstructions');
  await writeFile(join(skill, 'scripts/shoot.mjs'), script);
  await writeFile(join(skill, 'scripts/curate-media.mjs'), mediaScript ?? script);
  await writeFile(join(cwd, 'index.html'), '<title>Native page</title>');
  const w = new DesignWorkbench(0, { proSkillDir: skill });
  instances.push(w);
  return { w, cwd, root, skill };
}

describe('workspace-rooted preview server and security boundaries', () => {
  it('serves workspace files and subdirectory relative assets, then closes on dispose', async () => {
    const { w, cwd } = await setup();
    await mkdir(join(cwd, 'explore'), { recursive: true });
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await writeFile(join(cwd, 'index.html'), '<!doctype html><title>Workspace page</title>');
    await writeFile(join(cwd, 'explore/a.html'), '<!doctype html><title>Candidate A</title><img src="../assets/hero.png">');
    await writeFile(join(cwd, 'assets/font.ttf'), Buffer.from([0, 1, 0, 0]));

    const base = await w.preview(cwd);
    const res = await fetch(`${base}/index.html`);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Workspace page');
    expect(res.headers.get('content-security-policy')).toContain("'unsafe-eval'");

    const sub = await fetch(`${base}/explore/a.html`);
    expect(sub.status).toBe(200);
    expect(await sub.text()).toContain('Candidate A');

    const font = await fetch(`${base}/assets/font.ttf`);
    expect(font.headers.get('content-type')).toBe('font/ttf');

    await w.dispose();
    await expect(fetch(`${base}/index.html`)).rejects.toThrow();
  });

  it('refuses hidden files and symlink escapes over HTTP', async () => {
    const { w, cwd } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'oil-ui-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.html'), 'private');
    await symlink(outside, join(cwd, 'linked'));
    await writeFile(join(cwd, '.hidden.json'), 'secret');

    const base = await w.preview(cwd);
    expect((await fetch(`${base}/linked/secret.html`)).status).toBe(404);
    expect((await fetch(`${base}/.hidden.json`)).status).toBe(404);
  });
});

describe('native explorer and managed scripts in cwd', () => {
  it('builds from a minimal manifest and omits absent optional metadata in the bundled legacy template', async () => {
    const { cwd } = await setup();
    await writeFile(join(cwd, 'titled.html'), '<!doctype html><title>Named from title</title><main>Page</main>');
    await writeFile(join(cwd, 'untitled.html'), '<!doctype html><main>Untitled page</main>');
    const active = {
      edition: 'lite',
      name: 'oil-ui',
      directory: bundledSkillDirectory,
      source: 'bundled-lite',
    } satisfies ActiveSkill;

    const html = await buildExplorer(
      { candidates: [{ source: 'titled.html' }, { source: 'untitled.html' }] },
      cwd,
      active,
      cwd,
      join(cwd, 'style-explorer.html'),
      new Embedder(cwd),
    );
    const data = explorerData(html) as ReturnType<typeof explorerData> & {
      project?: string;
      brief?: string;
      round?: string;
      candidates: (ReturnType<typeof explorerData>['candidates'][number] & Record<string, unknown>)[];
    };

    expect(data.project).toBeUndefined();
    expect(data.brief).toBeUndefined();
    expect(data.round).toBeUndefined();
    expect(data.candidates.map(candidate => candidate.id)).toEqual(['candidate-1', 'candidate-2']);
    expect(data.candidates.map(candidate => candidate.name)).toEqual(['Named from title', 'untitled']);
    for (const candidate of data.candidates) {
      for (const key of ['concept', 'typography', 'palette', 'traits']) expect(candidate).not.toHaveProperty(key);
    }
    expect(html).toContain("$('#project').textContent=DATA.project||'';");
    expect(html).toContain("if(c.typography)row(t('fonts'),c.typography)");
    expect(html).toContain("if(c.concept)blocks.push(el('p','north',c.concept))");
  });

  it('synthesizes a manifest from explore/a.html, b.html, c.html and builds style-explorer.html in Node', async () => {
    const { w, cwd } = await setup();
    await mkdir(join(cwd, 'explore'), { recursive: true });
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await writeFile(join(cwd, 'explore/theme.css'), '@import "base.css";body{background:url("../assets/pixel.png")}');
    await writeFile(join(cwd, 'explore/base.css'), '@font-face{font-family:Test;src:url("../assets/font.woff2")}body{color:#123456}');
    await writeFile(join(cwd, 'assets/pixel.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await writeFile(join(cwd, 'assets/font.woff2'), 'font fixture');
    for (const id of ['a', 'b', 'c']) {
      await writeFile(
        join(cwd, `explore/${id}.html`),
        `<title>Direction ${id}</title><link rel=stylesheet href=theme.css><main>${id}: inline candidate</main><img src=../assets/pixel.png>`,
      );
    }

    const result = await w.explorer(cwd, { title: 'Compare styles', request: 'Choose a clear layout' });
    expect(result.explorerPath).toBe('style-explorer.html');
    expect(result.explorerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/style-explorer\.html$/);

    const html = await readFile(join(cwd, result.explorerPath), 'utf8');
    expect(html).toContain('style-explorer');
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('/*__OIL_UI_DATA__*/ null');
    const data = explorerData(html);
    expect(data.edition).toBe('open');
    expect(data.fingerprint).toMatch(/^[a-f0-9]{24}$/);
    expect(data.candidates).toHaveLength(3);
    expect(data.candidates[0]?.content).toContain('a: inline candidate');
    expect(data.candidates[0]?.content).toContain('data:font/woff2;base64,');
    expect(data.candidates[0]?.content).not.toContain('@import');
    expect(data.candidates[0]?.content).toContain("script-src 'none'");
    expect(JSON.parse(await readFile(join(cwd, 'explore/manifest.json'), 'utf8')).candidates[0].name).toBe('Direction a');

    const res = await fetch(result.explorerUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).not.toContain("connect-src 'self'");

    const rerun = await w.explorer(cwd, {});
    expect(explorerData(await readFile(join(cwd, rerun.explorerPath), 'utf8')).fingerprint).toBe(data.fingerprint);

    // Windows backslash paths in scopedPath, manifest, and candidate assets normalize cleanly while still blocking traversal.
    expect(await w.scopedPath(cwd, 'explore\\a.html')).toBe(join(cwd, 'explore/a.html'));
    expect(await w.scopedPath(cwd, `${cwd}\\explore\\manifest.json`)).toBe(join(cwd, 'explore/manifest.json'));
    await expect(w.scopedPath(cwd, '..\\outside.html')).rejects.toThrow('within the current workspace');
    await expect(w.scopedPath(cwd, '.hidden\\secret.txt')).rejects.toThrow('hidden segments');
    const winResult = await w.explorer(cwd, {
      manifest: 'explore\\manifest.json',
      out: 'explore\\win-explorer.html',
    });
    expect(winResult.explorerPath).toBe('explore/win-explorer.html');
    expect(winResult.manifestPath).toBe('explore/manifest.json');
  });

  it('accepts a candidate directory or several HTML files through oil_ui_explorer inputs', async () => {
    const { w, cwd } = await setup();
    const directory = join(cwd, 'directions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'a.html'), '<title>Alpha direction</title>');
    await writeFile(join(directory, 'b.html'), '<main>Beta direction</main>');

    const directoryResult = await w.explorer(cwd, { inputs: 'directions' });
    expect(directoryResult.manifestPath).toBe('directions/manifest.json');
    let html = await readFile(join(cwd, directoryResult.explorerPath), 'utf8');
    let data = explorerData(html);
    expect(data.candidates.map(candidate => candidate.name)).toEqual(['Alpha direction', 'b']);

    await writeFile(join(directory, 'a.html'), '<title>Updated alpha</title>');
    const filesResult = await w.explorer(cwd, { inputs: ['directions/a.html', 'directions/b.html'] });
    expect(filesResult.explorerPath).toBe('style-explorer.html');
    html = await readFile(join(cwd, filesResult.explorerPath), 'utf8');
    data = explorerData(html);
    expect(data.candidates.map(candidate => candidate.name)).toEqual(['Updated alpha', 'b']);
  });

  it('accepts JSON manifests, embeds scripts/images, constrains URLs and escapes injected metadata', async () => {
    const { w, cwd, root } = await setup();
    await mkdir(join(cwd, 'explore'), { recursive: true });
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await writeFile(join(cwd, 'explore/a.html'), '<title>Interactive</title><script src="app.js" defer></script><button>Test</button>');
    await writeFile(join(cwd, 'explore/app.js'), 'localStorage.setItem("loaded","true");document.body.dataset.ready="yes";');
    await writeFile(join(cwd, 'assets/pixel.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const c = {
      id: 'a',
      name: '</script><script>escape</script>',
      concept: 'Compare',
      typography: 'System',
      palette: ['#123'],
      traits: ['Clear'],
      source: 'explore/a.html',
      interactive: true,
    };
    const manifest = {
      schemaVersion: 1,
      project: 'Mixed',
      brief: 'Test',
      round: '01',
      candidates: [
        c,
        { ...c, id: 'b', kind: 'image', interactive: false, source: 'assets/pixel.png' },
        { ...c, id: 'c', kind: 'url', interactive: false, url: 'http://127.0.0.1:5173/page' },
      ],
    };
    await w.explorer(cwd, { manifest: JSON.stringify(manifest) });
    const html = await readFile(join(cwd, 'style-explorer.html'), 'utf8');
    const data = explorerData(html);
    expect(html).toContain('connect-src http://127.0.0.1:5173');
    expect(html).not.toContain('</script><script>escape');
    expect(html).toContain("if(c.typography)row(t('fonts'),c.typography);if(c.traits?.length)row(t('traits'),c.traits.join(' · '))");
    expect(data.candidates[0]?.content).toContain('Object.defineProperty(window');
    expect(data.candidates[0]?.content).toContain('localStorage.setItem');
    expect(data.candidates[0]?.content).not.toContain('src="app.js"');
    expect(data.candidates[1]?.content).toContain('data:image/png;base64,');

    (manifest.candidates[2] as { url: string }).url = 'https://example.com/page';
    await expect(w.explorer(cwd, { manifest })).rejects.toThrow('loopback');
    expect(await readFile(join(cwd, 'style-explorer.html'), 'utf8')).toBe(html);

    await writeFile(join(root, 'external.png'), 'private');
    await writeFile(join(cwd, 'explore/a.html'), '<img src="../../external.png">');
    await expect(w.explorer(cwd, { manifest: { ...manifest, candidates: [c] } })).rejects.toThrow('within the project');
  });

  it('uses local Pro templates and reports Pro edition', async () => {
    const { w, cwd, skill } = await scriptedWorkbench('');
    await mkdir(join(skill, 'assets'), { recursive: true });
    await writeFile(
      join(skill, 'assets/style-explorer.html'),
      '<html><head><meta content="connect-src \'none\'"></head><body>PRO TEMPLATE<script>const DATA = /*__OIL_UI_DATA__*/ null;\n</script></body></html>',
    );
    await mkdir(join(cwd, 'explore'), { recursive: true });
    for (const id of ['a', 'b', 'c']) await writeFile(join(cwd, `explore/${id}.html`), `<title>${id}</title>`);
    await w.explorer(cwd, {});
    const html = await readFile(join(cwd, 'style-explorer.html'), 'utf8');
    expect(html).toContain('PRO TEMPLATE');
    expect(explorerData(html).edition).toBe('pro');
  });

  it('validates script parameters and workspace boundaries before execution', async () => {
    const { w, cwd } = await scriptedWorkbench('throw new Error("must not run");');
    for (const input of [
      { viewport: 'bad' },
      { viewport: '0x900' },
      { waitMs: -1 },
      { timeoutMs: 0 },
      { mode: 'compare' as const },
      { out: '../escape.png' },
      { selector: '.x; click .y' },
    ]) {
      await expect(w.shoot(cwd, input)).rejects.toThrow();
    }
    for (const input of [
      { query: '' },
      { query: 'test', limit: 0 },
      { query: 'test', sources: 'unknown' },
      { query: 'test', dir: '../escape' },
    ]) {
      await expect(w.media(cwd, input)).rejects.toThrow();
    }
  });

  it('serves subdirectory targets from workspace root, forwards full shoot flags to a directory for multi-output captures', async () => {
    const { w, cwd } = await scriptedWorkbench(
      `import{writeFile,mkdir}from'node:fs/promises';import{join}from'node:path';const args=process.argv.slice(2),dir=args[args.indexOf('--out')+1];await mkdir(dir,{recursive:true});await writeFile(join(dir,'idle.png'),'image bytes');console.log(JSON.stringify(args));console.log('idle.png 默认做法提示（不是报错，按设计意图判断）：small text');`,
    );
    await mkdir(join(cwd, 'explore'), { recursive: true });
    await writeFile(join(cwd, 'explore/a.html'), '<title>Candidate A</title>');

    const result = await w.shoot(cwd, {
      target: 'explore/a.html',
      out: 'shots',
      size: '1440x900,390x844',
      states: 'default,empty',
      param: 'view',
      query: 'tab=settings;tab=billing',
      zoom: [1, 2],
      fullPage: true,
      mask: true,
      sheet: true,
      mark: 'button,a',
      steps: 'click #open; wait 200; shot modal',
      waitMs: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.outputFiles).toEqual([join(cwd, 'shots/idle.png')]);
    expect(await readFile(join(cwd, 'shots/idle.png'), 'utf8')).toBe('image bytes');
    const shotsEntries = await readdir(join(cwd, 'shots'));
    expect(shotsEntries).toEqual(['idle.png']);

    expect(result.domHints[0]).toContain('默认做法提示');
    const args = JSON.parse(result.stdout.split('\n')[0]!);
    expect(args[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/explore\/a\.html$/);
    expect(args).toContain('--size');
    expect(args).toContain('1440x900,390x844');
    expect(args).toContain('--states');
    expect(args).toContain('default,empty');
    expect(args).toContain('--param');
    expect(args).toContain('view');
    expect(args).toContain('--query');
    expect(args).toContain('tab=settings;tab=billing');
    expect(args).toContain('--zoom');
    expect(args).toContain('1,2');
    expect(args).toContain('--full');
    expect(args).toContain('--mask');
    expect(args).toContain('--sheet');
    expect(args).toContain('--mark');
    expect(args).toContain('button,a');
    expect(args).toContain('--steps');
    expect(args).toContain('click #open; wait 200; shot modal');
  });

  it('supports search, preview, fetch and search_and_fetch in oil_ui_media', async () => {
    const script = `import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';const a=process.argv.slice(2);if(a[0]==='search'){console.log(JSON.stringify({items:[{ref:'M1',provider:'met',use:'page',license:'CC0'},{ref:'V1',provider:'vam',use:'reference'}]}));}else if(a[0]==='preview'){if(a.includes('--out'))throw Error('preview does not accept --out');const out=join(a[a.indexOf('--dir')+1],'candidates.png');await mkdir(join(out,'..'),{recursive:true});await writeFile(out,'preview-sheet');console.log(JSON.stringify({ok:true,sheetImage:out,items:[{ref:'M1',provider:'met',license:'CC0'}]}));}else{const dir=a[a.indexOf('--dir')+1];await mkdir(dir,{recursive:true});await writeFile(join(dir,'M1.png'),'asset');if(a.includes('--sheet'))await writeFile(join(dir,'sheet.png'),'sheet');console.log(JSON.stringify({files:[{ref:'M1',saved:join(dir,'M1.png')}],...(a.includes('--sheet')?{sheetImage:join(dir,'sheet.png')}:{})}));}`;
    const { w, cwd } = await scriptedWorkbench('', script);

    const searched = await w.media(cwd, { action: 'search', query: 'ceramic', sources: 'met' });
    expect(searched).toMatchObject({ ok: true, action: 'search', count: 1 });

    const previewed = await w.media(cwd, { action: 'preview', query: 'ceramic', out: 'shots/candidates.png' });
    expect(previewed).toMatchObject({ ok: true, action: 'preview', sheetPath: join(cwd, 'shots/candidates.png') });
    expect(await readFile(previewed.sheetPath!, 'utf8')).toBe('preview-sheet');

    const fetched = await w.media(cwd, { action: 'fetch', refs: 'M1', dir: 'assets/media', sheet: false });
    expect(fetched).toMatchObject({ ok: true, action: 'fetch', count: 1, outputDir: join(cwd, 'assets/media'), sheetPath: null });

    const combined = await w.media(cwd, { query: 'bridge | landscape', sources: 'met' });
    expect(combined).toMatchObject({
      ok: true,
      action: 'search_and_fetch',
      count: 1,
      outputDir: join(cwd, 'assets/media'),
      sheetPath: join(cwd, 'shots/media-sheet.png'),
    });
    expect(combined.items[0]).toMatchObject({ license: 'CC0', provider: 'met' });
    expect(await readFile(combined.sheetPath!, 'utf8')).toBe('sheet');
  });

  it('terminates timed-out scripts and kills active scripts when disposed', async () => {
    const { w, cwd } = await scriptedWorkbench(`console.log('started');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
    const result = await w.shoot(cwd, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('timed out');
    const running = w.shoot(cwd, { timeoutMs: 10000 });
    for (let i = 0; i < 100; i++) {
      if ((w as unknown as { processes: { active: Set<unknown> } }).processes.active.size) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await w.dispose();
    expect((await running).ok).toBe(false);
    await expect(w.shoot(cwd, {})).rejects.toThrow('disposed');
  });
});

it('honors Harness cancellation and reports malformed media output as structured failure', async () => {
  const { w, cwd } = await scriptedWorkbench(
    `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
    `console.log('not JSON');process.exitCode=1;`,
  );
  const controller = new AbortController();
  const running = w.shoot(cwd, { timeoutMs: 10000 }, controller.signal);
  for (let i = 0; i < 100; i++) {
    if ((w as unknown as { processes: { active: Set<unknown> } }).processes.active.size) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  controller.abort();
  expect(await running).toMatchObject({ ok: false, outputFiles: [] });
  const media = await w.media(cwd, { query: 'landscape' });
  expect(media).toMatchObject({ ok: false, count: 0, items: [], sheetPath: null });
  expect(media.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'Media script returned invalid JSON' })]));
});

it('hot-switches explorer templates and scripts on one workbench after Pro is installed', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'oil-hot-cwd-')));
  roots.push(cwd);
  const w = new DesignWorkbench(0);
  instances.push(w);
  await mkdir(join(cwd, 'explore'), { recursive: true });
  await writeFile(join(cwd, 'index.html'), '<title>Home</title>');
  for (const id of ['a', 'b', 'c']) await writeFile(join(cwd, `explore/${id}.html`), `<title>${id}</title>`);
  await w.explorer(cwd, {});
  expect(explorerData(await readFile(join(cwd, 'style-explorer.html'), 'utf8')).edition).toBe('open');

  const pro = join(localHome.path, '.dsh/skills/oil-ui-pro');
  await mkdir(join(pro, 'assets'), { recursive: true });
  await mkdir(join(pro, 'scripts'), { recursive: true });
  await writeFile(join(pro, 'SKILL.md'), '---\nname: oil-ui-pro\ndescription: Hot Pro\n---\nPro instructions');
  await writeFile(
    join(pro, 'assets/style-explorer.html'),
    '<meta content="connect-src \'none\'"><main>HOT PRO</main><script>const DATA = /*__OIL_UI_DATA__*/ null;\n</script>',
  );
  await writeFile(
    join(pro, 'scripts/shoot.mjs'),
    `import{writeFile}from'node:fs/promises';import{join}from'node:path';const args=process.argv.slice(2);await writeFile(join(args[args.indexOf('--out')+1],'pro.png'),'pro image');console.log('Hot Pro script');`,
  );
  await w.explorer(cwd, {});
  const html = await readFile(join(cwd, 'style-explorer.html'), 'utf8');
  expect(html).toContain('HOT PRO');
  expect(explorerData(html).edition).toBe('pro');
  expect(await w.shoot(cwd, {})).toMatchObject({ ok: true, stdout: 'Hot Pro script\n' });

  await rm(pro, { recursive: true });
  await w.explorer(cwd, {});
  expect(explorerData(await readFile(join(cwd, 'style-explorer.html'), 'utf8')).edition).toBe('open');
});

const IMAGE_MOCK = `const fs=require('node:fs');const a=process.argv.slice(2);const value=k=>a[a.indexOf(k)+1];const promptFile=value('--prompt-file'),out=value('--out');const prompt=fs.readFileSync(promptFile,'utf8');fs.writeFileSync(out,'image fixture');console.log(JSON.stringify({outputs:[out],model:a.includes('--model')?value('--model'):'mock-image-model',promptFile,prompt,mode:a[0],args:a}));`;

async function imageWorkbench(body = IMAGE_MOCK) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-image-')));
  roots.push(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const script = join(root, 'mock-image.cjs');
  await writeFile(script, body);
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
  const w = new DesignWorkbench(0, { preferPro: false, imageGenScript: script });
  instances.push(w);
  return { w, cwd };
}

async function promptsIn(directory: string) {
  return (await readdir(directory)).filter(name => name.startsWith('.prompt-'));
}

describe('managed image generation and editing in cwd', () => {
  it('validates prompts, modes, dimensions, output and reference paths before running', async () => {
    const { w, cwd } = await imageWorkbench();
    for (const invalid of [
      { prompt: '' },
      { mode: 'unknown' },
      { mode: 'edit' },
      { size: '0x100' },
      { size: 'wide' },
      { quality: 'ultra' },
      { background: 'blue' },
      { out: 'x.svg' },
      { background: 'transparent', out: 'x.jpg' },
      { timeoutMs: 900001 },
      { out: '../outside.png' },
      { images: Array(17).fill('x.png') },
      { images: ['missing.png'] },
      { images: ['../outside.png'] },
      { images: ['a.png'], mode: 'generate' },
    ]) {
      await expect(w.image(cwd, { prompt: 'Test', ...invalid } as ImageRequest)).rejects.toThrow();
    }
    expect(ManagedProcesses.prototype.runCommand).not.toHaveBeenCalled();
  });

  it('generates an asset using prompt-file and removes the temporary prompt', async () => {
    const { w, cwd } = await imageWorkbench();
    const prompt = 'A transparent porcelain vase. Literal shell text: $(echo untouched)';
    const result = await w.image(cwd, { prompt, background: 'transparent', model: 'test-model' });
    expect(result).toMatchObject({
      ok: true,
      mode: 'generate',
      model: 'test-model',
      size: '1024x1024',
      quality: 'medium',
      background: 'transparent',
      outputFiles: [join(cwd, 'assets/generated.png')],
    });
    expect(result.data).toMatchObject({ prompt, mode: 'generate' });
    const args = result.data?.args as string[];
    expect(args).toContain('--json');
    expect(args).not.toContain('--force');
    expect(args).toContain('--prompt-file');
    expect(args).not.toContain(prompt);
    expect(ManagedProcesses.prototype.runCommand).toHaveBeenCalledWith('python3', expect.any(Array), cwd, 180000, undefined);
    expect(await readFile(result.outputFiles[0]!, 'utf8')).toBe('image fixture');
    expect(await promptsIn(join(cwd, 'assets'))).toEqual([]);
    await expect(readFile(String(result.data?.promptFile))).rejects.toThrow();
    const next = await w.image(cwd, { prompt: 'Keep existing', force: false });
    expect(next.outputFiles).toEqual([join(cwd, 'assets/generated-1.png')]);
    await expect(w.image(cwd, { prompt: 'Keep existing', out: 'assets/generated.png' })).rejects.toThrow('already exists');
    const forced = await w.image(cwd, { prompt: 'Replace', force: true });
    expect(forced.data?.args).toContain('--force');
  });

  it('defaults to edit with media/screenshot references and supports explicit edit mode', async () => {
    const { w, cwd } = await imageWorkbench();
    await mkdir(join(cwd, 'assets/media'), { recursive: true });
    await mkdir(join(cwd, 'shots'), { recursive: true });
    await writeFile(join(cwd, 'assets/media/object.png'), 'reference one');
    await writeFile(join(cwd, 'shots/screen.png'), 'reference two');
    const images = ['assets/media/object.png', 'shots/screen.png'];
    const result = await w.image(cwd, {
      prompt: 'Use image 1 in the composition of image 2',
      images,
      out: 'assets/variant.webp',
      size: '1536x1024',
      quality: 'high',
    });
    expect(result).toMatchObject({ ok: true, mode: 'edit', size: '1536x1024', quality: 'high' });
    const args = result.data?.args as string[];
    expect(args.filter(arg => arg === '--image')).toHaveLength(2);
    for (const image of images) expect(args).toContain(join(cwd, image));
    const explicit = await w.image(cwd, {
      prompt: 'Edit',
      mode: 'edit',
      images: [images[0]!],
      out: 'assets/second.jpeg',
      size: 'auto',
      force: false,
    });
    expect(explicit.ok).toBe(true);
    expect(explicit.data?.args).not.toContain('--force');
    expect((await fetch(`${await w.preview(cwd)}/assets/second.jpeg`)).headers.get('content-type')).toBe('image/jpeg');
    expect(await promptsIn(join(cwd, 'assets'))).toEqual([]);
  });

  it('cleans prompts after a nonzero exit and malformed JSON', async () => {
    const { w, cwd } = await imageWorkbench(`console.error('mock generation failed');console.log('not JSON');process.exitCode=1;`);
    expect(await w.image(cwd, { prompt: 'Fail safely' })).toMatchObject({
      ok: false,
      outputFiles: [],
      data: null,
      stderr: expect.stringContaining('mock generation failed'),
    });
    expect(await promptsIn(join(cwd, 'assets'))).toEqual([]);
  });

  it('cleans prompts on timeout, cancellation and executor rejection', async () => {
    const { w, cwd } = await imageWorkbench(`setInterval(()=>{},1000);`);
    const result = await w.image(cwd, { prompt: 'Wait', timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('timed out');
    const controller = new AbortController();
    controller.abort();
    await expect(w.image(cwd, { prompt: 'Cancelled' }, controller.signal)).rejects.toThrow('aborted');
    vi.mocked(ManagedProcesses.prototype.runCommand).mockRejectedValueOnce(new Error('python3 unavailable'));
    await expect(w.image(cwd, { prompt: 'Unavailable' })).rejects.toThrow('python3 unavailable');
    expect(await promptsIn(join(cwd, 'assets'))).toEqual([]);
  });

  it('reports a missing local image-gen installation without starting an executor', async () => {
    const { w, cwd } = await setup();
    await expect(w.image(cwd, { prompt: 'An object' })).rejects.toThrow('Local image-gen script not found');
  });
});

it('streams preview files with HEAD, bounded/open/suffix ranges and unsatisfiable range responses', async () => {
  const { w, cwd } = await setup();
  await writeFile(join(cwd, 'video.mp4'), '0123456789');
  await writeFile(join(cwd, 'empty.txt'), '');
  const url = `${await w.preview(cwd)}/video.mp4`;
  const head = await fetch(url, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe('10');
  expect(head.headers.get('accept-ranges')).toBe('bytes');
  expect(await head.text()).toBe('');
  for (const [range, body, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=8-', '89', 'bytes 8-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-999', '89', 'bytes 8-9/10'],
  ]) {
    const res = await fetch(url, { headers: { Range: range! } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(contentRange);
    expect(await res.text()).toBe(body);
  }
  const rangedHead = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
  expect(rangedHead.headers.get('content-length')).toBe('4');
  expect(await rangedHead.text()).toBe('');
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=abc', 'bytes=1-2,5-6']) {
    const res = await fetch(url, { headers: { Range: range } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  }
  expect(await (await fetch(`${await w.preview(cwd)}/empty.txt`)).text()).toBe('');
});

it('rejects an external manifest symlink before writing an inferred explorer manifest', async () => {
  const { w, cwd, root } = await setup();
  await mkdir(join(cwd, 'explore'));
  for (const id of ['a', 'b', 'c']) await writeFile(join(cwd, `explore/${id}.html`), `<title>${id}</title>`);
  const outside = join(root, 'outside.json');
  await writeFile(outside, 'do not overwrite');
  await symlink(outside, join(cwd, 'explore/manifest.json'));
  await expect(w.explorer(cwd, {})).rejects.toThrow('within');
  expect(await readFile(outside, 'utf8')).toBe('do not overwrite');
});

it('forwards selector as a native element crop without adding steps or marks', async () => {
  const { w, cwd } = await scriptedWorkbench(
    `import{writeFile}from'node:fs/promises';import{join}from'node:path';const args=process.argv.slice(2);await writeFile(join(args[args.indexOf('--out')+1],'crop.png'),'crop');console.log(JSON.stringify(args));`,
  );
  const result = await w.shoot(cwd, { selector: '  #hero > .card  ' });
  expect(result).toMatchObject({ ok: true, selectorMode: 'crop', outputFiles: [join(cwd, 'shots/desktop.png')] });
  const args = JSON.parse(result.stdout);
  expect(args.slice(args.indexOf('--selector'), args.indexOf('--selector') + 2)).toEqual(['--selector', '#hero > .card']);
  expect(args).not.toContain('--steps');
  expect(args).not.toContain('--mark');
});

it.each([
  { target: 'explore', manifest: false, index: false },
  { target: ['explore/a.html', 'explore/b.html'], manifest: false, index: false },
  { target: 'explore/a.html, explore/b.html', manifest: false, index: false },
  { target: 'explore/manifest.json', manifest: true, index: false },
  { target: 'explore', manifest: true, index: true },
  { target: ['explore/a.html'], manifest: false, index: false },
])('forwards batch target $target to the real shoot.mjs dry-run parser', async ({ target, manifest, index }) => {
  const { w, cwd } = await setup();
  await mkdir(join(cwd, 'explore'));
  for (const id of ['a', 'b', 'style-explorer']) await writeFile(join(cwd, `explore/${id}.html`), `<title>${id}</title>`);
  if (index) await writeFile(join(cwd, 'explore/index.html'), '<title>Index</title>');
  if (manifest) await writeFile(join(cwd, 'explore/manifest.json'), JSON.stringify({
    candidates: [{ id: 'b', source: 'b.html' }, { id: 'a', source: 'a.html' }],
  }));
  const run = vi.spyOn(ManagedProcesses.prototype, 'run');
  const preview = vi.spyOn(w, 'preview');
  const result = await w.shoot(cwd, { target, noSheet: true, dryRun: true });
  expect(result.ok, result.stderr).toBe(true);
  expect(result.outputFiles).toEqual([]);
  const localTargets = Array.isArray(target) ? target : target.split(',').map(p => p.trim());
  expect(run.mock.calls[0]?.[1]).toEqual([
    ...localTargets.map(p => join(cwd, p)), '--size', '1440x900', '--no-sheet', '--dry-run', '--out', join(cwd, 'shots'),
  ]);
  expect(preview).not.toHaveBeenCalled();
  const parsed = JSON.parse(result.stdout);
  const expectedTargets = (manifest ? ['b', 'a'] : Array.isArray(target) && target.length === 1 ? ['a'] : ['a', 'b'])
    .map(id => join(cwd, `explore/${id}.html`));
  expect(parsed.targets ?? [parsed.target]).toEqual(expectedTargets);
  expect(parsed.flags).toContain('no-sheet');
  expect(parsed.options.out).toBe(join(cwd, 'shots'));
  await expect(w.shoot(cwd, { target, out: 'shots/single.png', dryRun: true })).rejects.toThrow('directory');
});

it('validates every local batch target before starting the screenshot engine', async () => {
  const { w, cwd, root } = await setup();
  await writeFile(join(cwd, 'index.html'), '<title>Home</title>');
  await writeFile(join(root, 'outside.html'), 'private');
  await symlink(root, join(cwd, 'linked'));
  const run = vi.spyOn(ManagedProcesses.prototype, 'run');
  for (const target of [
    [], ['index.html', ''], ['index.html', 'missing.html'], ['index.html', '../outside.html'],
    ['index.html', 'linked/outside.html'], 'index.html, ../outside.html',
  ]) {
    await expect(w.shoot(cwd, { target, dryRun: true })).rejects.toThrow();
  }
  expect(run).not.toHaveBeenCalled();
});

it('keeps preview URLs for index directories and preserves HTTP targets containing commas', async () => {
  const { w, cwd } = await setup();
  await mkdir(join(cwd, 'site'));
  await writeFile(join(cwd, 'site/index.html'), '<title>Site</title>');
  for (const target of ['site?state=ready#hero', 'https://example.com/page?tags=a,b#hero']) {
    const result = await w.shoot(cwd, { target, dryRun: true, noSheet: false });
    expect(result.ok, result.stderr).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.target).toMatch(target.startsWith('https:') ? /^https:\/\/example\.com\/page\?tags=a,b#hero$/ :
      /^http:\/\/127\.0\.0\.1:\d+\/site\/index\.html\?state=ready#hero$/);
    expect(parsed.options.out).toContain('.shoot-tmp-');
    expect(parsed.flags).not.toContain('no-sheet');
  }
});

it('parses native selector crops and rejects incompatible modes in the real shoot.mjs dry-run', async () => {
  const { w, cwd } = await setup();
  await writeFile(join(cwd, 'index.html'), '<main id="hero">Hero</main>');
  const result = await w.shoot(cwd, { selector: '  #hero  ', dryRun: true });
  expect(result.ok, result.stderr).toBe(true);
  expect(JSON.parse(result.stdout)).toMatchObject({
    selector: { kind: 'css', value: '#hero' }, options: { selector: '#hero' }, groups: [], marks: [],
  });
  for (const input of [{ fullPage: true }, { record: true }, { motion: true }, { entry: true }, { evidence: true }]) {
    const conflict = await w.shoot(cwd, { ...input, selector: '#hero', dryRun: true });
    expect(conflict.ok).toBe(false);
    expect(conflict.stderr).toContain('--selector');
  }
});

it('uses real shoot.mjs dry-run parsing for uppercase presets, dimensions and string booleans', async () => {
  const { w, cwd } = await setup();
  await writeFile(join(cwd, 'index.html'), '<title>Native dry-run</title>');
  for (const size of ['DESKTOP', '1440X900']) {
    const result = await w.shoot(cwd, { target: 'index.html?state=ready#hero', size, record: 'false', motion: 'false', dryRun: true });
    expect(result.ok, result.stderr).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sizes).toEqual([{ w: 1440, h: 900 }]);
    expect(parsed.flags).not.toContain('record');
    expect(parsed.flags).not.toContain('motion');
    expect(result.stdout).toContain('?state=ready#hero');
  }
  for (const input of [{ states: ['idle', 'done'] }, { evidence: true }, { size: 'desktop,mobile' }, { record: true }]) {
    await expect(w.shoot(cwd, { ...input, out: 'shots/single.png' })).rejects.toThrow('directory');
  }
  const single = await w.shoot(cwd, { out: 'shots/single.png', record: 'false', motion: 'false', dryRun: true });
  expect(single.ok, single.stderr).toBe(true);
  expect((await readdir(join(cwd, 'shots'))).some(name => name.startsWith('.shoot-tmp-'))).toBe(false);
});

it('maps preview and array options through the real media parser, surfaces failed copies, and ignores unrelated output symlinks', async () => {
  const { w, cwd, root } = await setup();
  const modulePath = join(process.cwd(), 'skills/oil-ui/scripts/curate-media.mjs');
  const { parseArgs } = await import(modulePath);
  await mkdir(join(cwd, 'candidates'));
  await symlink(root, join(cwd, 'candidates/unrelated'));
  const commands: { command: string; opts: Record<string, unknown> }[] = [];
  vi.spyOn(ManagedProcesses.prototype, 'run').mockImplementation(async (_script, args) => {
    const parsed = parseArgs(args);
    commands.push(parsed);
    if (parsed.command === 'preview') {
      const sheetImage = join(cwd, 'candidates/sheet.png');
      await writeFile(sheetImage, 'sheet');
      return { ok: true, timedOut: false, exitCode: 0, stdout: JSON.stringify({ sheetImage, items: [] }), stderr: '' };
    }
    return { ok: true, timedOut: false, exitCode: 0, stdout: JSON.stringify({ items: [], files: [] }), stderr: '' };
  });
  expect(await w.media(cwd, { action: 'preview', refs: ['L1'], dir: 'candidates', out: 'shots/preview.png' })).toMatchObject({ ok: true, sheetPath: join(cwd, 'shots/preview.png') });
  expect(await readFile(join(cwd, 'shots/preview.png'), 'utf8')).toBe('sheet');
  await w.media(cwd, { action: 'search', query: 'bridge', dir: 'candidates', sources: ['loc'] });
  await w.media(cwd, { action: 'fetch', refs: ['L1'], dir: 'assets', maps: ['normal', 'roughness'], sheet: false });
  expect(commands.every(command => command.opts.cache === join(cwd, '.curate-cache.json'))).toBe(true);
  expect(commands[2]!.opts.maps).toEqual(['normal', 'roughness']);
  await mkdir(join(cwd, 'shots/is-directory.png'));
  await expect(w.media(cwd, { action: 'preview', refs: 'L1', dir: 'candidates', out: 'shots/is-directory.png' })).rejects.toThrow();
});

it('executes real curate-media search in candidates and fetch in assets using one workspace cache', async () => {
  const realScript = join(process.cwd(), 'skills/oil-ui/scripts/curate-media.mjs');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=';
  // Only network responses are fixtures: parsing, cache allocation, numbering, downloading and SOURCES.md are real.
  const wrapper = `import{main}from ${JSON.stringify(realScript)};
    globalThis.fetch=async url=>{
      if(String(url).includes('/collections/'))return Response.json({results:[{title:'Bridge drawing',id:'https://www.loc.gov/item/bridge/',rights:'Public domain',resources:[{image:'https://fixture.invalid/sheet/bridge.png',url:'https://www.loc.gov/item/bridge/'}]}]});
      if(String(url).includes('fixture.invalid/sheet/'))return new Response(Buffer.from('${png}','base64'),{headers:{'content-type':'image/png'}});
      throw Error('Unexpected network request: '+url);
    };await main();`;
  const { w, cwd } = await scriptedWorkbench('', wrapper);
  const search = await w.media(cwd, { action: 'search', query: 'bridge', kind: 'blueprint', dir: 'candidates', sources: ['loc'] });
  expect(search.ok, search.stderr).toBe(true);
  expect(search.count).toBe(1);
  const ref = String((search.items[0] as Record<string, unknown>).ref);
  const cache = JSON.parse(await readFile(join(cwd, '.curate-cache.json'), 'utf8'));
  expect(cache.items[ref].title).toBe('Bridge drawing');
  const fetched = await w.media(cwd, { action: 'fetch', refs: [ref], dir: 'assets', sheet: false });
  expect(fetched.ok, `${fetched.stderr}\n${JSON.stringify(fetched.errors)}`).toBe(true);
  expect(fetched.count).toBe(1);
  expect(await readFile(String((fetched.items[0] as Record<string, unknown>).saved))).toEqual(Buffer.from(png, 'base64'));
  expect(await readFile(join(cwd, 'assets/SOURCES.md'), 'utf8')).toContain('Bridge drawing');
}, 20000);

it('reuses candidate bytes across inferred metadata and embedding, and caches the embedder root realpath', async () => {
  const fs = await import('node:fs/promises');
  const { Embedder } = await import('../src/explorer.ts');
  const { w, cwd } = await setup();
  await mkdir(join(cwd, 'explore'));
  for (const id of ['a', 'b', 'c']) await writeFile(join(cwd, `explore/${id}.html`), `<title>${id}</title>`);
  const reads = vi.mocked(fs.readFile);
  reads.mockClear();
  await w.explorer(cwd, {});
  for (const id of ['a', 'b', 'c']) {
    expect(reads.mock.calls.filter(([path]) => path === join(cwd, `explore/${id}.html`))).toHaveLength(1);
  }
  const paths = vi.mocked(fs.realpath);
  paths.mockClear();
  const embed = new Embedder(cwd);
  await embed.path('explore/a.html', cwd);
  await embed.path('explore/b.html', cwd);
  expect(paths.mock.calls.filter(([path]) => path === cwd)).toHaveLength(1);
});
