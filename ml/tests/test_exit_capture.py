"""리포트 '고객이 가장 많이 나간 화면' 캡처가 서버에서도 붙는지 확인한다.

실행 (저장소 루트에서):
    python -m unittest discover -s ml/tests -v

브라우저·DB·네트워크 없이 돈다.
"""
from __future__ import annotations

import base64
import os
import random
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image, ImageDraw

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR))

import exit_capture  # noqa: E402
import report_exact_template as rt  # noqa: E402


class BrowserDiscovery(unittest.TestCase):
    def test_finds_chrome_downloaded_by_deploy_script(self):
        """배포 스크립트가 ~/.cache/ghosttracker-browser 에 받아 둔 Chrome 을 찾아야 한다."""
        with tempfile.TemporaryDirectory() as cache:
            binary = Path(cache) / "chrome-linux64" / "chrome"
            binary.parent.mkdir()
            binary.write_text("#!/bin/sh\n")
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
            env = {"SEER_BROWSER_CACHE": cache, "PATH": ""}
            # 개발 PC 에 설치된 Chrome(/Applications 등)은 없는 것으로 친다
            with mock.patch.dict(os.environ, env, clear=True), \
                 mock.patch("shutil.which", return_value=None), \
                 mock.patch("os.path.isfile", side_effect=lambda p: p == str(binary)):
                self.assertEqual(exit_capture.browser_executable(), str(binary))

    def test_finds_google_chrome_on_path(self):
        def which(name):
            return "/usr/bin/google-chrome" if name == "google-chrome" else None
        with mock.patch("shutil.which", side_effect=which), \
             mock.patch("os.path.isfile", side_effect=lambda p: p == "/usr/bin/google-chrome"), \
             mock.patch("os.access", return_value=True), \
             mock.patch.dict(os.environ, {"SEER_BROWSER_CACHE": "/nonexistent"}, clear=False):
            os.environ.pop("GT_BROWSER_PATH", None)
            os.environ.pop("CHROME_BIN", None)
            self.assertEqual(exit_capture.browser_executable(), "/usr/bin/google-chrome")


class BlankDetection(unittest.TestCase):
    def save(self, image):
        handle = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        image.save(handle.name)
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_empty_and_loading_screens_are_blank(self):
        self.assertTrue(exit_capture.capture_looks_blank(self.save(Image.new("RGB", (1366, 757), "white"))))
        loading = Image.new("RGB", (1366, 757), "white")
        ImageDraw.Draw(loading).text((640, 370), "Loading...", fill="black")
        self.assertTrue(exit_capture.capture_looks_blank(self.save(loading)))

    def test_text_heavy_light_section_is_not_blank(self):
        """밝은 배경에 글이 많은 리뷰 영역. 예전 기준은 이걸 빈 화면으로 버렸다."""
        page = Image.new("RGB", (1366, 757), (255, 251, 232))
        draw = ImageDraw.Draw(page)
        for row in range(6):
            y = 120 + row * 123
            draw.rectangle((56, y, 146, y + 90), fill=(170, 130, 95))
            draw.text((162, y + 10), "review 4/5 buyer", fill="black")
            draw.text((162, y + 50), "size runs small, order one size up. fabric is thin.", fill="black")
            draw.line((40, y + 107, 1326, y + 107), fill=(220, 220, 220))
        self.assertFalse(exit_capture.capture_looks_blank(self.save(page)))


class ReportInsertion(unittest.TestCase):
    def test_page_number_rewrite_does_not_corrupt_capture(self):
        """쪽 번호 정규식(숫자/숫자)이 base64 이미지 데이터를 건드리면 안 된다."""
        origin, start, end = "https://demo.seer.test", "2026-11-09", "2026-11-15"
        capture_dir = rt.site_capture_dir(origin, start, end)
        capture_dir.mkdir(parents=True, exist_ok=True)
        self.addCleanup(shutil.rmtree, capture_dir.parent, True)
        # 실제 스크린샷처럼 복잡한 이미지 → base64 안에 '숫자/숫자' 조각이 생긴다.
        rng = random.Random(3)
        image = Image.frombytes("RGB", (64, 64), bytes(rng.randrange(256) for _ in range(64 * 64 * 3)))
        path = capture_dir / "exit_hotspot_1_test.png"
        image.save(path)
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        self.assertRegex(encoded, r"\d+\s*/\s*\d+")  # 재현 조건
        hotspots = [{"url": "https://demo.seer.test/", "section": "review", "scroll_y": 0,
                     "count": 3, "capture_path": str(path)}]
        inputs = rt.load_inputs()
        inputs["exit_hotspots"] = hotspots
        source = ML_DIR / "templates" / "weekly_report" / "design-page-01-cover-a.html"
        with mock.patch.object(rt, "build_cafe24_appendix", return_value=""):
            html = rt.build_exact_html(source, start, end, origin, inputs)
        expected = base64.b64encode(path.read_bytes()).decode("ascii")
        self.assertIn(expected, html)


if __name__ == "__main__":
    unittest.main()
