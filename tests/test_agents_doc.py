"""AGENTS.md stays true to the repository: every relative path it names exists (or is a known build/private output),
every `python3 …`/`node …`/`sh …` command names an existing script, each `--flag` occurs in that script, and every
`node local/<tool>.mjs <command>` is a command the tool dispatches. Run: python3 -B -m unittest tests/test_agents_doc.py
"""
import re
import shlex
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
# Outputs and private state: never in a clean checkout, so only their names are documented.
GENERATED = ("site/", "docs/", ".local/", "reports/", ".stockbit-publish/", "worker/.assets", "files/")
SCRIPT = re.compile(r"\.(py|mjs|cjs|sh)$")


def spans():
    return re.findall(r"`([^`\n]+)`", DOC)


def commands():
    """Inline `python3 …`/`node …`/`sh …` spans and the same lines inside fenced blocks."""
    fenced = [line for block in re.findall(r"```\w*\n(.*?)```", DOC, re.S) for line in block.splitlines()]
    return [c for c in spans() + fenced if re.match(r"(\w+=\S+\s+)*(python3?|node|sh)\s", c.strip())]


class AgentsDoc(unittest.TestCase):
    def test_inline_code_closes_on_its_line(self):
        prose = re.sub(r"```.*?```", "", DOC, flags=re.S)
        self.assertEqual([line for line in prose.splitlines() if line.count("`") % 2], [])

    def test_paths_exist(self):
        paths = {s for s in spans() if "/" in s and re.fullmatch(r"[A-Za-z0-9_.][\w.\-/]*", s) and not s.startswith("http")}
        self.assertGreater(len(paths), 40)
        missing = sorted(p for p in paths if not p.startswith(GENERATED) and not (ROOT / p).exists())
        self.assertEqual(missing, [])

    def test_commands_exist(self):
        checked = 0
        for command in commands():
            words = shlex.split(command.split("#")[0])
            script = next((w for w in words if SCRIPT.search(w)), None)
            if script is None or "*" in script:
                continue
            checked += 1
            path = ROOT / script
            self.assertTrue(path.is_file(), command)
            text = path.read_text(encoding="utf-8")
            rest = words[words.index(script) + 1:]
            for flag in (w.split("=")[0] for w in rest if w.startswith("--")):
                self.assertIn(flag[2:], text, f"{flag} not in {script}: {command}")
            dispatch = re.search(r"^cli\(import\.meta\.url.*$", text, re.M)
            sub = next((w for w in rest if not w.startswith("-")), None)
            if dispatch and sub and re.fullmatch(r"[a-z]+", sub):
                self.assertRegex(dispatch.group(0), rf"\b{sub}\b", command)
        self.assertGreater(checked, 8)


if __name__ == "__main__":
    unittest.main()
