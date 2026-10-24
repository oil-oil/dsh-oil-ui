import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SHOOT = ROOT / 'scripts/shoot.mjs'
CURATE = ROOT / 'scripts/curate-media.mjs'
EXPLORER = ROOT / 'scripts/build_explorer.py'
PREP = ROOT / 'scripts/prep-image.mjs'
NODE = shutil.which('node')
GIT = shutil.which('git')


class WorkdirTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='oil-workdir-中文 #%-')
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)

    def test_gitignore_covers_only_process_files_and_tasks_stay_separate(self):
        if not GIT:
            self.skipTest('Git is required')
        subprocess.run([GIT, 'init', '-q'], cwd=self.project, check=True, capture_output=True)
        root = self.project / '.oil-ui'
        first = root / 'alpha'
        second = root / 'beta'
        first.mkdir(parents=True)
        second.mkdir(parents=True)
        (root / '.gitignore').write_text('*\n!.gitignore\n', encoding='utf-8')
        (first / 'page.png').write_bytes(b'first')
        (second / 'page.png').write_bytes(b'second')
        subprocess.run([GIT, 'check-ignore', '-q', '.oil-ui/alpha/page.png'], cwd=self.project, check=True)
        status = subprocess.run([GIT, 'status', '--porcelain', '--untracked-files=all'], cwd=self.project,
                                check=True, capture_output=True, text=True, encoding='utf-8').stdout
        self.assertEqual(status, '?? .oil-ui/.gitignore\n')
        self.assertEqual((first / 'page.png').read_bytes(), b'first')
        self.assertEqual((second / 'page.png').read_bytes(), b'second')
        self.assertIn('*\n!.gitignore\n', (ROOT / 'references/workdir.md').read_text(encoding='utf-8'))

    def test_shoot_explicit_root_preserves_shared_assets_and_output_paths(self):
        from test_shoot import find_browser
        if not NODE or not find_browser():
            self.skipTest('Node and a local browser are required')
        (self.project / 'pages').mkdir()
        (self.project / 'assets').mkdir()
        (self.project / 'assets/shared.css').write_text('body { color: rgb(1, 2, 3); }', encoding='utf-8')
        page = self.project / 'pages/page.html'
        page.write_text('''<!doctype html><html><head><meta charset="utf-8"><title>工作区</title>
<link rel="stylesheet" href="../assets/shared.css"></head><body><h1>测试页面</h1><script>
if (getComputedStyle(document.body).color !== 'rgb(1, 2, 3)') console.error('SHARED_ASSET_MISSING');
</script></body></html>''', encoding='utf-8')
        work = self.project / '.oil-ui' / '截图 任务'
        candidate = work / 'explore/candidate.html'
        candidate.parent.mkdir(parents=True)
        outside_file = Path(str(self.project) + '-outside.html')
        outside_file.write_text('outside fixture', encoding='utf-8')
        self.addCleanup(lambda: outside_file.unlink(missing_ok=True))
        (work / '.env').write_text('synthetic', encoding='utf-8')
        (work / 'credentials.json').write_text('synthetic', encoding='utf-8')
        (work / 'escape.txt').symlink_to(outside_file)
        (self.project / '.git').mkdir()
        (self.project / '.git/config').write_text('synthetic', encoding='utf-8')
        candidate.write_text('''<!doctype html><html><head><meta charset="utf-8"><title>候选</title>
<link rel="stylesheet" href="../../../assets/shared.css"></head><body>候选页面<script type="module">
if (getComputedStyle(document.body).color !== 'rgb(1, 2, 3)') console.error('SHARED_ASSET_MISSING');
const root = encodeURI('/.oil-ui/截图 任务');
for (const path of [`${root}/.env`, `${root}/credentials.json`, `${root}/escape.txt`, '/.git/config']) {
  if ((await fetch(path)).status !== 404) console.error('WORKSPACE_SECRET_LEAK ' + path);
}
console.error('CANDIDATE_LOADED');
</script></body></html>''', encoding='utf-8')
        env = dict(os.environ, CHROME_PATH=find_browser())
        result = subprocess.run([NODE, str(SHOOT), f'{page},{candidate}', '--root', str(self.project), '--out', str(work / 'shots')], cwd=work, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((work / 'shots/page.png').is_file())
        self.assertTrue((work / 'shots/candidate.png').is_file())
        report = json.loads((work / 'shots/report.json').read_text(encoding='utf-8'))
        self.assertNotIn('SHARED_ASSET_MISSING', json.dumps(report))
        self.assertNotIn('WORKSPACE_SECRET_LEAK', json.dumps(report))
        self.assertIn('CANDIDATE_LOADED', json.dumps(report))
        self.assertFalse((self.project / 'shots').exists())
        explicit = self.project / 'formal-evidence'
        result = subprocess.run([NODE, str(SHOOT), str(page), '--root', str(self.project), '--out', str(explicit)], cwd=work, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((explicit / 'page.png').is_file())
        result = subprocess.run([NODE, str(SHOOT), str(page), '--out', str(self.project / 'default-shots')], cwd=self.project, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        default_report = json.loads((self.project / 'default-shots/report.json').read_text(encoding='utf-8'))
        self.assertIn('SHARED_ASSET_MISSING', json.dumps(default_report))
        outside = self.project / 'outside'
        outside.mkdir()
        result = subprocess.run([NODE, str(SHOOT), str(page), '--root', str(outside), '--out', str(work / 'other-shots')], cwd=work, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=90)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('不在 --root', result.stderr)
        result = subprocess.run([NODE, str(SHOOT), f'{page},{outside_file}', '--root', str(self.project), '--out', str(work / 'mixed-shots')], cwd=work, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=90)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('不在 --root', result.stderr)
        for broad_root in (Path(tempfile.gettempdir()), Path('/')):
            result = subprocess.run([NODE, str(SHOOT), str(page), '--root', str(broad_root), '--out', str(work / 'broad-shots')], cwd=work, env=env,
                                    capture_output=True, text=True, encoding='utf-8', timeout=90)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('范围过宽', result.stderr)

    def test_curate_defaults_to_task_workdir_and_honors_explicit_paths(self):
        from test_curate_media import CurateMediaTests
        if not NODE:
            self.skipTest('Node is required')
        CurateMediaTests.setUpClass()
        self.addCleanup(CurateMediaTests.tearDownClass)
        fixture = CurateMediaTests('run_cli')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        project = fixture.cwd
        work = project / '.oil-ui' / '素材任务'
        work.mkdir(parents=True)
        result = subprocess.run(fixture.cli_command('search', 'wood', '--kind', 'texture', '--limit', '1', fixture=True),
                                cwd=work, capture_output=True, text=True, encoding='utf-8', timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((work / '.curate-cache.json').is_file())
        result = subprocess.run(fixture.cli_command('fetch', fixture.base + '/image'), cwd=work,
                                capture_output=True, text=True, encoding='utf-8', timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(list((work / 'assets').glob('*.png')))
        self.assertFalse((project / 'assets').exists())
        explicit = project / 'formal-assets'
        result = subprocess.run(fixture.cli_command('fetch', fixture.base + '/image', '--dir', str(explicit)), cwd=work,
                                capture_output=True, text=True, encoding='utf-8', timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(list(explicit.glob('*.png')))
        cache = project / 'formal-cache.json'
        result = subprocess.run(fixture.cli_command('search', 'wood', '--kind', 'texture', '--limit', '1', '--cache', str(cache), fixture=True),
                                cwd=work, capture_output=True, text=True, encoding='utf-8', timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(cache.is_file())
        shared = project / '.curate-cache.json'
        result = subprocess.run(fixture.cli_command('search', 'wood', '--kind', 'texture', '--limit', '1', fixture=True),
                                cwd=project, capture_output=True, text=True, encoding='utf-8', timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        other = project / '.oil-ui' / '另一个素材任务'
        other.mkdir(parents=True)
        result = subprocess.run(fixture.cli_command('search', 'wood', '--kind', 'texture', '--limit', '1', '--dir', str(project / 'assets'), fixture=True),
                                cwd=other, capture_output=True, text=True, encoding='utf-8', timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['cache'], str(shared))
        local = other / '.curate-cache.json'
        result = subprocess.run(fixture.cli_command('search', 'wood', '--kind', 'texture', '--limit', '1', '--dir', str(project / 'assets'), '--cache', str(local), fixture=True),
                                cwd=other, capture_output=True, text=True, encoding='utf-8', timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['cache'], str(local))

    def test_explorer_stays_with_candidates_and_explicit_output(self):
        work = self.project / '.oil-ui' / '候选任务'
        candidates = work / 'explore'
        candidates.mkdir(parents=True)
        (candidates / 'a.html').write_text('<!doctype html><html><head><meta charset="utf-8"><title>候选 A</title></head><body>A</body></html>', encoding='utf-8')
        result = subprocess.run([sys.executable, str(EXPLORER), 'explore'], cwd=work,
                                capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((candidates / 'style-explorer.html').is_file())
        self.assertFalse((work / 'style-explorer.html').exists())
        explicit = self.project / 'delivery' / 'comparison.html'
        explicit.parent.mkdir()
        result = subprocess.run([sys.executable, str(EXPLORER), 'explore', '--output', str(explicit)], cwd=work,
                                capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(explicit.is_file())
        other = self.project / '.oil-ui' / '另一个任务'
        (other / 'explore').mkdir(parents=True)
        (other / 'explore/b.html').write_text('<!doctype html><html><head><meta charset="utf-8"><title>候选 B</title></head><body>B</body></html>', encoding='utf-8')
        result = subprocess.run([sys.executable, str(EXPLORER), 'explore'], cwd=other,
                                capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((candidates / 'style-explorer.html').is_file())
        self.assertTrue((other / 'explore/style-explorer.html').is_file())
        self.assertIn('候选 A', (candidates / 'style-explorer.html').read_text(encoding='utf-8'))


    def test_prep_final_assets_and_srcset_use_project_root(self):
        from test_shoot import find_browser, write_solid_png
        from urllib.parse import unquote
        if not NODE or not find_browser():
            self.skipTest('Node and a local browser are required')
        work = self.project / '.oil-ui' / '图片任务'
        source = work / 'assets/source.png'
        source.parent.mkdir(parents=True)
        write_solid_png(source, 256, 256, (120, 80, 40))
        output = self.project / 'assets/web'
        env = dict(os.environ, CHROME_PATH=find_browser())
        result = subprocess.run([NODE, str(PREP), str(source), '--widths', '64,128,256', '--out', str(output)], cwd=self.project, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload['errors'], [])
        self.assertGreaterEqual(len(payload['files'][0]['outputs']), 2)
        html = payload['files'][0]['html']
        src = html.split('src="', 1)[1].split('"', 1)[0]
        srcset = html.split('srcset="', 1)[1].split('"', 1)[0]
        candidates = [item.rsplit(' ', 1)[0] for item in srcset.split(', ')]
        self.assertGreaterEqual(len(candidates), 2)
        for url in [src, *candidates]:
            self.assertFalse(url.startswith(('/', 'file:', 'http:', 'https:')), url)
            self.assertFalse(url.startswith('../'), url)
            self.assertNotIn('.oil-ui', url)
            self.assertTrue((self.project / unquote(url)).is_file(), url)


if __name__ == '__main__':
    unittest.main()
