from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime
from urllib.parse import urlparse, urlunparse


EXIT_EVENT_TYPES = {"session_end", "tab_exit", "inactivity"}
CONTEXT_EVENT_TYPES = {
    "section_enter",
    "section_exit",
    "section_transition",
    "subsection_enter",
    "subsection_exit",
    "scroll_stop",
    "scroll_depth",
    "click",
    "hover_dwell",
    "product_click",
    "add_to_cart",
    "purchase_click",
    "remove_from_cart",
}


def load_env_value(key: str, base_dir: str) -> str:
    if os.environ.get(key):
        return os.environ[key]
    env_path = os.path.join(os.path.dirname(base_dir), "backend", ".env")
    if not os.path.exists(env_path):
        return ""
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == key:
                return v.strip().strip('"').strip("'")
    return ""


def clean_url(url: str) -> str:
    if not url:
        return ""
    try:
        p = urlparse(url)
        return urlunparse((p.scheme, p.netloc, p.path, "", p.query, ""))
    except Exception:
        return url


def event_data(doc: dict) -> dict:
    data = doc.get("data")
    return data if isinstance(data, dict) else {}


def scroll_from_data(data: dict, fallback: int = 0) -> int:
    for key in ("last_viewport_scrollY", "scrollY", "position", "y"):
        val = data.get(key)
        if isinstance(val, (int, float)):
            return max(0, int(val))
    return max(0, int(fallback or 0))


def infer_url(doc: dict, data: dict, last_url: str) -> str:
    url = doc.get("page_url") or data.get("page_url") or last_url or ""
    exit_page = data.get("exit_page")
    if exit_page and url:
        try:
            p = urlparse(url)
            if str(exit_page).startswith("/"):
                url = urlunparse((p.scheme, p.netloc, str(exit_page), "", "", ""))
        except Exception:
            pass
    return clean_url(url)


def find_exit_hotspots(base_dir: str, start: str, end: str, limit: int = 3) -> list[dict]:
    uri = load_env_value("MONGODB_URI", base_dir)
    if not uri:
        print("  -> MONGODB_URI missing; exit capture skipped")
        return []

    try:
        from pymongo import MongoClient
    except Exception as exc:
        print(f"  -> pymongo unavailable; exit capture skipped ({exc})")
        return []

    try:
        client = MongoClient(uri, serverSelectionTimeoutMS=8000)
        db = client.get_default_database()
        query = {"event_type": {"$in": sorted(EXIT_EVENT_TYPES | CONTEXT_EVENT_TYPES)}}
        try:
            start_dt = datetime.fromisoformat(start)
            end_dt = datetime.fromisoformat(end).replace(hour=23, minute=59, second=59)
            query["received_at"] = {"$gte": start_dt, "$lte": end_dt}
        except Exception:
            pass

        projection = {
            "session_id": 1,
            "event_type": 1,
            "event_seq": 1,
            "timestamp": 1,
            "page_url": 1,
            "pathname": 1,
            "origin": 1,
            "data": 1,
            "received_at": 1,
        }
        cursor = (
            db.events.find(query, projection)
            .sort([("session_id", 1), ("event_seq", 1), ("timestamp", 1)])
            .limit(50000)
        )

        state: dict[str, dict] = {}
        buckets: dict[tuple, dict] = {}
        total_exits = 0
        for doc in cursor:
            sid = doc.get("session_id") or ""
            data = event_data(doc)
            st = state.setdefault(sid, {"section": None, "subsection": None, "scroll": 0, "url": ""})
            et = doc.get("event_type")

            url = infer_url(doc, data, st.get("url") or "")
            if url:
                st["url"] = url
            section = data.get("section") or data.get("element_section") or st.get("section")
            subsection = data.get("subsection_id") or data.get("subsection") or st.get("subsection")
            if section:
                st["section"] = str(section)
            if subsection:
                st["subsection"] = str(subsection)
            st["scroll"] = scroll_from_data(data, st.get("scroll", 0))

            if et not in EXIT_EVENT_TYPES:
                continue

            exit_url = infer_url(doc, data, st.get("url") or "")
            if not exit_url.startswith(("http://", "https://")):
                continue
            total_exits += 1
            exit_section = str(section or subsection or "unknown")
            exit_scroll = scroll_from_data(data, st.get("scroll", 0))
            scroll_bucket = int(exit_scroll // 500) * 500
            key = (exit_url, exit_section, scroll_bucket)
            row = buckets.setdefault(
                key,
                {
                    "url": exit_url,
                    "section": exit_section,
                    "scroll_values": [],
                    "count": 0,
                    "event_types": {},
                },
            )
            row["count"] += 1
            row["scroll_values"].append(exit_scroll)
            row["event_types"][et] = row["event_types"].get(et, 0) + 1

        rows = sorted(buckets.values(), key=lambda r: r["count"], reverse=True)[:limit]
        for row in rows:
            vals = row.pop("scroll_values") or [0]
            row["scroll_y"] = int(sum(vals) / len(vals))
            row["share_pct"] = round(100 * row["count"] / total_exits) if total_exits else 0
        return rows
    except Exception as exc:
        print(f"  -> exit hotspot analysis failed: {exc}")
        return []


def browser_executable() -> str:
    candidates = [
        os.environ.get("GT_BROWSER_PATH"),
        shutil.which("chrome"),
        shutil.which("msedge"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    return next((p for p in candidates if p and os.path.exists(p)), "")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def ws_connect(ws_url: str) -> socket.socket:
    p = urlparse(ws_url)
    host, port = p.hostname, p.port or 80
    path = p.path + (("?" + p.query) if p.query else "")
    sock = socket.create_connection((host, port), timeout=8)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(req.encode("ascii"))
    data = sock.recv(4096)
    if b" 101 " not in data:
        raise RuntimeError("WebSocket handshake failed")
    return sock


def ws_send(sock: socket.socket, payload: dict) -> None:
    raw = json.dumps(payload).encode("utf-8")
    header = bytearray([0x81])
    n = len(raw)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack("!H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack("!Q", n)
    mask = os.urandom(4)
    header += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(raw))
    sock.sendall(header + masked)


def read_exact(sock: socket.socket, n: int) -> bytes:
    out = b""
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise RuntimeError("WebSocket closed")
        out += chunk
    return out


def ws_recv(sock: socket.socket) -> dict:
    h = read_exact(sock, 2)
    opcode = h[0] & 0x0F
    masked = bool(h[1] & 0x80)
    n = h[1] & 0x7F
    if n == 126:
        n = struct.unpack("!H", read_exact(sock, 2))[0]
    elif n == 127:
        n = struct.unpack("!Q", read_exact(sock, 8))[0]
    mask = read_exact(sock, 4) if masked else b""
    data = read_exact(sock, n)
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    if opcode == 8:
        raise RuntimeError("WebSocket closed")
    if opcode not in (1, 2):
        return {}
    return json.loads(data.decode("utf-8"))


def cdp_call(sock: socket.socket, seq: int, method: str, params: dict | None = None) -> dict:
    ws_send(sock, {"id": seq, "method": method, "params": params or {}})
    while True:
        msg = ws_recv(sock)
        if msg.get("id") == seq:
            if "error" in msg:
                raise RuntimeError(f"CDP {method} failed: {msg['error']}")
            return msg.get("result", {})


def capture_hotspot(hotspot: dict, out_dir: str, index: int) -> str:
    browser = browser_executable()
    if not browser:
        print("  -> Chrome/Edge not found; screenshot skipped")
        return ""

    out_dir = os.path.abspath(os.path.normpath(out_dir))
    os.makedirs(out_dir, exist_ok=True)
    port = free_port()
    profile = tempfile.mkdtemp(prefix="gt-chrome-")
    digest = hashlib.md5(
        f"{hotspot['url']}|{hotspot['section']}|{hotspot['scroll_y']}".encode("utf-8")
    ).hexdigest()[:10]
    out_path = os.path.abspath(os.path.join(out_dir, f"exit_hotspot_{index}_{digest}.png"))
    proc = None
    sock = None
    try:
        proc = subprocess.Popen(
            [
                browser,
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                "--no-first-run",
                "--no-default-browser-check",
                f"--remote-debugging-port={port}",
                f"--user-data-dir={profile}",
                "--window-size=1366,900",
                hotspot["url"],
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        ws_url = ""
        for _ in range(40):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as r:
                    pages = json.loads(r.read().decode("utf-8"))
                page = next((p for p in pages if p.get("type") == "page"), None)
                if page:
                    ws_url = page["webSocketDebuggerUrl"]
                    break
            except Exception:
                time.sleep(0.2)
        if not ws_url:
            return ""

        sock = ws_connect(ws_url)
        seq = 1
        cdp_call(sock, seq, "Page.enable")
        seq += 1
        time.sleep(2.5)
        cdp_call(
            sock,
            seq,
            "Runtime.evaluate",
            {"expression": f"window.scrollTo(0, {int(hotspot.get('scroll_y', 0))}); true"},
        )
        seq += 1
        time.sleep(0.8)
        res = cdp_call(
            sock,
            seq,
            "Page.captureScreenshot",
            {"format": "png", "fromSurface": True, "captureBeyondViewport": False},
        )
        with open(out_path, "wb") as f:
            f.write(base64.b64decode(res["data"]))
        return out_path
    except Exception as exc:
        print(f"  -> capture failed: {hotspot.get('url')} ({exc})")
        return ""
    finally:
        try:
            if sock:
                sock.close()
        except Exception:
            pass
        if proc:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


def annotate_capture(path: str, hotspot: dict) -> str:
    if not path or not os.path.exists(path):
        return ""
    try:
        from PIL import Image, ImageDraw, ImageFont

        img = Image.open(path).convert("RGBA")
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        w, h = img.size
        y = int(h * 0.58)
        draw.rectangle([0, y - 34, w, y + 34], fill=(229, 57, 53, 54))
        draw.line([0, y, w, y], fill=(229, 57, 53, 230), width=5)
        try:
            font = ImageFont.truetype("arial.ttf", 22)
        except Exception:
            font = ImageFont.load_default()
        text = (
            f"Exit hotspot: {hotspot['count']} sessions / "
            f"section {hotspot['section']} / scrollY {hotspot['scroll_y']}"
        )
        draw.rounded_rectangle([18, 18, min(w - 18, 780), 70], radius=8, fill=(183, 28, 28, 224))
        draw.text((34, 35), text[:100], fill=(255, 255, 255, 255), font=font)
        out = Image.alpha_composite(img, overlay).convert("RGB")
        out.save(path, quality=92)
        return path
    except Exception as exc:
        print(f"  -> annotation failed: {exc}")
        return path


def capture_exit_hotspots(base_dir: str, out_dir: str, start: str, end: str, limit: int = 3) -> list[dict]:
    hotspots = find_exit_hotspots(base_dir, start, end, limit=limit)
    if not hotspots:
        return []

    results = []
    for i, hotspot in enumerate(hotspots, 1):
        item = dict(hotspot)
        path = capture_hotspot(item, out_dir, i)
        item["capture_path"] = annotate_capture(path, item) if path else ""
        if item["capture_path"]:
            with open(item["capture_path"], "rb") as f:
                item["capture_b64"] = base64.b64encode(f.read()).decode("ascii")
        else:
            item["capture_b64"] = ""
        results.append(item)
    return results
