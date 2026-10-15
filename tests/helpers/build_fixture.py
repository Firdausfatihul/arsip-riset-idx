"""Run build.main() over temporary sources; never the real archive. build.py reads every source under SRC."""
from contextlib import redirect_stdout
import io
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
import build  # noqa: E402


def build_site(src, out, base_url="https://arsip.test"):
    """Build src into out; returns (stdout, stderr)."""
    stdout, stderr = io.StringIO(), io.StringIO()
    with patch.multiple(build, SRC=Path(src), BASE_URL=base_url, CHAT_API_URL="/api/chat"), \
            patch.object(sys, "argv", ["build.py", "--out", str(out)]), \
            redirect_stdout(stdout), patch.object(sys, "stderr", stderr):
        build.main()
    return stdout.getvalue(), stderr.getvalue()
