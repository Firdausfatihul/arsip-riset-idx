import test from 'node:test';
import assert from 'node:assert/strict';
import {localEvalProvenance, summarizeAssessment, accountRuns, runEvalAttempts} from '../tools/eval_reporting.mjs';
import {citations} from '../worker/citations.mjs';

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

test('primer and failed retries stay in cost totals while the final result controls assessment', async () => {
  const response = (cost, answer, error) => ({result:answer ? {answer} : undefined,error,
    usage:{calls:1,known_cost_usd:cost,prompt_tokens:100,completion_tokens:10,cached_tokens:20,missing_usage_calls:error ? 1 : 0},
    receipts:[{cost,prompt_tokens:100,completion_tokens:10,cached_tokens:20}],metrics:{agent_tool_calls:2},elapsed_ms:1});
  const primer = await runEvalAttempts(async () => response(0.01,'prior context'),{phase:'primer'});
  const waits = [];
  const question = await runEvalAttempts(async attempt => attempt === 1
    ? response(0.02,undefined,'Layanan AI sedang membatasi permintaan.')
    : response(0.03,'final answer'),{maxAttempts:3,wait:async ms => waits.push(ms)});
  const report = accountRuns([...primer.runs,...question.runs]);
  assert.equal(question.result.answer,'final answer');
  assert.equal(question.error,undefined);
  assert.equal(question.attempts,2);
  assert.equal(question.final_usage.known_cost_usd,0.03);
  assert.deepEqual(waits,[20000]);
  assert.deepEqual(report.runs.map(r => [r.phase,r.attempt,r.status]),[
    ['primer',1,'complete'],['question',1,'error'],['question',2,'complete']]);
  assert.equal(report.usage.calls,3);
  assert.ok(Math.abs(report.usage.known_cost_usd - 0.06) < 1e-12);
  assert.equal(report.usage.prompt_tokens,300);
  assert.equal(report.usage.completion_tokens,30);
  assert.equal(report.usage.cached_tokens,60);
  assert.equal(report.usage.missing_usage_calls,1);
  assert.deepEqual(report.receipts.map(r => [r.phase,r.attempt,r.cost]),[
    ['primer',1,0.01],['question',1,0.02],['question',2,0.03]]);
});

test('an exhausted rate limit retains every attempt without a final unnecessary wait', async () => {
  const waits = [];
  const r = await runEvalAttempts(async () => ({error:'membatasi permintaan',
    usage:{calls:1,known_cost_usd:0.01,missing_usage_calls:1}}),{maxAttempts:3,wait:async ms => waits.push(ms)});
  assert.equal(r.error,'membatasi permintaan');
  assert.equal(r.result,undefined);
  assert.equal(r.usage.calls,3);
  assert.equal(r.usage.missing_usage_calls,3);
  assert.equal(r.runs.length,3);
  assert.deepEqual(waits,[20000,40000]);
});

test('a non-retry error terminates the case and retains its partial usage', async () => {
  const r = await runEvalAttempts(async () => ({error:'source unavailable',
    usage:{calls:2,known_cost_usd:0.02}}),{maxAttempts:4,wait:async () => assert.fail('must not wait')});
  assert.equal(r.attempts,1);
  assert.equal(r.usage.calls,2);
  assert.equal(r.usage.known_cost_usd,0.02);
});
