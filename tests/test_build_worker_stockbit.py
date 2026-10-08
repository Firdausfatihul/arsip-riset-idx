"""Stockbit summaries in the chat index: exact day files, raw-report exclusion, compact postings,
the stockbit.json auxiliary asset and the event kind. Temporary files only (no archive build)."""
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from build_worker import auxiliary_versions, covers, posting_words, stockbit_index, worker_docs, SYSTEM, STOCKBIT_RULE  # noqa: E402
from event_index import text_events  # noqa: E402


def doc(name, cat, start, end=None, body='Isi.'):
    return {'name': name, 'cat': cat, 'start': start, 'end': end or start, 'body': body, 'search_body': body,
            'title': name, 'source_id': 'D1', 'kind': 'html' if name.endswith('.html') else 'md'}


class Covers(unittest.TestCase):
    def test_two_iso_dates_in_name_are_never_widened_from_the_body(self):
        d = doc('sbringkas_2026-10-05_2026-10-05.md', 'stockbit-ringkasan', '2026-10-05',
                body='# Ringkasan Stockbit Ideas · 5 Oktober 2026\n\nFORU naik 1-5 Oktober 2026 menurut pengguna.')
        self.assertEqual(covers(d), ['2026-10-05', '2026-10-05'])

    def test_single_date_raw_report_still_widens_to_its_written_period(self):
        d = doc('stockbit_05102026.html', 'stockbit', '2026-10-05',
                body='<h1>Stockbit</h1><p>Periode 4–5 Oktober 2026, semua posting.</p>')
        self.assertEqual(covers(d), ['2026-10-04', '2026-10-05'])

    def test_explicit_range_is_returned_unchanged(self):
        d = doc('sbpekan_2026-10-05_2026-10-11.md', 'stockbit-pekan', '2026-10-05', '2026-10-11',
                body='Rekap 1-11 Oktober 2026.')
        self.assertEqual(covers(d), ['2026-10-05', '2026-10-11'])


class RawExclusion(unittest.TestCase):
    def test_raw_report_left_out_only_when_every_covered_day_has_a_summary(self):
        summaries = [doc(f'sbringkas_2026-10-0{d}_2026-10-0{d}.md', 'stockbit-ringkasan', f'2026-10-0{d}') for d in (4, 5)]
        covered = doc('stockbit_05102026.md', 'stockbit', '2026-10-05', body='Periode 4–5 Oktober 2026.')
        partial = doc('stockbit_03102026.md', 'stockbit', '2026-10-03', body='Periode 3–4 Oktober 2026.')
        older = doc('stockbit_28092026.md', 'stockbit', '2026-09-28')
        detail = doc('sbdetail_2026-10-05_2026-10-05.md', 'stockbit-detail', '2026-10-05')
        ki = doc('ki_05102026.md', 'keterbukaan-informasi', '2026-10-05')
        kept, excluded = worker_docs(summaries + [covered, partial, older, detail, ki])
        self.assertEqual([d['name'] for d in excluded], ['stockbit_05102026.md'])
        self.assertEqual({d['name'] for d in kept}, {d['name'] for d in summaries} | {
            'stockbit_03102026.md', 'stockbit_28092026.md', 'sbdetail_2026-10-05_2026-10-05.md', 'ki_05102026.md'})

    def test_no_summaries_keeps_every_raw_report(self):
        docs = [doc('stockbit_05102026.md', 'stockbit', '2026-10-05')]
        self.assertEqual(worker_docs(docs), (docs, []))


class Postings(unittest.TestCase):
    def test_long_digit_words_are_left_to_full_text_search(self):
        words = posting_words('FORU [pos](https://stockbit.com/post/36364650) 2026 Rp1500 1234567 123456')
        self.assertNotIn('36364650', words)
        self.assertNotIn('1234567', words)
        self.assertTrue({'foru', '2026', 'rp1500', '123456', 'stockbit', 'post'} <= words)

    def test_system_prompt_marks_stockbit_as_unverified_claims(self):
        self.assertIn('belum diverifikasi', STOCKBIT_RULE)
        self.assertIn('bukan atas orangnya', STOCKBIT_RULE)
        self.assertIn('tidak dikumpulkan', STOCKBIT_RULE)
        self.assertTrue((SYSTEM + STOCKBIT_RULE).startswith(SYSTEM))


INDEX = {
    'format': 1, 'generated_at': '2026-10-07T00:00:00+07:00',
    'days': [{'d': '2026-10-04', 'f': 'sbringkas_2026-10-04_2026-10-04.md', 'detail': 'sbdetail_2026-10-04_2026-10-04.md',
              'k': 120, 'n': 11000, 'classified': 11000, 'unreviewed': 0, 'findings': 900, 'accounts': 3000, 'sha': 'a'},
             {'d': '2026-10-05', 'f': 'sbringkas_2026-10-05_2026-10-05.md', 'detail': 'sbdetail_2026-10-05_2026-10-05.md',
              'k': 130, 'n': 11402, 'classified': 11402, 'unreviewed': 0, 'findings': 950, 'accounts': 3120, 'sha': 'b'}],
    'tickers': {'FORU': [[1, 14, 9, 3, 'dirumorkan: rencana rights issue', {'R': 2, 'C': 1}], [0, 2, 2, 0, '', {}], [9, 1, 1, 1, 'x', {}]]},
    'users': {'@Budi_Trader': [[1, 4, ['FORU'], ['F12', 'F13']]], 'kosong': [[7, 1, [], []]]},
    'user_notes': {'Budi_Trader': {'penilaian': {'text': 'Argumen memakai angka tanpa sumber.', 'finding_ids': ['F12']},
                                   'window': '2026-10-01/2026-10-05', 'private': 'tidak diteruskan'}},
}


class StockbitAsset(unittest.TestCase):
    def test_index_is_trimmed_to_dates_files_and_lowercase_handles(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'stockbit-index.json'
            self.assertIsNone(stockbit_index(path))
            path.write_text(json.dumps(INDEX), encoding='utf-8')
            out = stockbit_index(path)
        self.assertEqual(out['tickers']['FORU'], [
            ['2026-10-04', 'sbringkas_2026-10-04_2026-10-04.md', 2, 2, 0, ''],
            ['2026-10-05', 'sbringkas_2026-10-05_2026-10-05.md', 14, 9, 3, 'dirumorkan: rencana rights issue']])
        self.assertEqual(out['users'], {'budi_trader': [['2026-10-05', 'sbringkas_2026-10-05_2026-10-05.md', 4, ['FORU'], ['F12', 'F13']]]})
        self.assertEqual(out['user_notes'], {'budi_trader': {
            'penilaian': {'text': 'Argumen memakai angka tanpa sumber.', 'finding_ids': ['F12']}, 'window': '2026-10-01/2026-10-05'}})
        self.assertEqual(out['days']['2026-10-05'], {'file': 'sbringkas_2026-10-05_2026-10-05.md', 'n': 11402, 'findings': 950, 'k': 130})

    def test_auxiliary_versions_change_with_stockbit_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            (out / 'events.json').write_bytes(b'{}')
            before = auxiliary_versions(out)
            (out / 'stockbit.json').write_bytes(b'{"days":{}}')
            added = auxiliary_versions(out)
            self.assertNotEqual(added['data_version'], before['data_version'])
            self.assertEqual(added['asset_hashes']['events.json'], before['asset_hashes']['events.json'])
            (out / 'stockbit.json').write_bytes(b'{"days": {}}')
            changed = auxiliary_versions(out)
            self.assertNotEqual(changed['asset_hashes']['stockbit.json'], added['asset_hashes']['stockbit.json'])
            (out / 'stockbit.json').unlink()
            self.assertEqual(auxiliary_versions(out), before)


class EventKind(unittest.TestCase):
    def test_new_stockbit_categories_are_discussion_events(self):
        for cat in ('stockbit-ringkasan', 'stockbit-detail', 'stockbit', 'stockbit-pekan'):
            with self.subTest(cat=cat):
                events = text_events({'cat': cat, 'kind': 'md', 'start': '2026-10-05', 'end': '2026-10-05', 'source_id': 'D9'},
                                     {'FORU'}, [{'content': '- FORU dirumorkan akan rights issue.', 'line': 3}])
                self.assertEqual([(e['ticker'], e['type'], e['kind']) for e in events], [('FORU', 'rights_issue', 'stockbit')])
        events = text_events({'cat': 'lainnya', 'kind': 'md', 'start': '2026-10-05', 'end': '2026-10-05', 'source_id': 'D9'},
                             {'FORU'}, [{'content': 'FORU rights issue.', 'line': 1}])
        self.assertEqual(events[0]['kind'], 'other')


if __name__ == '__main__':
    unittest.main()
