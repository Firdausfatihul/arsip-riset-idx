import {randomUUID} from 'node:crypto';

// These runners call local functions. A production smoke test must record its
// request IDs explicitly in the operator's test-run ledger instead.
export function localEvalProvenance(suite) {
  return {run_id:randomUUID(), kind:'evaluation', origin:'test', execution:'local', suite,
    production_request_ids:[]};
}

export function sumUsage(items) {
  const total = {calls:0,input_bytes:0,output_token_budget:0,known_cost_usd:0,prompt_tokens:0,
    completion_tokens:0,cached_tokens:0,cache_write_tokens:0,missing_usage_calls:0};
  for (const usage of items) for (const [key, value] of Object.entries(usage || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) total[key] = (total[key] || 0) + value;
  }
  return total;
}

// A case's final answer determines its checks; every primer and retry still costs money.
export function accountRuns(runs) {
  return {runs,usage:sumUsage(runs.map(r => r.usage)),
    receipts:runs.flatMap(r => (r.receipts || []).map((receipt, i) => ({...receipt,phase:r.phase,attempt:r.attempt,call:i + 1})))};
}

export async function runEvalAttempts(runOnce, {phase='question', maxAttempts=1,
  wait=ms => new Promise(ok => setTimeout(ok, ms))} = {}) {
  const runs = [], started = Date.now();
  let final;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    final = await runOnce(attempt);
    runs.push({phase,attempt,status:final.error || !final.result ? 'error' : final.result.clarification ? 'clarification' : 'complete',
      error:final.error || null,usage:final.usage,receipts:final.receipts || [],metrics:final.metrics || {},elapsed_ms:final.elapsed_ms});
    if (!/membatasi permintaan/.test(final.error || '') || attempt === maxAttempts) break;
    await wait(20000 * attempt);
  }
  return {...final,...accountRuns(runs),final_usage:final.usage,attempts:runs.length,elapsed_ms:Date.now() - started};
}

export function summarizeAssessment(results) {
  const count = fn => results.filter(fn).length;
  return {
    completed:count(r => r.status === 'complete'),
    fixture_assessed:count(r => r.fixture_assessed),
    fixture_passed:count(r => r.fixture_assessed && r.status === 'complete'
      && Object.values(r.checks || {}).every(Boolean) && !r.incomplete),
    completion_only:count(r => !r.fixture_assessed),
    source_assessed:count(r => r.checks?.docs_all !== undefined || r.checks?.docs_any !== undefined),
    source_failures:count(r => r.checks?.docs_all === false || r.checks?.docs_any === false),
    fact_assessed:count(r => r.checks?.facts !== undefined),
    fact_failures:count(r => r.checks?.facts === false),
    term_failures:count(r => r.checks?.terms_include === false || r.checks?.terms_exclude === false),
    citation_failures:count(r => r.checks?.citations === false),
    incomplete_answers:count(r => r.incomplete),
    assessment_note:'Completed means execution finished. Fixture checks cover specified terms, documents, fact patterns and citation IDs only; they are not a full factual-accuracy or coverage audit. Cases without content expectations are not counted as fixture-assessed.'
  };
}
