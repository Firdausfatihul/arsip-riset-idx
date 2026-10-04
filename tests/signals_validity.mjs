import test from 'node:test';
import assert from 'node:assert/strict';
import {signalView} from '../worker/signals.mjs';

test('KSEI history sent to the model masks invalid months and preserves their reasons', () => {
  const data = {
    signals:{months:['2026-02', '2026-03'], asof:'2026-03', issuers:{}},
    history:{issuers:{TEST:{n:'Test', usable:[true, false], issues:[[], ['Nama investor ambigu']], holders:[
      {name:'Holder', names:['Holder'], pct:[4.8, 9.9]},
      {name:'Only suspect', names:['Only suspect'], pct:[null, 8.8]}
    ]}}}
  };
  const result = signalView(data, {ticker:'TEST', bagian:'riwayat'}, {add:() => 'O1'}, x => x);
  assert.deepEqual(result.pemegang, [{nama:'Holder', pct:'4.8 -'}]);
  assert.deepEqual(result.catatan, ['2026-03: Nama investor ambigu']);
  assert.match(result.arti_tanda_kosong, /bukan kepemilikan nol/);
  assert.equal(data.history.issuers.TEST.holders[0].pct[1], 9.9, 'source observations are retained');
});

test('valid history and legacy fixtures retain their values', () => {
  for (const usable of [[true, true], undefined]) {
    const data = {
      signals:{months:['2026-02', '2026-03'], asof:'2026-03', issuers:{}},
      history:{issuers:{TEST:{n:'Test', usable, holders:[{name:'Holder', names:['Holder'], pct:[4.8, 5.2]}]}}}
    };
    const result = signalView(data, {ticker:'TEST', bagian:'riwayat'}, {add:() => 'O1'}, x => x);
    assert.equal(result.pemegang[0].pct, '4.8 5.2');
    assert.equal(result.catatan, undefined);
  }
});
