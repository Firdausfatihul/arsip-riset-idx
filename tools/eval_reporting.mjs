import {randomUUID} from 'node:crypto';

// These runners call local functions. A production smoke test must record its
// request IDs explicitly in the operator's test-run ledger instead.
export function localEvalProvenance(suite) {
  return {run_id:randomUUID(), kind:'evaluation', origin:'test', execution:'local', suite,
    production_request_ids:[]};
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
