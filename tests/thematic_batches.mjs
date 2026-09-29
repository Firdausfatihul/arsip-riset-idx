import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseThematic} from '../worker/thematic.mjs';

const encoder=new TextEncoder();
function groups(count=500){
  const content='SGX '+ '漢字"\\'.repeat(300);
  return [{doc:{source_id:'D1',document_id:'stable',document_hash:'hash'},rows:Array.from({length:count},(_,i)=>({
    section_id:'s'+i,line:i+1,kind:'context',context:'候補'.repeat(90),tickers:[],
    start:i*10000,end:i*10000+content.length,content
  }))}];
}
function cache(){
  const saved=new Map();
  return {saved,async once(kind,key,fn){
    if(saved.has(key))return {hit:true,value:saved.get(key)};
    const value=await fn();saved.set(key,value);return {hit:false,value};
  }};
}

test('UTF-8 batches preserve every preview and global ID, allow empty batches, and reuse the union cache',async()=>{
  const input=groups(),seen=[],sizes=[],saved=cache(),stats={};let active=0;
  const model={complete:async messages=>{
    assert.equal(active++,0,'calls must remain sequential');
    const bytes=encoder.encode(JSON.stringify(messages)).length;sizes.push(bytes);
    assert.ok(bytes<=380000,bytes);
    const rows=JSON.parse(messages[1].content);seen.push(...rows);
    assert.ok(rows.every(row=>row.excerpt.includes('SGX')&&row.context.length===180));
    await Promise.resolve();active--;
    return JSON.stringify({ids:rows.some(row=>row.id===499)?[499]:[]});
  }};
  const selected=await chooseThematic(input,['SGX'],model,saved,stats,()=>{});
  assert.ok(sizes.length>1);assert.equal(stats.candidate_batches,sizes.length);
  assert.deepEqual(seen.map(row=>row.id),Array.from({length:500},(_,i)=>i));
  assert.deepEqual(selected[0].rows.map(row=>row.section_id),['s499']);
  const calls=sizes.length,again={};
  await chooseThematic(input,['SGX'],model,saved,again,()=>{});
  assert.equal(sizes.length,calls);assert.equal(again.candidate_cache_hit,true);
});

test('an ID belonging to a different batch is rejected and a failed union is not cached',async()=>{
  const saved=cache();let calls=0;
  const model={complete:async messages=>{
    calls++;assert.ok(!JSON.parse(messages[1].content).some(row=>row.id===499));
    return '{"ids":[499]}';
  }};
  await assert.rejects(chooseThematic(groups(),['SGX'],model,saved,{},()=>{}),/Invalid candidate selection/);
  assert.equal(calls,1);assert.equal(saved.saved.size,0);
});

test('empty selection across all batches is rejected after all candidates were presented',async()=>{
  let rows=0;const model={complete:async messages=>{rows+=JSON.parse(messages[1].content).length;return '{"ids":[]}';}};
  await assert.rejects(chooseThematic(groups(),['SGX'],model,null,{},()=>{}),/Invalid candidate selection/);
  assert.equal(rows,500);
});

test('selector material above the existing archive bound fails before any model call',async()=>{
  let calls=0;const model={complete:async()=>{calls++;return '{"ids":[0]}';}};
  await assert.rejects(chooseThematic(groups(2200),['SGX'],model,null,{},()=>{}),/exceed archive limit/);
  assert.equal(calls,0);
});
