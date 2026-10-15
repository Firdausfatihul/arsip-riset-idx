"""Unit tests for tools/archive_tables.py. Fixtures are small synthetic copies of archive shapes (sbdetail findings,
BEI issuer sections, KSEI history, KI report rows); no network, no model."""
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'tools'))
import archive_tables as at  # noqa: E402
from build_worker import stockbit_index, auxiliary_versions  # noqa: E402

TICKERS = {'HELI', 'GRPM', 'PMUI', 'AVIA', 'UNIT', 'ROCK', 'PGLI', 'MENN', 'BIKE', 'ASII', 'AUTO', 'JGLE', 'VKTR'}

SBDETAIL = """# Detail temuan Stockbit Ideas · 1 Oktober 2026

## HELI

HELI · 2026-10-01 · 7 posting / 6 akun

- [Klaim penulis] Pemegang saham 8% HELI sedang menjual sahamnya, menyebabkan harga tidak longsor. — @zeinihzafahrozi 09:10 [pos](https://stockbit.com/post/1) · 1 sumber · celah: tanpa dokumen, tanpa pihak lawan · 10 balasan (F20261001-0146)
- [Rumor] HELI didukung oleh Tanoko melalui Alta. — @mifthahulbarki 10:00 [pos](https://stockbit.com/post/2) · 1 sumber · celah: tanpa dokumen (F20261001-0160)
- [Rumor] HELI didukung oleh Tanoko melalui Alta! — @lain 10:05 [pos](https://stockbit.com/post/3) · +2 akun (juga: 4, 5) · celah: tanpa dokumen (F20261001-0161)
- [Klaim penulis] Menang tender proyek helikopter. — @x 11:00 [pos](https://stockbit.com/post/6) · 1 sumber (F20261001-0162)

Terkait: ROCK, PGLI

## Lintas emiten

- [Rumor] MENN, BIKE: MENN akan diakuisisi BIKE. — @avian 12:00 [pos](https://stockbit.com/post/7) · dari 3 akun · celah: tanpa dokumen (F20261001-0170)

## Tanpa emiten

- [Rumor] Sesuatu tanpa emiten. — @y 12:00 [pos](https://stockbit.com/post/8) · 1 sumber (F20261001-0180)
"""

BEIDETAIL = """# Detail BEI 6 September 2026

## PMUI — PT Prima Multi Usaha Indonesia Tbk

Kesinambungan: hari ini: direvisi, menjadi rencana penjualan saham grpm oleh PMUI dan Agus Susanto kepada PT Tunas Binatama Lestari, Term Sheet diperpanjang hingga 31 Desember 2026.

- 12:07 · Laporan PMUI atas penjualan saham PT Graha Prima Mentari Tbk (KOREKSI) · [pengumuman](https://www.idx.co.id/x.pdf)
  - Fakta:
    - PMUI dan Agus Susanto berencana menjual saham PT Graha Prima Mentari Tbk (grpm) kepada PT Tunas Binatama Lestari (Pembeli).
    - Laba uang aksi naik pada data asli emiten.

## AVIA — PT Avia Avian Tbk

- Fakta:
    - Komisaris Utama Hermanto Tanoko menandatangani laporan.
"""

KI = """# Analisis

| Pembeli yang disebut | PT Tunas Binatama Lestari, disebut bagian Rimau Group. | PT GMP Grup Investama. |
"""

HISTORY = {'version': 'x', 'months': ['2026-05', '2026-06', '2026-07', '2026-08'], 'issuers': {
    'HELI': {'n': 'PT Jaya Trishindo Tbk', 'usable': [True] * 4, 'holders': [
        {'name': 'PT. AVIA NUSANTARA KHATULISTIWA', 'cls': 'Corporate', 'pct': [7.55, 7.74, 8.26, 8.43],
         'sh': [62877300, 64449800, 68778100, 70189300]},
        {'name': 'PT. ALTA INTERNASIONAL INDONESIA', 'cls': 'Corporate', 'pct': [16.0, 16.0, 16.0, 16.0],
         'sh': [133258000] * 4},
        {'name': 'UOB KAY HIAN PTE LTD', 'cls': 'Securities Company', 'pct': [10.18, 10.18, None, None], 'sh': [84793600, 84793600, None, None]}]},
    'AVIA': {'n': 'PT Avia Avian Tbk', 'usable': [True] * 4, 'holders': [
        {'name': 'PT TANCORP SURYA SENTOSA', 'cls': 'Corporate', 'pct': [36.6] * 4, 'sh': [1] * 4},
        {'name': 'PT AVIA AVIAN Tbk', 'cls': 'Corporate', 'pct': [4.6] * 4, 'sh': [1] * 4},
        {'name': 'HERMANTO TANOKO', 'cls': 'Individual', 'pct': [None, None, None, 1.2], 'sh': [None, None, None, 1]}]},
    'UNIT': {'n': 'PT Nusantara Inti Corpora Tbk', 'usable': [True] * 4, 'holders': [
        {'name': 'TANOKO MULYO ATMODJO', 'cls': 'Individual', 'pct': [3.05] * 4, 'sh': [1] * 4}]},
}}
OFFICIAL = {'GRPM': ['PT Graha Prima Mentari Tbk'], 'PMUI': ['PT Prima Multi Usaha Indonesia Tbk'], 'AVIA': ['PT Avia Avian Tbk'],
            'HELI': ['PT Jaya Trishindo Tbk'], 'UNIT': ['PT Nusantara Inti Corpora Tbk']}


def doc(name, cat, start, body, kind='md'):
    return {'name': name, 'cat': cat, 'start': start, 'end': start, 'body': body, 'kind': kind, 'path': 'files/x/' + name,
            'label': start, 'title': name, 'search_body': body}


def claims_fixture():
    return at.parse_claims([doc('sbdetail_2026-10-01_2026-10-01.md', 'stockbit-detail', '2026-10-01', SBDETAIL)], TICKERS)


class Claims(unittest.TestCase):
    def test_rows_kinds_and_accounts(self):
        rows = claims_fixture()['by_ticker']['HELI']
        first = rows[0]
        self.assertEqual(first[:3], ['F20261001-0146', '2026-10-01', 'K'])
        self.assertEqual(first[4], 'zeinihzafahrozi')
        self.assertEqual(first[6], 'tanpa dokumen, tanpa pihak lawan')
        self.assertEqual(first[7], 10)
        self.assertNotIn('stockbit.com', json.dumps(claims_fixture()))

    def test_duplicates_fold_into_first_row(self):
        claims = claims_fixture()
        rows = claims['by_ticker']['HELI']
        alta = [r for r in rows if r[0] == 'F20261001-0160'][0]
        self.assertEqual(alta[9], ['F20261001-0161'])

    def test_cross_issuer_rows_and_accounts(self):
        claims = claims_fixture()
        menn = claims['by_ticker']['MENN'][0]
        self.assertEqual((menn[0], menn[2], menn[5]), ('F20261001-0170', 'R', 3))
        self.assertIn('BIKE', claims['by_ticker'])
        self.assertNotIn('F20261001-0180', json.dumps(claims))

    def test_topics_tender_project_is_not_tender_offer(self):
        names = at.topic_names(at.topics_of('Menang tender proyek helikopter.'))
        self.assertNotIn('tender_offer', names)
        self.assertIn('tender_offer', at.topic_names(at.topics_of('ASII akan tender offer AUTO')))
        self.assertIn('akuisisi_pengendali', at.topic_names(at.topics_of('akan diambil alih Rimau Group lewat term sheet')))
        self.assertNotIn('private_placement', at.topic_names(at.topics_of('grup PP kena denda')))
        self.assertNotIn('rights_issue', at.topic_names(at.topics_of('Berita CNBC: RI berpotensi memperoleh Rp714,9 triliun')))


class Subjects(unittest.TestCase):
    def test_grpm_gets_the_pmui_subject_row(self):
        docs = [doc('beidetail_2026-09-06_2026-09-06.md', 'bei-detail', '2026-09-06', BEIDETAIL)]
        out = at.scan_subjects(docs, TICKERS, OFFICIAL, plain_words=['laba', 'uang', 'aksi'])
        rows = out['GRPM']
        self.assertTrue(all(r[1] == 'PMUI' for r in rows))
        self.assertTrue(any(r[4] == 'transaksi_saham' and 'grpm oleh PMUI' in r[5] for r in rows))
        self.assertTrue(any('(grpm)' in r[5] for r in rows))
        self.assertNotIn('PMUI', out)  # the filer's own section never names itself as a subject
        self.assertFalse(any('Laba uang aksi' in r[5] for rows in out.values() for r in rows))

    def test_false_mentions_are_skipped(self):
        body = '''# Detail BEI

## WEGE — PT Wijaya Karya Bangunan Gedung Tbk

- PT Wijaya Karya Bangunan Gedung Tbk menerima penghargaan.

## BWPT — PT Eagle High Plantations Tbk

- Realisasi pembelian TBS dari PT bumi agro Prima sebanyak 10 ton.
- realisasi_pembelian_CPO_dari_PT_BUMI_AGRO_PRIMA.
- Lampiran: city retail developments reviu.pdf

## RATU — PT Raharja Energi Cepu Tbk

- Pengambilalihan saham SMSD dibiayai pinjaman Bank Mandiri (BMRI).
'''
        official = {'WIKA': ['PT Wijaya Karya (Persero) Tbk'], 'WEGE': ['PT Wijaya Karya Bangunan Gedung Tbk']}
        tickers = TICKERS | {'WIKA', 'WEGE', 'BWPT', 'BUMI', 'AGRO', 'CITY', 'RATU', 'BMRI', 'SMSD'}
        out = at.scan_subjects([doc('beidetail_2026-09-07_2026-09-07.md', 'bei-detail', '2026-09-07', body)], tickers, official)
        self.assertNotIn('WIKA', out)  # WEGE's own longer name is not WIKA
        self.assertNotIn('AGRO', out)  # "PT bumi agro Prima": no saham/emiten/tbk next to the word
        self.assertNotIn('BUMI', out)  # snake_case identifier
        self.assertNotIn('CITY', out)  # attachment name
        self.assertEqual(out['BMRI'][0][4], 'kreditur')  # a loan that funds an acquisition names the lender


class Links(unittest.TestCase):
    def test_claim_after_last_ksei_month_is_stated_neutrally(self):
        cov = at.coverage(['2026-10-01'], ['2026-08-29', '2026-10-01'], HISTORY['months'])
        links = at.build_links(claims_fixture(), {'tickers': {}}, {}, HISTORY, cov)['links']['HELI']
        self.assertFalse(any(v[0] == 'bertentangan' for vs in links.values() for v in vs))
        alta = links['F20261001-0160'][0]
        self.assertEqual(alta[0], 'tercatat')
        self.assertIn('KSEI s.d. Agustus 2026 mencatat PT. ALTA INTERNASIONAL INDONESIA 16,00%', alta[2])
        self.assertIn('belum ada data KSEI untuk Oktober 2026', alta[2])
        # "Pemegang saham 8%" names nobody: a holder with a similar percentage is not the check.
        self.assertFalse(any('AVIA NUSANTARA' in v[2] for v in links['F20261001-0146']))
        self.assertFalse(any(v[0] == 'didukung' for vs in links.values() for v in vs))  # no typed disclosure, no support

    def test_holder_that_left_the_list_and_unusable_months(self):
        history = json.loads(json.dumps(HISTORY))
        history['issuers']['HELI']['holders'][1]['pct'] = [16.0, 16.0, None, None]
        history['issuers']['HELI']['usable'] = [True, True, True, False]
        text = 'HELI didukung oleh Alta'
        claims = {'by_ticker': {'HELI': [['F1', '2026-10-01', 'R', text, 'a', 1, '', 0, at.topics_of(text)]]}}
        cov = at.coverage(['2026-10-01'], ['2026-10-01'], history['months'])
        line = at.build_links(claims, {'tickers': {}}, {}, history, cov)['links']['HELI']['F1'][0][2]
        self.assertIn('terakhir tercatat >1% di KSEI Juni 2026 (16,00%); tidak lagi >1% s.d. Juli 2026', line)

    def test_claim_inside_ksei_window_can_contradict(self):
        text = 'HELI: Avia Nusantara Khatulistiwa sedang menjual sahamnya'
        claims = {'by_ticker': {'HELI': [['F1', '2026-08-20', 'K', text, 'a', 1, '', 0, at.topics_of(text)]]}}
        cov = at.coverage(['2026-08-20'], ['2026-08-20'], HISTORY['months'])
        verdict = at.build_links(claims, {'tickers': {}}, {}, HISTORY, cov)['links']['HELI']['F1'][0]
        self.assertEqual(verdict[0], 'bertentangan')
        self.assertIn('bertentangan dengan KSEI s.d. Agustus 2026', verdict[2])

    def test_ticker_code_alone_does_not_name_a_holder(self):
        claims = {'by_ticker': {'AVIA': [['F1', '2026-10-12', 'M', 'Direktur AVIA membeli saham AVIA', 'a', 1, '', 0,
                                           at.topics_of('Direktur AVIA membeli saham AVIA')]]}}
        cov = at.coverage(['2026-10-12'], ['2026-10-12'], HISTORY['months'])
        verdicts = at.build_links(claims, {'tickers': {}}, {}, HISTORY, cov)['links'].get('AVIA', {}).get('F1', [])
        self.assertFalse(any('AVIA AVIAN' in v[2] for v in verdicts))

    def test_checks_are_per_ticker_for_cross_issuer_findings(self):
        text = 'VKTR, JGLE: Emiten Grup Bakrie melakukan rights issue'
        row = ['F2', '2026-10-02', 'R', text, 'a', 1, '', 0, at.topics_of(text)]
        claims = {'by_ticker': {'JGLE': [list(row)], 'VKTR': [list(row)]}}
        bei = {'tickers': {'VKTR': [['2026-09-29', 'baru', 'Hari ini muncul PMHMETD I rights issue', {'aksi_korporasi': 1}]]}}
        cov = at.coverage(['2026-10-02'], ['2026-09-29', '2026-10-02'], ['2026-08'])
        links = at.build_links(claims, bei, {}, None, cov)['links']
        self.assertEqual(links['VKTR']['F2'][0][0], 'didukung')
        self.assertNotIn('F2', links.get('JGLE', {}))  # the text names VKTR first: not a JGLE claim to check

    def test_typed_bei_row_supports_and_other_topics_do_not(self):
        claims = {'by_ticker': {'GRPM': [['F1', '2026-10-06', 'R', 'GRPM akan diakuisisi lewat term sheet', 'a', 1, '', 0,
                                           at.topics_of('GRPM akan diakuisisi lewat term sheet')]]}}
        bei = {'tickers': {'GRPM': [['2026-09-20', 'baru', 'laporan keuangan interim', {'laporan_keuangan': 1}]]}}
        cov = at.coverage(['2026-10-06'], ['2026-09-20', '2026-10-06', '2026-10-07', '2026-10-08'], ['2026-08'])
        self.assertEqual(at.build_links(claims, bei, {}, None, cov)['links']['GRPM']['F1'][0][0], 'lain')
        subjects = {'GRPM': [['2026-09-06', 'PMUI', 'beidetail.md', 12, 'transaksi_saham', 'penjualan saham grpm']]}
        verdicts = at.build_links(claims, bei, subjects, None, cov)['links']['GRPM']['F1']
        self.assertEqual(verdicts[0][0], 'didukung')
        self.assertIn('PMUI', verdicts[0][2])


class Entities(unittest.TestCase):
    def build(self):
        docs = [doc('beidetail_2026-09-06_2026-09-06.md', 'bei-detail', '2026-09-06', BEIDETAIL),
                doc('ki_01102026.md', 'keterbukaan-informasi', '2026-10-01', KI)]
        return at.build_entities(HISTORY, None, docs, {'by_ticker': {}}, OFFICIAL, {'hashim', 'hasim', 'hasyim', 'tanoto'},
                                 texts=['Hermanto Tanoko', 'Tanoko', 'kabar Gede', 'Rimau Group', 'grup Rimau'])

    def test_avia_nusantara_is_not_issuer_avia_and_no_surname_merge(self):
        ents = self.build()['names']
        avia = ents[at.tokkey('PT. AVIA NUSANTARA KHATULISTIWA')]
        self.assertEqual(list(avia['t']), ['HELI'])
        self.assertNotIn('issuer', avia)
        self.assertNotEqual(at.tokkey('HERMANTO TANOKO'), at.tokkey('TANOKO MULYO ATMODJO'))
        hermanto = ents[at.tokkey('HERMANTO TANOKO')]['t']['AVIA']
        self.assertTrue(any(r[0] == 'ksei' for r in hermanto) and any(r[0] == 'komisaris utama' for r in hermanto))
        self.assertNotIn(at.tokkey('UOB KAY HIAN PTE LTD'), ents)  # custodian/securities accounts are not parties

    def test_rimau_alias_from_ki_and_buyer_role(self):
        out = self.build()
        member = at.tokkey('Tunas Binatama Lestari')
        self.assertIn(member, out['alias']['RIMAU'])
        self.assertEqual(out['names']['RIMAU']['k'], 'group')
        self.assertEqual(out['alias_src']['RIMAU'][0][1:3], ['ki_01102026.md', 3])
        self.assertIn('pembeli', [r[0] for r in out['names'][member]['t']['PMUI']])
        self.assertIn('tanoko', out['namelike'])
        self.assertNotIn('gede', out['namelike'])
        self.assertIn('graha', out['issuer_words'])

    def test_spelling_variants_need_same_first_letter_and_one_edit(self):
        variants = at.spelling_variants(['hashim', 'tanoko'], {'hasim', 'hasyim', 'kashim', 'hashimoto', 'tanoto'})
        self.assertEqual(variants['hashim'], ['hasim', 'hasyim'])
        self.assertEqual(variants['tanoko'], ['tanoto'])


class Assets(unittest.TestCase):
    def test_coverage_weekend_days_are_not_bei_gaps(self):
        cov = at.coverage(['2026-10-01', '2026-10-03'], ['2026-10-01', '2026-10-05'], ['2026-02', '2026-08'])
        self.assertEqual(cov['stockbit'], ['2026-10-01', '2026-10-03'])
        self.assertEqual(cov['bei'], ['2026-10-01', '2026-10-05', ['2026-10-02']])
        self.assertEqual(cov['ksei'], ['2026-02', '2026-08'])

    def test_stockbit_json_keeps_desk_thread_and_basis(self):
        index = {'days': [{'d': '2026-10-06', 'f': 'sbringkas_2026-10-06_2026-10-06.md'}], 'tickers': {},
                 'users': {'@Zein': [[0, 4, ['HELI'], ['F1']]]},
                 'user_notes': {'@Zein': {'benang': {'text': 'HELI lintas hari', 'finding_ids': ['F1']},
                                          'based_on': {'findings': 69, 'last_day': '2026-10-12'}, 'private': 'x'}}}
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'stockbit-index.json'
            path.write_text(json.dumps(index))
            out = stockbit_index(path)
        self.assertEqual(out['user_notes'], {'zein': {'benang': {'text': 'HELI lintas hari', 'finding_ids': ['F1']},
                                                      'based_on': {'findings': 69, 'last_day': '2026-10-12'}}})

    def test_table_hashes_change_the_data_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            (out / 'events.json').write_bytes(b'{}')
            (out / 'subjects.json').write_bytes(b'{"by_ticker":{}}')
            before = auxiliary_versions(out)
            (out / 'subjects.json').write_bytes(b'{"by_ticker":{"GRPM":[]}}')
            after = auxiliary_versions(out)
        self.assertIn('subjects.json', before['asset_hashes'])
        self.assertNotEqual(before['data_version'], after['data_version'])


if __name__ == '__main__':
    unittest.main()
