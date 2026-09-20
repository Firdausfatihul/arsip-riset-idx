#!/usr/bin/env python3
"""Update Cloudflare's archive and prepare GitHub Pages output, without git push."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    config = ROOT / 'chat.config.json'
    if not config.is_file() or not json.loads(config.read_text()).get('api_url', '').startswith('https://'):
        raise SystemExit('Isi api_url HTTPS hasil deploy di chat.config.json terlebih dahulu.')
    env = dict(os.environ)
    env.pop('CHAT_API_URL', None)  # A previous local override must not reach GitHub Pages.
    env['BASE_URL'] = 'https://arsip.seekingomega.capital'
    commands = [
        [sys.executable, '-B', 'build.py'],
        [sys.executable, '-B', 'tools/build_worker.py'],
        ['npx', '--yes', 'wrangler@4.135.0', 'deploy', '--config', 'worker/wrangler.jsonc'],
        [sys.executable, '-B', 'tools/sync_chat_index.py'],
        [sys.executable, '-B', 'build.py', '--out', 'docs'],
    ]
    for command in commands:
        subprocess.run(command, cwd=ROOT, env=env, check=True)
    print('Worker diperbarui; docs/ siap ditinjau dan dipush ke GitHub Pages.')


if __name__ == '__main__':
    main()
