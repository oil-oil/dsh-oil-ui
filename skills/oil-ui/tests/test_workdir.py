import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_curate_media import CurateMediaTests
from test_shoot import find_browser

ROOT = Path(__file__).resolve().parents[1]
SHOOT = ROOT / 'scripts/shoot.mjs'
CURATE = ROOT / 'scripts/curate-media.mjs'
EXPLORER = ROOT / 'scripts/build_explorer.py'
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

    def test_shoot_defaults_to_task_workdir_and_honors_explicit_output(self):
        if not NODE or not find_browser():
            self.skipTest('Node and a local browser are required')
        page = self.project / 'page.html'
        page.write_text('<!doctype html><html><head><meta charset="utf-8"><title>工作区</title></head><body><h1>测试页面</h1></body></html>', encoding='utf-8')
        work = self.project / '.oil-ui' / '截图 任务'
        work.mkdir(parents=True)
        env = dict(os.environ, CHROME_PATH=find_browser())
        result = subprocess.run([NODE, str(SHOOT), str(page)], cwd=work, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((work / 'shots/page.png').is_file())
        self.assertTrue((work / 'shots/report.json').is_file())
        self.assertFalse((self.project / 'shots').exists())
        explicit = self.project / 'formal-evidence'
        result = subprocess.run([NODE, str(SHOOT), str(page), '--out', str(explicit)], cwd=work, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((explicit / 'page.png').is_file())

    def test_curate_defaults_to_task_workdir_and_honors_explicit_paths(self):
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


if __name__ == '__main__':
    unittest.main()
