"""Isolated filesystem/HTTP tests. No real Signal Desk, user sources or credentials."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'tools'))
from build_safety import check_output, check_source
import build
import sync_idx as sync
from chat_archive import report_source

class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.dest=self.root/'needtobeindexed/idx-signal-desk';self.dest.mkdir(parents=True)
        self.patch=patch.multiple(sync,ROOT=self.root,DEST=self.dest,STATE=self.dest/'.sync.json',OWNERSHIP_JSON=self.dest/'kepemilikan.json')
        self.patch.start();self.addCleanup(self.patch.stop)
    def test_output_boundaries(self):
        src=self.root/'needtobeindexed'
        for p in [self.root,src,src/'sub',self.root.parent]:
            with self.assertRaises(ValueError):check_output(p,self.root,[src],kind='site')
        important=self.root/'important';important.mkdir();(important/'canary').write_text('keep')
        with self.assertRaises(ValueError):check_output(important,self.root,[src],kind='site')
        self.assertEqual((important/'canary').read_text(),'keep')
        self.assertEqual(check_output(self.root/'new-output',self.root,[src],kind='site'),(self.root/'new-output').resolve())
    def test_symlink_source_and_output(self):
        external=self.root/'private.md';external.write_text('private canary')
        link=self.dest/'leak.md';link.symlink_to(external)
        with self.assertRaises(ValueError):check_source(link,self.root/'needtobeindexed')
        out=self.root/'output';out.symlink_to(self.dest,target_is_directory=True)
        with self.assertRaises(ValueError):check_output(out,self.root,[self.root/'needtobeindexed'],kind='site')
    def test_atomic_write_ignores_predictable_temp_symlink(self):
        victim=self.root/'canary';victim.write_text('keep')
        (self.dest/'.test.md.tmp').symlink_to(victim)
        sync.write_if_changed(self.dest/'test.md','new')
        self.assertEqual(victim.read_text(),'keep');self.assertEqual((self.dest/'test.md').read_text(),'new')
        (self.dest/'link.md').symlink_to(victim)
        with self.assertRaises(ValueError):sync.write_if_changed(self.dest/'link.md','bad')
        self.assertEqual(victim.read_text(),'keep')
    def test_failed_profile_guard_discards_all_staged_writes_and_deletes(self):
        file=self.dest/'digest_2026-09-01_2026-09-02.md';file.write_text('original')
        before={p.name:p.read_bytes() for p in self.dest.iterdir()}
        def work(args):
            sync.write_if_changed(sync.DEST/file.name,'changed')
            sync.write_if_changed(sync.DEST/'digest_2026-09-02_2026-09-03.md','new')
            raise sync.ProfileMismatch('different profile')
        with patch.object(sync,'_sync_once',work),self.assertRaises(sync.ProfileMismatch):sync.sync_once(SimpleNamespace())
        self.assertEqual({p.name:p.read_bytes() for p in self.dest.iterdir()},before)
    def test_success_commits_managed_files_and_preserves_other_files(self):
        (self.dest/'notes.txt').write_text('untouched');(self.dest/'digest_old.md').write_text('old')
        def work(args):
            (sync.DEST/'digest_old.md').unlink();sync.write_if_changed(sync.DEST/'kepemilikan.json','{}');return True
        with patch.object(sync,'_sync_once',work):self.assertTrue(sync.sync_once(SimpleNamespace()))
        self.assertEqual((self.dest/'notes.txt').read_text(),'untouched');self.assertFalse((self.dest/'digest_old.md').exists())
    def test_concurrent_change_aborts_commit(self):
        file=self.dest/'kepemilikan.json';file.write_text('old')
        def work(args):
            sync.write_if_changed(sync.DEST/'kepemilikan.json','staged');file.write_text('concurrent');return True
        with patch.object(sync,'_sync_once',work),self.assertRaises(RuntimeError):sync.sync_once(SimpleNamespace())
        self.assertEqual(file.read_text(),'concurrent')
    def test_failed_commit_restores_previous_files(self):
        a=self.dest/'digest_a.md';a.write_text('old');b=self.dest/'kepemilikan.json';b.write_text('old-json')
        def work(args):
            sync.write_if_changed(sync.DEST/a.name,'new');sync.write_if_changed(sync.DEST/b.name,'new-json');return True
        write=sync.write_if_changed;failed=False
        def fail_once(path,text):
            nonlocal failed
            if path==b and text=='new-json' and not failed:failed=True;raise OSError('simulated disk failure')
            return write(path,text)
        with patch.object(sync,'_sync_once',work),patch.object(sync,'write_if_changed',fail_once),self.assertRaises(OSError):sync.sync_once(SimpleNamespace())
        self.assertEqual(a.read_text(),'old');self.assertEqual(b.read_text(),'old-json')
    def test_digest_filename_rejects_traversal_and_bad_times(self):
        valid=dict(start_date='2026-09-01',end_date='2026-09-02',start_at='2026-09-01T00:00:00',end_at='2026-09-02T23:59:00')
        self.assertEqual(sync.digest_name(valid),'digest_2026-09-01_2026-09-02.md')
        for bad in ['../../outside','2026-99-99','2026-09-01/../../']:
            with self.assertRaises(ValueError):sync.digest_name({**valid,'start_date':bad})
        with self.assertRaises(ValueError):sync.digest_name({**valid,'start_at':'2026-09-01T99:99:00'})
    def test_sync_transport_boundary(self):
        for url in ['file:///tmp','http://remote.test','https://user:pass@example.com','https://example.com?x=1']:
            with self.assertRaises(ValueError):sync.Server(url)
        self.assertEqual(sync.Server('http://127.0.0.1:8787').base,'http://127.0.0.1:8787')
        with self.assertRaises(ValueError):sync.NoRedirect().redirect_request(None,None,302,'',{},'https://canary.invalid')
    def test_ledger_sqlite_read_only(self):
        data=self.root/'profile';db=data/'ownership/ledger.sqlite3';db.parent.mkdir(parents=True)
        with sqlite3.connect(db) as c:
            c.executescript('CREATE TABLE ksei_files(file_id TEXT, as_of TEXT,fetched_at TEXT,active INTEGER);CREATE TABLE ksei_holdings(file_id TEXT,ticker TEXT);INSERT INTO ksei_files VALUES("1","2026-09-01","x",1);INSERT INTO ksei_holdings VALUES("1","SOCI");')
        before=db.read_bytes();result=sync.read_ledger({'data_dir':str(data)})
        self.assertEqual(result['tickers'],['SOCI']);self.assertEqual(before,db.read_bytes())
    def test_source_urls_and_redaction(self):
        for url in ['javascript:bad()','https://user:pass@example.com','https://example.com/\nsecret']:
            self.assertIsNone(sync.https_or_none(url))
        self.assertEqual(sync.https_or_none('https://www.idx.co.id/a.pdf'),'https://www.idx.co.id/a.pdf')
        redacted=sync.redact('Hubungi 0812-3456-7890 passcode: 123456 https://example.test?pwd=12345')
        self.assertNotIn('0812-3456-7890',redacted);self.assertNotIn('123456',redacted);self.assertNotIn('pwd=12345',redacted)
    def test_all_wrapped_reports_restore_original_for_AI(self):
        for p in (ROOT/'site/files').rglob('*.html'):
            self.assertEqual(report_source(p.read_text()),(ROOT/'needtobeindexed'/p.name).read_text())
    def test_script_data_cannot_close_script_or_enter_comment_state(self):
        doc=build.load_doc(next((ROOT/'needtobeindexed').glob('*.md')),0)
        doc['content']='<!--<script></script><img src=x onerror=bad>\u2028';doc['title']='</script><script>bad()</script>'
        _,body=build.build_page([doc],{doc['cat']:[doc]})
        import re
        payload=re.search(r'id="arsip-data">(.*?)</script>',body,re.S)[1]
        self.assertNotIn('<',payload);self.assertEqual(json.loads(payload)['docs'][0]['content'],doc['content'])

if __name__=='__main__':unittest.main()
