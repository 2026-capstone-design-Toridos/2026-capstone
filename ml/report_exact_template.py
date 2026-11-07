"""Build a weekly report by reusing the supplied design HTML verbatim.

The source pages keep their original 794 x 1123 DOM and inline styles.  Only
the report identity fields are replaced; no project CSS is layered on top.
"""
from __future__ import annotations

import argparse
import base64
import math
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(r"C:\SW4_2\졸작\[디자인] 주간 리포트.html")


def split_pages(source: str) -> list[str]:
    """Return the exact x-dc page nodes embedded in the supplied document."""
    return re.findall(r"<x-dc>.*?</x-dc>", source, flags=re.S | re.I)


def display_site(origin: str) -> str:
    host = (urlparse(origin).hostname or origin or "Dignolucir").split(".")[0]
    return host[:1].upper() + host[1:]


def _pie_path(start_pct: float, end_pct: float) -> str:
    if end_pct - start_pct >= 99.999:
        return "M50,50 m-49,0 a49,49 0 1,0 98,0 a49,49 0 1,0 -98,0"
    start = math.radians(start_pct * 3.6 - 90)
    end = math.radians(end_pct * 3.6 - 90)
    x1, y1 = 50 + 49 * math.cos(start), 50 + 49 * math.sin(start)
    x2, y2 = 50 + 49 * math.cos(end), 50 + 49 * math.sin(end)
    large = 1 if end_pct - start_pct > 50 else 0
    return f"M50,50 L{x1:.3f},{y1:.3f} A49,49 0 {large},1 {x2:.3f},{y2:.3f} Z"


def replace_conic_charts(page: str) -> str:
    """Replace CSS conic gradients with explicit SVG sectors for PDF stability."""
    pattern = re.compile(
        r'<div style="(?P<style>[^"]*?)background:\s*conic-gradient\((?P<stops>[^)]*)\)(?P<tail>[^"]*)"></div>',
        flags=re.I,
    )

    def convert(match: re.Match[str]) -> str:
        raw_stops = match.group("stops")
        sectors = []
        for color, start, end in re.findall(
            r'(#[0-9a-fA-F]{3,8})\s+([0-9.]+)%\s+([0-9.]+)%', raw_stops
        ):
            sectors.append((color, float(start), float(end)))
        if not sectors:
            return match.group(0)
        style = (match.group("style") + match.group("tail")).strip().rstrip(";")
        paths = "".join(
            f'<path d="{_pie_path(start, end)}" fill="{color}"/>'
            for color, start, end in sectors
        )
        return (
            f'<div style="{style};border-radius:50%;overflow:hidden">'
            f'<svg viewBox="0 0 100 100" width="100%" height="100%" '
            f'xmlns="http://www.w3.org/2000/svg" aria-label="비율 원형 그래프">{paths}</svg></div>'
        )

    return pattern.sub(convert, page)


def insert_capture_images(page: str) -> str:
    capture_dir = ROOT / "ml" / "output" / "reports" / "exit_captures"
    captures = sorted(capture_dir.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    chosen = []
    for index in (1, 2, 3):
        match = next((p for p in captures if p.name.startswith(f"exit_hotspot_{index}_")), None)
        if match:
            chosen.append(match)
    if not chosen:
        return page

    image_iter = iter(chosen)
    placeholder = re.compile(
        r'<div style="(?P<style>[^"]*border:[^;\"]*dashed[^"]*)">\s*캡처 이미지 영역[^<]*</div>',
        flags=re.S,
    )

    def replace(match: re.Match[str]) -> str:
        try:
            path = next(image_iter)
        except StopIteration:
            return match.group(0)
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        return (
            f'<div style="{match.group("style")};overflow:hidden">'
            f'<img src="data:image/png;base64,{encoded}" '
            f'style="width:100%;height:100%;object-fit:cover;object-position:top;display:block"/></div>'
        )

    return placeholder.sub(replace, page)


def build_exact_html(source_path: Path, start: str, end: str, origin: str) -> str:
    pages = split_pages(source_path.read_text(encoding="utf-8"))
    if len(pages) < 20:
        extracted = sorted((ROOT / "ml" / "templates" / "weekly_report").glob("design-page-*.html"))
        pages = [split_pages(path.read_text(encoding="utf-8"))[0] for path in extracted]
    if len(pages) < 20:
        raise ValueError(f"Expected 20 design pages, found {len(pages)}")

    # Cover A + every unique body design. Cover alternatives B-E are excluded.
    selected = [0, *range(5, 20)]
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")
    date_long = f"{start_dt:%Y.%m.%d} – {end_dt:%m.%d}"
    date_short = f"{start_dt:%Y.%m.%d} – {end_dt:%m.%d}"
    week = f"{end_dt.year}년 {end_dt.month}월 {(end_dt.day - 1) // 7 + 1}주차 운영 현황"
    site = display_site(origin)

    rendered: list[str] = []
    for page_no, source_index in enumerate(selected, 1):
        page = pages[source_index]
        page = page.replace("Dignolucir", site)
        page = page.replace("2026.10.21 – 10.27", date_long)
        page = page.replace("2026.10.21 - 10.27", date_long)
        page = page.replace("2026년 10월 4주차 운영 현황", week)
        page = page.replace("2026.10.21 – 2026.10.27", date_short)
        page = replace_conic_charts(page)
        if source_index == 12:
            page = insert_capture_images(page)
        # Keep the original footer typography while making numbering truthful.
        page = re.sub(r"\d+\s*/\s*17", f"{page_no} / {len(selected)}", page)
        rendered.append(f'<section class="report-page source-page-{source_index + 1}">{page}</section>')

    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<style>
@page {{ size: 794px 1123px; margin: 0; }}
html, body {{ margin:0; padding:0; background:#fff; }}
.report-page {{ width:794px; height:1123px; overflow:hidden; break-after:page; page-break-after:always; }}
.report-page:last-child {{ break-after:auto; page-break-after:auto; }}
x-dc {{ display:block; width:794px; height:1123px; }}
helmet {{ display:none; }}
/* The supplied design uses renderer-specific table tags.  Map them to the
   native CSS table model before Chrome prints the document. */
sc-raw-table {{ display:table !important; width:100% !important; border-collapse:collapse !important; table-layout:fixed; }}
sc-raw-thead {{ display:table-header-group !important; }}
sc-raw-tbody {{ display:table-row-group !important; }}
sc-raw-tr {{ display:table-row !important; }}
sc-raw-th {{ display:table-cell !important; vertical-align:middle; }}
sc-raw-td {{ display:table-cell !important; vertical-align:middle; overflow-wrap:anywhere; }}
sc-raw-tr:nth-child(odd):not(:first-child) sc-raw-td {{ background:#f3f5f9; }}
/* Ratio graphics in the source are conic-gradient divs.  Preserve the
   intended circular chart even where the exported HTML contained radius 0. */
[style*="conic-gradient"] {{ border-radius:50% !important; aspect-ratio:1 / 1; flex:none; }}
/* Keep legend percentages visible and aligned at the right edge. */
[style*="flex-direction: column"] > [style*="align-items: center"] b,
[style*="display: flex"][style*="align-items: center"] > b {{ white-space:nowrap; min-width:30px; text-align:right; }}
.source-page-20 sc-raw-th:first-child,
.source-page-20 sc-raw-td:first-child {{ width:22% !important; }}
.source-page-20 sc-raw-th:nth-child(2),
.source-page-20 sc-raw-td:nth-child(2) {{ width:78% !important; }}
</style></head><body>{''.join(rendered)}</body></html>"""


def chrome_path() -> str:
    candidates = [
        shutil.which("chrome"), shutil.which("chrome.exe"), shutil.which("msedge"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    raise FileNotFoundError("Chrome or Edge was not found")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--origin", default="https://dignolucir.co.kr")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    source = Path(args.source)
    if not source.exists():
        fallback = ROOT / "ml" / "templates" / "weekly_report" / "design-page-01-cover-a.html"
        source = fallback if fallback.exists() else source
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    html_path = output.with_suffix(".html")
    html_path.write_text(build_exact_html(source, args.start, args.end, args.origin), encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="seer-exact-", ignore_cleanup_errors=True) as temp_dir:
        temp_dir_path = Path(temp_dir)
        temp_html = temp_dir_path / "report.html"
        temp_pdf = temp_dir_path / "report.pdf"
        profile = temp_dir_path / "chrome-profile"
        shutil.copyfile(html_path, temp_html)
        subprocess.run([
            chrome_path(), "--headless=new", "--disable-gpu", "--disable-extensions",
            "--disable-dev-shm-usage", "--no-first-run", "--no-sandbox",
            f"--user-data-dir={profile}", f"--print-to-pdf={temp_pdf}", temp_html.as_uri(),
        ], check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.copyfile(temp_pdf, output)
    print(output)


if __name__ == "__main__":
    main()
