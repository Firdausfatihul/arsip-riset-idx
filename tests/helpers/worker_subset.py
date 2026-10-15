"""Worker assets for the named documents only, with the full site's ticker list.

CLI: python3 -B tests/helpers/worker_subset.py SITE OUT NAME...
Used for documents that chat no longer indexes (raw Stockbit reports now covered by sbringkas).
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import build_worker  # noqa: E402

site, out, *names = sys.argv[1:]
build_worker.worker_docs = lambda docs: ([d for d in docs if d["name"] in names], [])
build_worker.build(Path(site), Path(out))
