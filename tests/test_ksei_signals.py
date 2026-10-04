"""KSEI signal layer on the real kepemilikan.json (no network). Facts checked by hand against the KSEI rows."""
import copy, json, os, pathlib, subprocess, sys, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import ksei_signals  # noqa: E402

SOURCE = ROOT / 'needtobeindexed' / 'idx-signal-desk' / 'kepemilikan.json'


class KseiValidity(unittest.TestCase):
    def data(self):
        return {'format': 6, 'months': [{'p': '2026-02'}, {'p': '2026-03'}],
                'names': ['Seller', 'Buyer', 'Anchor'], 'classes': ['Individual'],
                'companies': [{'t': 'TEST', 'n': 'Test', 'k': [
                    {'tp': 14.8, 'h': [[0, 0, 0, 'L', 10, 1000, 1], [2, 2, 0, 'L', 4.8, 480, 1]]},
                    {'tp': 14.8, 'h': [[1, 1, 0, 'L', 10, 1000, 1], [2, 2, 0, 'L', 4.8, 480, 1]]}]}]}

    def kinds(self, signals, ticker='TEST'):
        return {s['k'] for s in signals['issuers'].get(ticker, {}).get('signals', [])}

    def test_valid_control_produces_moves(self):
        signals, _ = ksei_signals.build(self.data())
        self.assertTrue({'transfer', 'new', 'exit', 'near5'} <= self.kinds(signals))

    def test_either_flagged_endpoint_cannot_generate_moves(self):
        for endpoint in (0, 1):
            with self.subTest(endpoint=endpoint):
                data = self.data()
                data['companies'][0]['k'][endpoint]['i'] = ['Persentase tidak cocok dengan total saham.']
                signals, history = ksei_signals.build(data)
                self.assertFalse(self.kinds(signals) & {'transfer', 'split', 'new', 'exit'})
                self.assertFalse(history['issuers']['TEST']['usable'][endpoint])
                self.assertTrue(history['issuers']['TEST']['issues'][endpoint])
                anchor = next(h for h in history['issuers']['TEST']['holders'] if h['name'] == 'Anchor')
                self.assertEqual(anchor['pct'][endpoint], 4.8, 'raw flagged observations stay inspectable')

    def test_suspect_latest_does_not_supply_facts_or_party_endpoint(self):
        data = self.data()
        data['companies'][0]['k'][1]['i'] = ['Nama investor ambigu.']
        signals, _ = ksei_signals.build(data)
        self.assertFalse(self.kinds(signals))
        self.assertNotIn(ksei_signals.tokkey('Buyer'), signals['parties'])
        self.assertEqual(signals['parties'][ksei_signals.tokkey('Anchor')]['series'][0][2], '2026-02')

    def test_empty_missing_and_invalid_numeric_snapshots_are_unusable(self):
        for bad in (None, {'tp': 0, 'h': []}, {'tp': 101, 'h': [[0, 0, 0, 'L', 101, 1000, 1]]},
                    {'tp': 10, 'h': [[0, 0, 0, 'L', 10, None, 1]]}):
            with self.subTest(bad=bad):
                data = self.data()
                # Retain the month axis through another issuer, as real files do.
                data['companies'].append({**copy.deepcopy(data['companies'][0]), 't': 'CTRL'})
                data['companies'][0]['k'][0] = bad
                signals, history = ksei_signals.build(data)
                self.assertFalse(self.kinds(signals) & {'transfer', 'split', 'new', 'exit'})
                self.assertFalse(history['issuers']['TEST']['usable'][0])

    def test_rename_needs_both_valid_endpoints_in_each_issuer(self):
        data = self.data()
        data['companies'].append({**copy.deepcopy(data['companies'][0]), 't': 'TWO'})
        signals, _ = ksei_signals.build(data)
        self.assertTrue(signals['renames'])
        for endpoint in (0, 1):
            bad = copy.deepcopy(data)
            bad['companies'][0]['k'][endpoint]['i'] = ['Perlu dicek.']
            signals, _ = ksei_signals.build(bad)
            self.assertFalse(signals['renames'])

    def test_no_ksei_observations_returns_empty_layer(self):
        data = self.data()
        data['companies'][0]['k'] = [None, None]
        signals, history = ksei_signals.build(data)
        self.assertIsNone(signals['asof'])
        self.assertEqual(signals['issuers'], {})
        self.assertEqual(history['issuers'], {})


@unittest.skipUnless(SOURCE.exists(), 'kepemilikan.json not synced')
class KseiSignals(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.signals, cls.history = ksei_signals.build(json.loads(SOURCE.read_text(encoding='utf-8')))

    def of(self, ticker, kind):
        return [s for s in self.signals['issuers'].get(ticker, {}).get('signals', []) if s['k'] == kind]

    def test_split_of_a_controller_block_into_new_holders(self):
        split = next(s for s in self.of('LUCY', 'split') if s['m'] == '2026-06')
        self.assertEqual(split['shares'], 378693473)
        self.assertIn(['PT SENTOSA BERSAMA MITRA', 75000000], split['to'])
        self.assertTrue(any(shares == 71069516 for _, shares in split['to']))
        self.assertIn('bukan bukti', split['kalimat'])

    def test_seller_matched_to_new_holders(self):
        split = next(s for s in self.of('HELI', 'split') if s['m'] == '2026-03')
        self.assertIn(['PT. ALTA INTERNASIONAL INDONESIA', 133258000], split['to'])
        self.assertIn(['PT. Anugerah Bumiputra', 22500000], split['to'])

    def test_exact_transfers_and_tiers(self):
        asli = next(s for s in self.of('ASLI', 'transfer') if s['shares'] == 732500000)
        self.assertTrue(asli['exact'])
        self.assertEqual(asli['tier'], 'sedang', 'round lot')
        flmc = next(s for s in self.of('FLMC', 'transfer') if s['shares'] == 45177321)
        self.assertEqual((flmc['to'], flmc['tier']), ('HANS SAPUTRA', 'kuat'))
        brrc = next(s for s in self.of('BRRC', 'split') if s['m'] == '2026-08')
        self.assertEqual(sorted(x for _, x in brrc['to']), [21588700, 21588700])
        self.assertEqual(brrc['tier'], 'kuat')

    def test_word_order_variant_is_one_holder_not_an_exit(self):
        meja = self.signals['issuers'].get('MEJA', {}).get('signals', [])
        self.assertFalse([s for s in meja if s['k'] in ('new', 'exit') and 'TRIPLE' in s['who'].upper()])

    def test_renames_detected_and_custodians_excluded(self):
        pairs = {(r['old'], r['new']) for r in self.signals['renames']}
        self.assertIn(('PT BASIS UTAMA PRIMA', 'PT TIRTA ORISA YASA'), pairs)
        self.assertIn(('PT MAJUKARYA MANDIRI INDONESIA', 'NUSANTARA ENERGI BERSIH, PT'), pairs)
        for r in self.signals['renames']:
            for name in (r['old'], r['new']):
                self.assertFalse(ksei_signals.custodian(name, ''), name)

    def test_clusters_compared_with_the_largest_holder(self):
        self.assertGreater(self.of('BOGA', 'cluster')[0]['vs_top'], 0)
        self.assertGreater(self.of('EURO', 'cluster')[0]['vs_top'], 0)
        self.assertAlmostEqual(self.of('ARKO', 'cluster')[0]['total'], 8.25, delta=0.05)
        self.assertIn('bukan bukti bertindak bersama', self.of('ARKO', 'cluster')[0]['kalimat'])

    def test_party_index_and_history(self):
        party = self.signals['parties'][ksei_signals.tokkey('PT TRIPLE BERSAMA BERKAH')]
        self.assertTrue({'EPAC', 'MEJA'} <= {row[0] for row in party['series']})
        holders = self.history['issuers']['MEJA']['holders']
        triple = [h for h in holders if 'TRIPLE' in h['name'].upper()]
        self.assertEqual(len(triple), 1, 'variants merged into one series')

    def test_sizes_and_determinism(self):
        again, _ = ksei_signals.build(json.loads(SOURCE.read_text(encoding='utf-8')))
        self.assertEqual(json.dumps(again, sort_keys=True), json.dumps(self.signals, sort_keys=True))
        self.assertLess(len(json.dumps(self.signals, ensure_ascii=False)), 5_000_000)
        self.assertEqual(len(self.signals['leaderboard']), 50)

    def test_generated_bytes_are_stable_across_python_hash_seeds(self):
        script = '''import hashlib,json,pathlib,sys,tempfile
sys.path.insert(0,sys.argv[2])
import ksei_signals
with tempfile.TemporaryDirectory() as tmp:
    out=pathlib.Path(tmp)
    ksei_signals.write(pathlib.Path(sys.argv[1]),out)
    print(json.dumps({name:hashlib.sha256((out/name).read_bytes()).hexdigest()
        for name in ('signals.json','ksei_history.json')}))
'''
        outputs = [subprocess.check_output([sys.executable, '-B', '-c', script, str(SOURCE), str(ROOT / 'tools')],
                                          env={**os.environ, 'PYTHONHASHSEED': seed})
                   for seed in ('1', '777')]
        self.assertEqual(outputs[0], outputs[1], 'set iteration must not change generated asset bytes')


if __name__ == '__main__':
    unittest.main()
