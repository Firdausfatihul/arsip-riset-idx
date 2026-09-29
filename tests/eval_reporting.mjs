import test from 'node:test';
import assert from 'node:assert/strict';
import {localEvalProvenance, summarizeAssessment} from '../tools/eval_reporting.mjs';
import {citations} from '../worker/agent.mjs';

test('completed cases without expectations cannot inflate assessed correctness', () => {
  const summary = summarizeAssessment([
    {status:'complete',fixture_assessed:false,checks:{citations:true}},
    {status:'complete',fixture_assessed:true,checks:{facts:false,citations:true}},
    {status:'complete',fixture_assessed:true,checks:{docs_all:true,citations:false}},
    {status:'complete',fixture_assessed:true,checks:{facts:true,citations:true}},
    {status:'error',fixture_assessed:true,checks:{status:false}},
    {status:'complete',fixture_assessed:true,checks:{facts:true},incomplete:true}
  ]);
  assert.equal(summary.completed,5);
  assert.equal(summary.fixture_assessed,5);
  assert.equal(summary.fixture_passed,1);
  assert.equal(summary.completion_only,1);
  assert.equal(summary.fact_assessed,3);
  assert.equal(summary.fact_failures,1);
  assert.equal(summary.source_assessed,1);
  assert.equal(summary.citation_failures,1);
  assert.equal(summary.incomplete_answers,1);
});

test('local eval runs identify themselves without pretending to have production IDs', () => {
  const a = localEvalProvenance('archive'), b = localEvalProvenance('agentic');
  assert.notEqual(a.run_id,b.run_id);
  assert.equal(a.kind,'evaluation');
  assert.equal(a.execution,'local');
  assert.deepEqual(a.production_request_ids,[]);
});

test('runtime citation parser exposes a missing source inside a reported range', () => {
  const cited = [...new Set(citations('Bukti [D56-D58], profil [K1, K2], pemegang [O3].'))];
  assert.deepEqual(cited,['D56','D57','D58','K1','K2','O3']);
  const known = new Set(['D56','D58','K1','K2','O3']);
  const unmatched = cited.filter(id => !known.has(id));
  assert.deepEqual(unmatched,['D57']);
  const summary = summarizeAssessment([{status:'complete',fixture_assessed:true,
    checks:{facts:true,citations:unmatched.length === 0}}]);
  assert.equal(summary.completed,1);
  assert.equal(summary.fixture_passed,0);
  assert.equal(summary.citation_failures,1);
});
