"""Filesystem boundaries for disposable build output and read-only archive input."""
from pathlib import Path


def check_source(path, source):
    path, source = Path(path), Path(source).resolve()
    if path.is_symlink() or not path.resolve().is_relative_to(source):
        raise ValueError("Arsip tidak boleh berupa symlink atau menunjuk keluar folder sumber.")


def check_output(path, root, protected, kind):
    path, root = Path(path), Path(root).resolve()
    out = path.resolve()
    if path.is_symlink() or out == root or out in root.parents:
        raise ValueError("Folder output tidak boleh menimpa akar proyek atau symlink.")
    for source in [Path(p).resolve() for p in protected]:
        if out == source or out in source.parents or source in out.parents:
            raise ValueError("Folder output beririsan dengan sumber yang dilindungi.")
    if out.exists() and any(out.iterdir()):
        if kind == "site":
            valid = (out / ".nojekyll").is_file() and (out / "index.html").is_file() and 'id="arsip-data"' in (out / "index.html").read_text()
        else:
            valid = out == root / "worker" / ".assets" and (out / "manifest.json").is_file()
        if not valid:
            raise ValueError("Folder output berisi data yang bukan hasil build arsip; gunakan folder baru/kosong.")
    return out
