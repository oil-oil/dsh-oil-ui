"""Exercise image preparation using real Chrome and only Python/Node standard libraries."""
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib

from test_shoot import find_browser

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/prep-image.mjs'
NODE = shutil.which('node')
BROWSER = find_browser()


def png(path, width, height, pixel):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = b''.join(b'\0' + bytes(v for x in range(width) for v in pixel(x, y)) for y in range(height))
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


@unittest.skipUnless(NODE, 'Node is not installed')
class PrepImageCLITests(unittest.TestCase):
    def run_cli(self, *args, code=0):
        result = subprocess.run([NODE, str(SCRIPT), *map(str, args)], cwd=ROOT,
                                capture_output=True, text=True, encoding='utf-8', timeout=120,
                                env=dict(os.environ, **({'CHROME_PATH': BROWSER} if BROWSER else {})))
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result

    def test_parse_args_and_windows_file_url(self):
        javascript = r"""import assert from 'node:assert/strict';
import {parseArgs, fileUrl} from %s;
for (const args of [[], ['-h'], ['--help'], ['--HELP']]) assert.deepEqual(parseArgs(args), {help: true});
assert.deepEqual(parseArgs(['--', '--help']).inputs, ['--help']);
assert.deepEqual(parseArgs(['--', '-h']).inputs, ['-h']);
assert.deepEqual(parseArgs(['input.png', '--', '--help']).inputs, ['input.png', '--help']);
assert.equal(fileUrl(String.raw`C:\project\assets\my image#1.webp`, String.raw`C:\project`, 'win32'),
             'assets/my%%20image%%231.webp');
assert.equal(fileUrl(String.raw`D:\web\my image#1.webp`, String.raw`C:\project`, 'win32'),
             'file:///D:/web/my%%20image%%231.webp');
""" % json.dumps(SCRIPT.as_uri())
        subprocess.run([NODE, '--input-type=module', '-e', javascript], cwd=ROOT, check=True,
                       capture_output=True, text=True, encoding='utf-8', timeout=10)

    def test_help_and_actionable_validation_without_browser(self):
        self.assertIn('用法', self.run_cli('--HELP').stdout)
        self.assertIn('本地预览、截图验收和部署', self.run_cli('--HELP').stdout)
        for args, expected in [(['--widht', '2'], '不认识'), (['--width', '0px'], '--width 960px'),
                               (['--widths', ',,'], '宽度列表为空'), (['--crop', '16:no'], '--crop 16:9'),
                               (['--crop', '0:0'], '--crop 16:9'), (['--focus', 'left'], '--focus 需要 --crop'),
                               (['--crop', '16:9', '--focus', '101%,0%'], '焦点超出'),
                               (['--format', 'avif'], '--format webp'), (['--quality', '101'], '--quality 82'),
                               (['--trim=true'], '--trim 不带值'), (['--format', 'png', '--quality', '80'], 'PNG'),
                               (['--width', '3', '--widths', '3,6'], '选一个')]:
            with self.subTest(args=args):
                self.assertIn(expected, self.run_cli('input.png', *args, code=1).stderr)

    def test_missing_bad_files_and_empty_directory_report_rerun(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp); (folder / 'bad.png').write_text('<html>not an image</html>', encoding='utf-8')
            (folder / 'bad.jpg').write_bytes(b'\xff\xd8\xffbroken')
            (folder / 'empty').mkdir()
            result = self.run_cli(folder / 'missing.png', folder / 'empty', folder / 'bad.png', code=1)
            data = json.loads(result.stdout)
            self.assertEqual(len(data['errors']), 3)
            self.assertTrue(all('command' in e and 'argv' in e for e in data['errors']))
            self.assertTrue(all(Path(e['argv'][1]) == SCRIPT for e in data['errors']),
                            'Recovery must work when the skill is invoked from another project directory')
            self.assertIn('重跑：node', result.stderr)
            self.assertFalse((folder / 'web-images').exists())

    def test_animation_signatures_are_rejected_without_decoding(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            apng = folder / 'animated.png'
            apng.write_bytes(b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 8) + b'acTL' + b'\0' * 12)
            webp = folder / 'animated.webp'
            webp.write_bytes(b'RIFF' + struct.pack('<I', 12) + b'WEBPANIM' + struct.pack('<I', 0))
            data = json.loads(self.run_cli(apng, webp, code=1).stdout)
            self.assertEqual(len(data['errors']), 2)
            self.assertTrue(all('动画' in e['message'] for e in data['errors']))


@unittest.skipUnless(NODE and BROWSER, 'Node and Chrome/Chromium/Edge are needed')
class PrepImageBrowserTests(PrepImageCLITests):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='oil-image-tests-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.out = self.folder / 'output'
        self.source = self.folder / 'source image.png'
        # Noise compresses poorly as PNG but well with lossy WebP. Transparent/partial-alpha
        # boundaries ensure alpha is checked after decoding the delivered file, not by extension.
        png(self.source, 180, 120, lambda x, y: ((x * 71 + y * 37) % 256, (x * 17 + y * 93) % 256,
                                               (x * 117 + y * 7) % 256,
                                               0 if x < 20 or y < 10 or x >= 160 or y >= 110 else (128 if x == 20 else 255)))

    def prepare(self, *args, code=0):
        result = self.run_cli(*args, '--out', self.out, code=code)
        return json.loads(result.stdout), result

    def pixels(self, file, points):
        # Independent browser decode of actual saved bytes, including fallback files.
        js = """import {readFileSync} from 'node:fs';
import {canvasBrowser} from './scripts/prep-image.mjs';
const b=await canvasBrowser();try {const data=readFileSync(process.argv[1]).toString('base64');
console.log(JSON.stringify(await b.evaluate(`(async()=>{const i=new Image();i.src='data:image/png;base64,${data}';await i.decode();
const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;const x=c.getContext('2d');x.drawImage(i,0,0);
return {width:c.width,height:c.height,points:${process.argv[2]}.map(p=>Array.from(x.getImageData(...p,1,1).data))};})()`)));
}finally {await b.close()}"""
        result = subprocess.run([NODE, '--input-type=module', '-e', js, str(file), json.dumps(points)], cwd=ROOT,
                                env=dict(os.environ, CHROME_PATH=BROWSER), check=True, capture_output=True,
                                encoding='utf-8', timeout=120)
        return json.loads(result.stdout)

    def test_preserves_transparency_and_never_upscales(self):
        data, result = self.prepare(self.source, '--WIDTHS=90px,180,1k', '--FORMAT=WEBP', '--quality=82%')
        record = data['files'][0]
        self.assertEqual([(o['width'], o['height']) for o in record['outputs']], [(90, 60), (180, 120)])
        self.assertTrue(all(not o['keptOriginal'] for o in record['outputs']))
        self.assertIn('180w', record['html']); self.assertNotIn('1000w', record['html'])
        self.assertIn('sizes="100vw"', record['html']); self.assertIn('180×120', result.stderr)
        self.assertIn('<img src="', result.stderr, 'Also print directly pasteable HTML without JSON escaping')
        decoded = self.pixels(record['outputs'][-1]['saved'], [[0, 0], [20, 50], [90, 50]])
        self.assertEqual([p[3] for p in decoded['points']], [0, 128, 255])

    def test_smaller_original_is_copied_with_correct_type_and_srcset(self):
        tiny = self.folder / 'tiny wrong.webp'
        png(tiny, 2, 2, lambda x, y: (1, 2, 3, 255))
        data, result = self.prepare(tiny, '--format', 'PNG', '--widths', '1,2,100')
        record = data['files'][0]
        self.assertEqual(len(record['outputs']), 1)
        output = record['outputs'][0]
        self.assertTrue(output['keptOriginal']); self.assertEqual((output['width'], output['height']), (2, 2))
        self.assertEqual(Path(output['saved']).suffix, '.png')
        self.assertEqual(Path(output['saved']).read_bytes(), tiny.read_bytes())
        self.assertIn('保留原图', result.stderr); self.assertIn(' 2w', record['html'])
        self.assertIn('%20', record['html'])

    def test_crop_fallback_keeps_one_composition(self):
        solid = self.folder / 'solid.png'
        png(solid, 100, 100, lambda x, y: (12, 34, 56, 255))
        data, _ = self.prepare(solid, '--format', 'png', '--crop', '2:1', '--widths', '1,100')
        record = data['files'][0]
        self.assertEqual(len(record['outputs']), 1)
        self.assertTrue(record['outputs'][0]['keptOriginal'])
        self.assertEqual((record['outputs'][0]['width'], record['outputs'][0]['height']), (100, 100))
        self.assertIn('不同构图', '\n'.join(record['warnings']))

    def test_batch_errors_do_not_block_good_files_or_overwrite_sources(self):
        source_bytes = self.source.read_bytes()
        (self.folder / 'bad.PNG').write_text('download failed', encoding='utf-8')
        (self.folder / 'ignored.txt').write_text('not a picture', encoding='utf-8')
        (self.folder / 'subdir').mkdir(); (self.folder / 'subdir' / 'bad.png').write_text('skip', encoding='utf-8')
        other = self.folder / 'other'; other.mkdir(); shutil.copyfile(self.source, other / self.source.name)
        data, _ = self.prepare(self.folder, other / self.source.name, self.folder / 'missing.jpg', '--width', '64', code=1)
        self.assertEqual(len(data['files']), 2); self.assertEqual(len(data['errors']), 2)
        saved = [o['saved'] for f in data['files'] for o in f['outputs']]
        self.assertEqual(len(set(saved)), 2)
        self.assertEqual(self.source.read_bytes(), source_bytes)
        old = {p: Path(p).read_bytes() for p in saved}
        self.prepare(self.source, '--width', '64')
        self.assertTrue(all(Path(p).read_bytes() == b for p, b in old.items()))

    def test_trim_exact_alpha_bounds_crop_focus_and_sizes(self):
        data, _ = self.prepare(self.source, '--trim', '--resize', '70PX')
        record = data['files'][0]
        self.assertEqual(record['crop'], {'x': 20, 'y': 10, 'width': 140, 'height': 100})
        self.assertEqual((record['outputs'][0]['width'], record['outputs'][0]['height']), (70, 50))
        # Crop a wide noisy image into left/right squares and inspect retained color dominance.
        wide = self.folder / 'wide.png'
        png(wide, 200, 100, lambda x, y: (180 + (x * y % 70), y * 17 % 60, 0, 255) if x < 100
            else (0, y * 17 % 60, 180 + (x * y % 70), 255))
        for focus, x, channel in [('LEFT', 0, 0), ('100%,0%', 100, 2)]:
            data, _ = self.prepare(wide, '--ratio', '1/1', '--focus', focus, '--width', '50', '--sizes', '50vw')
            record = data['files'][0]; self.assertEqual(record['crop']['x'], x)
            self.assertIn('sizes="50vw"', record['html'])
            px = self.pixels(record['outputs'][0]['saved'], [[25, 25]])['points'][0]
            self.assertGreater(px[channel], 150)

    def test_jpeg_rejects_alpha_but_opaque_jpeg_and_png_encode(self):
        data, _ = self.prepare(self.source, '--format', 'jpg', code=1)
        self.assertIn('--format webp', data['errors'][0]['message'])
        self.assertEqual(data['errors'][0]['argv'][data['errors'][0]['argv'].index('--format') + 1], 'webp')
        # The rest of a mixed batch still succeeds, and truncated JPEG gets a decode error.
        opaque = self.folder / 'opaque.png'; png(opaque, 80, 60, lambda x, y: (x * y % 256, x * 37 % 256, y * 17 % 256, 255))
        (self.folder / 'broken.jpg').write_bytes(b'\xff\xd8\xffbroken')
        data, _ = self.prepare(opaque, self.folder / 'broken.jpg', '--format', 'JpG', '--width', '40', code=1)
        self.assertEqual(len(data['files']), 1); self.assertIn('解码失败', data['errors'][0]['message'])
        self.assertEqual(Path(data['files'][0]['outputs'][0]['saved']).suffix, '.jpg')
        data, _ = self.prepare(self.source, '--format', 'png', '--width', '30')
        decoded = self.pixels(data['files'][0]['outputs'][0]['saved'], [[0, 0], [15, 10]])
        self.assertEqual([p[3] for p in decoded['points']], [0, 255])

    def test_fully_transparent_trim_and_animation_fail_explicitly(self):
        blank = self.folder / 'blank.png'; png(blank, 8, 8, lambda x, y: (0, 0, 0, 0))
        gif = self.folder / 'animated.gif'; gif.write_bytes(b'GIF89a')
        data, _ = self.prepare(blank, gif, '--trim', code=1)
        self.assertEqual(len(data['errors']), 2)
        self.assertIn('完全透明', data['errors'][0]['message']); self.assertIn('静态', data['errors'][1]['message'])

    def test_does_not_follow_symlinks(self):
        link = self.folder / 'linked.png'
        try: link.symlink_to(self.source)
        except (OSError, NotImplementedError): self.skipTest('symlinks unavailable')
        data, _ = self.prepare(link, code=1)
        self.assertIn('符号链接', data['errors'][0]['message'])
        data, _ = self.prepare(self.folder)
        self.assertEqual(len(data['files']), 1)


if __name__ == '__main__':
    unittest.main()
