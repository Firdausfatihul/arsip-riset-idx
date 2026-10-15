"""End-to-end helpers: a temp copy of the archive code (its scripts then run with ROOT = that copy) and a fake
Signal Desk served over real HTTP on 127.0.0.1."""
import json
import shutil
import subprocess
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]


def copy_code(dest):
    """What sync_idx.py, build.py and publish/rollback need, so they run against `dest` instead of this checkout."""
    for name in ("build.py", "chat.js", "report-frame.js", "report-shell.js", ".gitignore"):
        shutil.copy2(ROOT / name, dest / name)
    (dest / "tools").mkdir()
    for path in (ROOT / "tools").glob("*.py"):
        shutil.copy2(path, dest / "tools" / path.name)
    (dest / "needtobeindexed/idx-signal-desk").mkdir(parents=True)


def run(root, script, *args, env=None, timeout=300):
    """`python3 -B <script> <args>` with cwd = root, as the desk runs it. Returns (exit code, stdout, stderr)."""
    result = subprocess.run([sys.executable, "-B", script, *args], cwd=root, env=env, capture_output=True, text=True,
                            timeout=timeout)
    return result.returncode, result.stdout, result.stderr


def last_json(stdout):
    return json.loads(stdout.strip().splitlines()[-1])


@contextmanager
def serve(desk):
    """desk.get(path) over HTTP. HTTPError -> that status; any other error -> 500, kept in `errors` for the test."""
    errors = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            try:
                code, body = 200, json.dumps(desk.get(self.path)).encode()
            except HTTPError as e:
                e.close()
                code, body = e.code, b"{}"
            except Exception as e:  # noqa: BLE001  (an unexpected call must fail the test, not hang the client)
                errors.append(f"{self.path}: {e!r}")
                code, body = 500, b"{}"
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield SimpleNamespace(url=f"http://127.0.0.1:{server.server_port}", errors=errors)
    finally:
        server.shutdown()
        server.server_close()
