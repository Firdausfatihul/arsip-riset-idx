"""Offline report contract: test IDs never turn other traffic into verified users. The VPS read
(`node local/vps.mjs metrics`, tests/vps_metrics.mjs) is replaced by a fake node on PATH."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ChatMetricsReportTest(unittest.TestCase):
    def render(self, runs=None):
        snapshot = {
            'days':1, 'total':{'inputs':39, 'anonymous_clients':16,
                'known_cost_usd':0.024, 'answer_cache_hits':3, 'missing_usage_calls':2},
            'by_mode':[], 'daily_by_mode':[], 'top_questions':[], 'expensive_questions':[],
            'top_terms':[], 'daily':[], 'outcomes':[],
            'pagination':{'total':39, 'offset':0, 'limit':5},
            'questions':[{'id':'test-request', 'stamp':1790555375942,
                'user_key':'anonymous-client', 'question':'analisis SOCI', 'status':'complete',
                'terms':['SOCI'], 'metrics':{'usage':{'known_cost_usd':0.001}}}]
        }
        # Same text may be sent in a production smoke test and by another client.
        question = snapshot['questions'][0]
        question['id'] = 'test-request'
        other = dict(question, id='unknown-request')
        snapshot['questions'] = [question, other, question]
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            source, output, report = (directory / n for n in ('input.json', 'output.json', 'report.html'))
            source.write_text(json.dumps(snapshot))
            cmd = [sys.executable, str(ROOT / 'tools/chat_metrics.py'), '--from-file', str(source), '--out', str(output), '--html', str(report)]
            if runs is not None:
                ledger = directory / 'runs.json'
                ledger.write_text(json.dumps({'runs':runs}))
                cmd.extend(['--test-runs', str(ledger)])
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode:
                return result, None, None, snapshot
            return result, json.loads(output.read_text()), report.read_text(), snapshot

    def test_ledger_matches_id_not_question_and_leaves_aggregates_intact(self):
        result, data, html, original = self.render([{
            'run_id':'smoke-1', 'execution':'production', 'production_request_ids':['test-request']}])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(data['total'], original['total'])
        self.assertEqual(data['by_mode'], original['by_mode'])
        report = data['report']
        self.assertEqual([c['inputs'] for c in report['cohorts']], [1, 1])
        self.assertEqual(report['question_origins']['test-request']['test_run_ids'], ['smoke-1'])
        self.assertEqual(report['question_origins']['unknown-request']['origin'], 'unknown')
        self.assertIn('belum disaring', html)
        self.assertIn('Status selesai tidak mengukur kebenaran jawaban', html)
        self.assertIn('2 ID unik', html)

    def test_without_ledger_all_origins_remain_unknown(self):
        result, data, _, _ = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c['inputs'] for c in data['report']['cohorts']], [0, 2])

    def test_local_run_cannot_label_production_traffic(self):
        result, _, _, _ = self.render([{
            'run_id':'local-1', 'execution':'local', 'production_request_ids':['test-request']}])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Local evaluations cannot have production request IDs', result.stderr)


    def vps(self, node_script, *extra):
        """chat_metrics.py without --from-file, with `node` on PATH replaced by node_script (sh)."""
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            fake = directory / 'node'
            fake.write_text('#!/bin/sh\necho "$@" > "$(dirname "$0")/args"\n' + node_script)
            fake.chmod(0o755)
            report = directory / 'report.html'
            result = subprocess.run([sys.executable, str(ROOT / 'tools/chat_metrics.py'), '--days', '3', '--html', str(report), *extra],
                                    capture_output=True, text=True, env={**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}'})
            args = (directory / 'args').read_text().split()
            return result, args, report.read_text() if report.exists() else None

    def test_reads_the_vps_through_vps_mjs(self):
        snapshot = {'days':3, 'total':{'inputs':1, 'anonymous_clients':1, 'known_cost_usd':0, 'answer_cache_hits':0, 'missing_usage_calls':0},
                    'by_mode':[{'mode':'agentic', 'inputs':1, 'completed':1, 'failed':0, 'known_cost_usd':0, 'max_cost_usd':0,
                                'provider_calls':1, 'tool_calls':2, 'prompt_tokens':5, 'completion_tokens':1, 'answer_cache_hits':0,
                                'datacat_cache_hits':0, 'missing_usage_calls':0}],
                    'daily_by_mode':[{'day':'2026-10-16', 'mode':'agentic', 'inputs':1, 'known_cost_usd':0}], 'top_questions':[],
                    'expensive_questions':[], 'top_terms':[], 'daily':[], 'outcomes':[],
                    'pagination':{'total':1, 'offset':5, 'limit':9}, 'questions':[], 'agentic_daily':100}
        result, args, html = self.vps(f"echo '{json.dumps(snapshot)}'\n", '--limit', '9', '--offset', '5')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args, [str(ROOT / 'local/vps.mjs'), 'metrics', '--days', '3', '--limit', '9', '--offset', '5'])
        self.assertIn('kuota 100/hari', html)
        self.assertEqual(json.loads(result.stdout)['inputs'], 1)

    def test_vps_failure_stops_with_its_message(self):
        result, _, html = self.vps('echo "Gagal: Belum di-setup." >&2\nexit 1\n')
        self.assertEqual((result.returncode, result.stderr.strip(), html), (1, 'Gagal: Belum di-setup.', None))


if __name__ == '__main__':
    unittest.main()
