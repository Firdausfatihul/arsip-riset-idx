"""Offline report contract: test IDs never turn other traffic into verified users."""
import json
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


if __name__ == '__main__':
    unittest.main()
