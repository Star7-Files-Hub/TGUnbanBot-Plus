// Beta/observation-pool bridge: real SQLite transactions, mocked Telegram/fetch, no secrets/network.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const TOKEN = 'pool-test-not-real', GROUP = '-1001', OBSERVE = '-1009', OWNER = '999';
const sha = value => createHash('sha256').update(value).digest('hex');
function reset() {
  worker.resetSchemaState(); worker.invalidateOwners(); worker.invalidateGroups(); worker.invalidateObserveGroups(); worker.invalidateUserWhitelist(); worker.invalidateAdminCache();
}
function harness() {
  reset();
  const sqlite = new DatabaseSync(':memory:'), calls = [], sqls = [], state = { failSample: false, failBlacklist: false, failPhase: false };
  let batchDepth = 0;
  const env = { OWNER_ID: OWNER, GROUP_ID: GROUP, POOL_CONTROL_TOKEN: TOKEN, WEBHOOK_SECRET: 'webhook-only-secret',
    DB: {
      prepare(sql) {
        sqls.push(sql); let values = [];
        const result = () => { const r = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; };
        return {
          bind(...params) { values = params; return this; },
          async first() { return sqlite.prepare(sql).get(...values) || null; },
          async all() { return { success: true, results: sqlite.prepare(sql).all(...values) }; },
          _runSync() {
            if (state.failSample && /^INSERT INTO ad_samples/.test(sql)) throw new Error('private-sample-error');
            if (state.failBlacklist && /INSERT OR REPLACE INTO blacklist/.test(sql)) throw new Error('private-enforcement-error');
            if (state.failPhase && /status='sample_done'.*sample.sampleId/s.test(sql)) throw new Error('private-phase-error');
            if (/^SELECT\b/i.test(sql)) return { success: true, results: sqlite.prepare(sql).all(...values) };
            return result();
          },
          async run() { return this._runSync(); },
        };
      },
      async batch(statements) {
        if (batchDepth) throw new Error('nested batch');
        batchDepth++; sqlite.exec('BEGIN IMMEDIATE');
        try { const results = statements.map(stmt => stmt._runSync()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
        finally { batchDepth--; }
      },
    },
    __tgMock: Object.fromEntries(['sendMessage','editMessageText','answerCallbackQuery','banChatMember','restrictChatMember','deleteMessage','getChatMember','unbanChatMember'].map(name => [name, async body => {
      calls.push({ name, body }); return { ok: true, result: name === 'sendMessage' ? { message_id: 20 } : name === 'getChatMember' ? { status: 'member' } : true };
    }])),
  };
  return { env, sqlite, calls, sqls, state };
}
async function request(h, path, { body, method = body === undefined ? 'GET' : 'POST', token = TOKEN } = {}) {
  const response = await worker.default.fetch(new Request('https://beta.invalid'+path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+token }, body: method === 'GET' ? undefined : JSON.stringify(body) }), h.env, {});
  return { response, status: response.status, body: await response.json() };
}
async function init(h) { await worker.adDetectionReady(h.env); }
function action(id = 'a'.repeat(24), kind = 'text', text = '高价收购实名号四件套长期招代理') { return { id, user_id: '555', sample: { text, kind } }; }
function seedSample(h, id, text, kind = 'text', embedding = null) {
  h.sqlite.prepare('INSERT INTO ad_samples(id,norm_hash,sample_text,kind,embedding,count,source,created_at,updated_at) VALUES (?,?,?,?,?,1,?,1,1)')
    .run(id, sha(worker.normalizeAdText(text)), text, kind, embedding === null ? null : JSON.stringify(embedding), 'manual');
}
const rowCount = (h, table) => h.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get().n;

test('control APIs authenticate before DB/schema and webhook authentication is separate', async () => {
  const h = harness();
  for (const path of ['/api/pool/dictionary','/api/pool/action','/api/pool/hits','/api/pool/legacy-report']) {
    const body = path.endsWith('dictionary') ? undefined : {};
    assert.equal((await request(h,path,{body,token:'wrong'})).status,401);
    delete h.env.POOL_CONTROL_TOKEN;
    assert.equal((await request(h,path,{body})).status,503);
    h.env.POOL_CONTROL_TOKEN=TOKEN;
  }
  assert.equal(h.sqls.length,0); assert.equal(h.calls.length,0);
  const res=await worker.default.fetch(new Request('https://beta.invalid/',{method:'POST',body:'{}'}),h.env,{});
  assert.equal(res.status,401);
});
test('legacy report endpoint validates before reads and returns a bounded read-only projection', async () => {
  const h=harness();
  for (const report_id of [0,-1,1.5,'1',null,Number.MAX_SAFE_INTEGER+1]) {
    assert.equal((await request(h,'/api/pool/legacy-report',{body:{report_id}})).status,400);
  }
  assert.equal((await request(h,'/api/pool/legacy-report',{body:{report_id:1,extra:true}})).status,400);
  assert.equal(h.sqls.length,0); assert.equal(h.calls.length,0);
  await init(h);
  h.sqlite.prepare("INSERT INTO ad_observe_reports (id,user_id,chat_id,body_text,name,reason,status,created_at) VALUES (1,'555','-1009',?,'PRIVATE-NAME','PRIVATE-REASON','open',1)").run('广告样本'.repeat(600));
  h.sqls.length=0;
  const found=await request(h,'/api/pool/legacy-report',{body:{report_id:1}});
  assert.equal(found.status,200);
  assert.deepEqual(Object.keys(found.body.report).sort(),['body_text','status','user_id']);
  assert.equal(found.body.report.user_id,'555'); assert.equal(found.body.report.status,'open');
  assert.equal(found.body.report.body_text.length,2000);
  assert.equal(h.sqls.length,1); assert.match(h.sqls[0],/^SELECT user_id, body_text, status/);
  assert.equal(h.calls.length,0); assert.equal(rowCount(h,'blacklist'),0); assert.equal(rowCount(h,'ad_samples'),0);
  assert.equal(h.sqlite.prepare('SELECT status FROM ad_observe_reports').get().status,'open');
  const missing=await request(h,'/api/pool/legacy-report',{body:{report_id:2}});
  assert.deepEqual(missing.body,{ok:true,report:null});
});

test('legacy report unavailable database never triggers schema creation or mutations', async () => {
  const h=harness();delete h.env.DB;
  const r=await request(h,'/api/pool/legacy-report',{body:{report_id:1}});
  assert.equal(r.status,503);assert.equal(r.body.error,'legacy_report_unavailable');
  assert.equal(h.sqls.length,0);assert.equal(h.calls.length,0);
});

test('dictionary explicitly projects stable public match data, valid vectors and count zero', async () => {
  const h=harness(); await init(h);
  h.sqlite.prepare("INSERT INTO ad_fingerprints(id,type,value,norm_value,status,source,confirmed_by) VALUES (1,'keyword','群发推广','群发推广','confirmed','manual','PRIVATE-OPERATOR')").run();
  seedSample(h,1,'广告样本一','text',[1,0,0]); seedSample(h,2,'广告样本二','quote',[[1,0,0]]); seedSample(h,3,'广告样本三','card_name',[0,0]);
  h.sqlite.prepare("INSERT INTO ad_user_whitelist VALUES ('111','PRIVATE-NOTE','PRIVATE-OPERATOR',1)").run();
  h.sqlite.prepare("INSERT INTO ad_owners(user_id,created_at) VALUES ('222',1)").run();
  h.sqlite.prepare("INSERT INTO ad_allowlist VALUES ('text','正常话题',0,1)").run();
  h.sqlite.prepare("INSERT INTO ad_observe_groups VALUES ('-1009',NULL,'PRIVATE-OPERATOR',1)").run();
  h.sqlite.prepare("INSERT INTO blacklist VALUES ('333','PRIVATE-REASON','PRIVATE-NOTE','PRIVATE-OPERATOR',1)").run();
  const r=await request(h,'/api/pool/dictionary'); assert.equal(r.status,200);
  assert.deepEqual(r.body.data.fingerprints[0],{id:1,type:'keyword',value:'群发推广',norm_value:'群发推广',status:'confirmed',source:'manual'});
  assert.deepEqual(r.body.data.samples.map(x=>x.embedding),[[1,0,0],null,null]); assert.ok(r.body.data.samples.every(x=>x.count===0));
  assert.deepEqual(r.body.data.whitelist,['111']); assert.deepEqual(r.body.data.owners,['222',OWNER]); assert.deepEqual(r.body.observe_groups,[OBSERVE]);
  assert.ok(!JSON.stringify(r.body).includes('PRIVATE-')); assert.ok(!h.sqls.some(sql=>/SELECT \*/.test(sql)));
});
test('dictionary refuses entity and serialized size caps instead of silently truncating', async () => {
  const h=harness(); await init(h);
  const insert=h.sqlite.prepare("INSERT INTO ad_fingerprints(type,value,norm_value,status,created_at,updated_at) VALUES ('keyword',?,?,'confirmed',1,1)");
  h.sqlite.exec('BEGIN'); for(let i=0;i<5001;i++) insert.run('x'+i,'x'+i); h.sqlite.exec('COMMIT');
  const capped=await request(h,'/api/pool/dictionary'); assert.equal(capped.status,413); assert.equal(capped.body.error,'dictionary_capacity_exceeded');
  const h2=harness(); await init(h2);
  h2.sqlite.prepare("INSERT INTO ad_allowlist VALUES ('text',?,0,1)").run('a'.repeat(1_700_001));
  const sized=await request(h2,'/api/pool/dictionary'); assert.equal(sized.status,413); assert.equal(sized.body.error,'dictionary_too_large');
});
test('action saves once, bans configured groups only, returns cached result and sends no notification', async () => {
  const h=harness(); const input=action();
  const first=await request(h,'/api/pool/action',{body:input}); assert.equal(first.status,200); assert.equal(first.body.ok,true); assert.match(first.body.summary,/成功 1，失败 0.*已保存/);
  const again=await request(h,'/api/pool/action',{body:input}); assert.equal(again.status,200); assert.deepEqual(again.body,first.body);
  assert.equal(rowCount(h,'ad_samples'),1); assert.equal(h.sqlite.prepare('SELECT count FROM ad_samples').get().count,1);
  assert.equal(rowCount(h,'blacklist'),1); assert.deepEqual(h.calls.map(c=>c.name),['banChatMember']); assert.equal(h.calls[0].body.chat_id,GROUP);
  assert.equal((await request(h,'/api/pool/action',{body:{...input,user_id:'556'}})).status,409);
});
test('concurrent action retries claim a single sample phase and single enforcement', async () => {
  const h=harness(); await init(h);
  const r=await Promise.all([request(h,'/api/pool/action',{body:action()}),request(h,'/api/pool/action',{body:action()})]);
  assert.deepEqual(r.map(x=>x.status).sort(),[200,409]); assert.equal(h.sqlite.prepare('SELECT count FROM ad_samples').get().count,1); assert.equal(h.calls.filter(x=>x.name==='banChatMember').length,1);
});
test('sample failure and empty sample never prevent explicit enforcement or falsely claim a saved sample', async () => {
  for (const fail of [true,false]) {
    const h=harness(); await init(h); h.state.failSample=fail;
    const r=await request(h,'/api/pool/action',{body:action('b'.repeat(24),'text',fail?'广告样本长句':'')});
    assert.equal(r.status,200); assert.match(r.body.summary,fail?/保存失败/:/未保存样本/); assert.equal(rowCount(h,'ad_samples'),0); assert.equal(rowCount(h,'blacklist'),1);
  }
});
test('enforcement retry resumes sample_done without double counting and stale processing leases recover', async () => {
  const h=harness(); await init(h); h.state.failBlacklist=true;
  assert.equal((await request(h,'/api/pool/action',{body:action()})).status,503); assert.equal(h.sqlite.prepare('SELECT count FROM ad_samples').get().count,1);
  h.state.failBlacklist=false; assert.equal((await request(h,'/api/pool/action',{body:action()})).status,200); assert.equal(h.sqlite.prepare('SELECT count FROM ad_samples').get().count,1);
  const input=action('c'.repeat(24));
  const digest=sha(JSON.stringify({user_id:input.user_id,sample:input.sample}));
  h.sqlite.prepare('INSERT INTO pool_action_receipts VALUES (?,?,?,?)').run(input.id,'processing',JSON.stringify({input_hash:digest,lease:'stale',sample:null}),Math.floor(Date.now()/1000)-31);
  assert.equal((await request(h,'/api/pool/action',{body:input})).status,200);
  assert.equal(h.sqlite.prepare('SELECT count FROM ad_samples').get().count,2);
});
test('phase receipt and sample mutation commit atomically when a transaction errors', async () => {
  const h=harness(); await init(h); h.state.failPhase=true;
  const r=await request(h,'/api/pool/action',{body:action()}); assert.equal(r.status,200); assert.match(r.body.summary,/样本保存失败/);
  assert.equal(rowCount(h,'ad_samples'),0); assert.equal(rowCount(h,'blacklist'),1);
});
test('lost sample transaction response restores persisted sample_done before enforcement', async () => {
  const h=harness();await init(h);const original=h.env.DB.batch;let lost=true;
  h.env.DB.batch=async statements=>{const r=await original(statements);if(lost && statements.length===2){lost=false;throw new Error('response lost after sample commit');}return r;};
  const r=await request(h,'/api/pool/action',{body:action()});assert.equal(r.status,200);assert.match(r.body.summary,/已保存语义样本/);
  assert.equal(h.sqlite.prepare('SELECT count FROM ad_samples').get().count,1);assert.equal(rowCount(h,'blacklist'),1);
});

test('pool samples retain kinds and do not merge identical text across source kinds', async () => {
  const h=harness(); await init(h);
  for (const [i,kind] of ['text','quote','card_name'].entries()) assert.equal((await request(h,'/api/pool/action',{body:action(String(i+1).repeat(24),kind,'独立广告样本文本')})).status,200);
  assert.deepEqual(h.sqlite.prepare('SELECT kind,count FROM ad_samples ORDER BY id').all().map(x=>({...x})),[{kind:'text',count:1},{kind:'quote',count:1},{kind:'card_name',count:1}]);
  const dictionary=await request(h,'/api/pool/dictionary'); assert.ok(dictionary.body.data.samples.every(x=>x.norm_hash===sha(worker.normalizeAdText('独立广告样本文本'))));
});
test('legacy canonical hash owned by another kind cannot pollute a new pool text sample', async () => {
  const h=harness(); await init(h); seedSample(h,1,'相同广告样本文本','quote');
  const r=await request(h,'/api/pool/action',{body:action('f'.repeat(24),'text','相同广告样本文本')}); assert.equal(r.status,200);
  assert.deepEqual(h.sqlite.prepare('SELECT kind,count FROM ad_samples ORDER BY id').all().map(row=>({...row})),[{kind:'quote',count:1},{kind:'text',count:1}]);
});
test('duplicate-hit batch remains retry-safe even if caller reports an upstream transaction response failure', async () => {
  const h=harness(); await init(h); seedSample(h,1,'独立样本文本');
  const original=h.env.DB.batch; let lost=true;
  // Simulate a post-commit response loss explicitly via wrapped batch on hit statements.
  h.env.DB.batch=async statements=>{const result=await original(statements);if(lost && statements.length===2){lost=false;throw new Error('lost response');}return result;};
  const body={id:'a'.repeat(32),hits:[{sample_id:1,count:2}]};
  assert.equal((await request(h,'/api/pool/hits',{body})).status,503);
  assert.equal((await request(h,'/api/pool/hits',{body})).body.duplicate,true);
  assert.equal(h.sqlite.prepare('SELECT count FROM ad_samples').get().count,3);
});
test('hit batch transaction failure rolls back both receipt and increments', async () => {
  const h=harness(); await init(h);seedSample(h,1,'独立样本文本');
  const original=h.env.DB.prepare;
  h.env.DB.prepare=sql=>{const stmt=original(sql);if(sql.startsWith('UPDATE ad_samples SET count=COALESCE(count,0)+?'))stmt._runSync=()=>{throw new Error('write failed');};return stmt;};
  const body={id:'b'.repeat(32),hits:[{sample_id:1,count:2}]};
  assert.equal((await request(h,'/api/pool/hits',{body})).status,503);assert.equal(rowCount(h,'pool_hit_batches'),0);assert.equal(h.sqlite.prepare('SELECT count FROM ad_samples').get().count,1);
  h.env.DB.prepare=original;assert.equal((await request(h,'/api/pool/hits',{body})).status,200);assert.equal(h.sqlite.prepare('SELECT count FROM ad_samples').get().count,3);
});

test('current owner and whitelist exemptions outrank stale controller approval', async () => {
  const h=harness(); await init(h);
  h.sqlite.prepare("INSERT INTO ad_user_whitelist VALUES ('111',NULL,'test',1)").run(); h.sqlite.prepare("INSERT INTO ad_owners(user_id,created_at) VALUES ('222',1)").run();
  for(const [i,user_id] of [OWNER,'111','222'].entries()) {
    const r=await request(h,'/api/pool/action',{body:{...action(String(i+1).repeat(24)),user_id}}); assert.equal(r.status,200); assert.match(r.body.summary,/未保存样本或处罚/);
  }
  assert.equal(rowCount(h,'ad_samples'),0);assert.equal(rowCount(h,'blacklist'),0);assert.equal(h.calls.length,0);
});
test('hit batches are atomic, deduplicated across concurrent requests, and reject changed reuse', async () => {
  const h=harness(); await init(h); seedSample(h,1,'普通样本一'); seedSample(h,2,'普通样本二');
  const body={id:'d'.repeat(32),hits:[{sample_id:1,count:5},{sample_id:2,count:7}]};
  const res=await Promise.all([request(h,'/api/pool/hits',{body}),request(h,'/api/pool/hits',{body})]); assert.ok(res.every(x=>x.status===200));
  assert.equal(res.filter(x=>x.body.duplicate).length,1);assert.deepEqual(h.sqlite.prepare('SELECT count FROM ad_samples ORDER BY id').all().map(x=>x.count),[6,8]);
  assert.equal(rowCount(h,'pool_hit_batches'),1); assert.equal((await request(h,'/api/pool/hits',{body:{...body,hits:[{sample_id:1,count:9}]}})).status,409);
  assert.deepEqual(h.sqlite.prepare('SELECT count FROM ad_samples ORDER BY id').all().map(x=>x.count),[6,8]);
});
test('hit batches keep semantic counts and promote eligible compact phrases exactly once', async () => {
  const h=harness();await init(h);seedSample(h,1,'高价收购实名号四件套长期招代理');
  const body={id:'c'.repeat(32),hits:[{sample_id:1,count:2}]};
  assert.equal((await request(h,'/api/pool/hits',{body})).status,200);
  const fingerprint=h.sqlite.prepare('SELECT value,status FROM ad_fingerprints').get();assert.ok(fingerprint);assert.equal(fingerprint.status,'confirmed');assert.ok(Array.from(fingerprint.value).length<=18);
  assert.equal((await request(h,'/api/pool/hits',{body})).body.duplicate,true);assert.equal(rowCount(h,'ad_fingerprints'),1);assert.equal(h.sqlite.prepare('SELECT count FROM ad_samples').get().count,3);
});
test('invalid pool action/hit payloads fail before any DB access', async () => {
  const h=harness();
  for(const body of [{...action(),id:'nope'},{...action(),sample:{text:'x'.repeat(2001),kind:'text'}},{...action(),sample:{text:'valid',kind:'name'}},{id:'e'.repeat(32),hits:Array.from({length:51},(_,i)=>({sample_id:i+1,count:1}))},{id:'e'.repeat(32),hits:[{sample_id:1,count:0}]}]) {
    const path=Object.hasOwn(body,'hits')?'/api/pool/hits':'/api/pool/action';assert.equal((await request(h,path,{body})).status,400);
  }
  assert.equal(h.sqls.length,0);assert.equal(h.calls.length,0);
});
async function fakeFetch(body, env, assertion) {
  const previous=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{await assertion(url,options);return Response.json(body);};
  try { await env(); } finally { globalThis.fetch=previous; }
}
const callback={id:'callback-1',data:'op:save:'+'a'.repeat(24),from:{id:OWNER,first_name:'unused'},message:{message_id:23,text:'SECRET-MESSAGE',chat:{id:OWNER,type:'private',title:'PRIVATE TITLE'}}};
test('op callbacks forward sanitized payload before schema, even when all Beta DB reads would fail', async () => {
  const h=harness(); h.env.POOL_CONTROL_URL='https://pool.invalid'; h.env.DB={prepare(){throw new Error('DB must not be accessed');}};
  await fakeFetch({ok:true},()=>worker.handleUpdate(h.env,{callback_query:callback},{}),(url,options)=>{
    assert.equal(url,'https://pool.invalid/api/beta/review');assert.equal(options.headers.Authorization,'Bearer '+TOKEN);assert.equal(options.redirect,'manual');
    const payload=JSON.parse(options.body);assert.equal(payload.callback.data,callback.data);assert.deepEqual(payload.callback.from,{id:OWNER});assert.equal(payload.callback.message.text,undefined);
    assert.ok(!options.body.includes('SECRET-MESSAGE')&&!options.body.includes('PRIVATE TITLE'));
  });assert.equal(h.calls.length,0);
});
for (const data of ['o:save:1','o:dismiss:1']) {
  test('configured legacy callback forwards sanitized data before any Beta DB access: '+data, async () => {
    const h=harness();h.env.POOL_CONTROL_URL='https://pool.invalid';h.env.DB={prepare(){throw new Error('DB must not be accessed');}};
    await fakeFetch({ok:true},()=>worker.handleUpdate(h.env,{callback_query:{...callback,data}},{}),(url,options)=>{
      assert.equal(url,'https://pool.invalid/api/beta/legacy-review');
      assert.equal(options.headers.Authorization,'Bearer '+TOKEN);assert.equal(options.redirect,'manual');
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body),{callback:{id:callback.id,data,from:{id:OWNER},message:{message_id:23,chat:{id:OWNER,type:'private'}}}});
      assert.ok(!options.body.includes('SECRET-MESSAGE')&&!options.body.includes('PRIVATE TITLE'));
    });
    assert.equal(h.sqls.length,0);assert.equal(h.calls.length,0);
  });
}

test('legacy pool forwarding failure never falls back to local save or enforcement', async () => {
  const h=harness();h.env.POOL_CONTROL_URL='https://pool.invalid';
  await fakeFetch({ok:false},()=>worker.handleUpdate(h.env,{callback_query:{...callback,data:'o:save:1'}},{}),()=>{});
  assert.equal(h.sqls.length,0);assert.deepEqual(h.calls.map(x=>x.name),['answerCallbackQuery']);
  assert.equal(h.calls[0].body.text,'观察池暂不可用，请重试');
});

test('manual-redirect pool request rejects a 302 without following it or touching local DB', async () => {
  const h=harness();h.env.POOL_CONTROL_URL='https://pool.invalid';let requests=0;
  const previous=globalThis.fetch;globalThis.fetch=async (url,options)=>{
    requests++;assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://untrusted.invalid/'}});
  };
  try { await worker.handleUpdate(h.env,{callback_query:{...callback,data:'o:save:1'}},{}); }
  finally { globalThis.fetch=previous; }
  assert.equal(requests,1);assert.equal(h.sqls.length,0);assert.deepEqual(h.calls.map(x=>x.name),['answerCallbackQuery']);
});

test('op forwarding failure answers callback without raw errors, group replies or local report writes', async () => {
  const h=harness(); h.env.POOL_CONTROL_URL='https://pool.invalid';
  await fakeFetch({ok:false},()=>worker.handleUpdate(h.env,{callback_query:callback},{}),()=>{});
  assert.equal(h.sqls.length,0);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'answerCallbackQuery');assert.equal(h.calls[0].body.text,'观察池暂不可用，请重试');
});
test('configured observe groups forward text, contact, quote and reply spam with no local report/schema writes', async () => {
  const h=harness(); await init(h);h.sqlite.prepare('INSERT INTO ad_observe_groups VALUES (?,?,?,1)').run(OBSERVE,null,OWNER);worker.invalidateObserveGroups();assert.equal(await worker.isObserveGroup(h.env,OBSERVE),true);
  h.env.POOL_CONTROL_URL='https://pool.invalid';h.sqls.length=0;
  const message={message_id:5,chat:{id:OBSERVE,type:'supergroup',title:'观察群'},from:{id:'555',first_name:'成员'},text:'/spam',reply_to_message:{message_id:4,from:{id:'444',first_name:'目标'},text:'广告样本',contact:{first_name:'名片广告'},quote:{text:'引用广告'}}};
  await fakeFetch({ok:true},()=>worker.handleUpdate(h.env,{message},{}),(url,options)=>{assert.equal(url,'https://pool.invalid/api/beta/ingest');const data=JSON.parse(options.body);assert.equal(data.text,'/spam');assert.equal(data.reply.user_id,'444');assert.equal(data.reply.contact_name,'名片广告');assert.equal(data.reply.quote,'引用广告');});
  assert.equal(h.sqls.length,0);assert.equal(h.calls.length,0);assert.equal(rowCount(h,'ad_observe_reports'),0);
});
test('observed multi-ID spam preserves its full arguments and pool pause stays silent', async () => {
  const h=harness();await init(h);h.sqlite.prepare('INSERT INTO ad_observe_groups VALUES (?,?,?,1)').run(OBSERVE,null,OWNER);worker.invalidateObserveGroups();await worker.isObserveGroup(h.env,OBSERVE);h.env.POOL_CONTROL_URL='https://pool.invalid';
  const previous=globalThis.fetch;globalThis.fetch=async(url,options)=>{assert.equal(JSON.parse(options.body).text,'/spam 555,666');return Response.json({ok:false,paused:true},{status:503});};
  try{await worker.handleUpdate(h.env,{message:{message_id:5,chat:{id:OBSERVE,type:'supergroup'},from:{id:'333'},text:'/spam 555,666'}},{});}finally{globalThis.fetch=previous;}
  assert.equal(h.calls.length,0);assert.equal(rowCount(h,'ad_observe_reports'),0);
});
test('unconfigured legacy callback still handles local dismissal', async () => {
  const h=harness();await init(h);
  h.sqlite.prepare("INSERT INTO ad_observe_reports (id,user_id,chat_id,body_text,status,created_at) VALUES (1,'555','-1009','广告样本','open',1)").run();
  await worker.handleUpdate(h.env,{callback_query:{...callback,data:'o:dismiss:1'}},{});
  assert.equal(h.sqlite.prepare('SELECT status FROM ad_observe_reports').get().status,'dismissed');
  assert.equal(rowCount(h,'ad_samples'),0);assert.equal(rowCount(h,'blacklist'),0);
});

for (const protectedUser of ['555',OWNER,'222']) {
  test('local old save callback checks live whitelist/owners before saving or banning: '+protectedUser, async () => {
    const h=harness();await init(h);
    h.sqlite.prepare("INSERT INTO ad_observe_reports (id,user_id,chat_id,body_text,status,created_at) VALUES (1,?,'-1009','广告样本','open',1)").run(protectedUser);
    // Warm the old whitelist/owner caches before changing live DB rows.
    await worker.isUserWhitelisted(h.env,protectedUser);await worker.loadConfig(h.env);
    if(protectedUser==='555')h.sqlite.prepare("INSERT INTO ad_user_whitelist VALUES ('555',NULL,'test',1)").run();
    if(protectedUser==='222')h.sqlite.prepare("INSERT INTO ad_owners(user_id,created_at) VALUES ('222',1)").run();
    await worker.handleUpdate(h.env,{callback_query:{...callback,data:'o:save:1'}},{});
    assert.equal(rowCount(h,'ad_samples'),0);assert.equal(rowCount(h,'blacklist'),0);
    assert.equal(h.sqlite.prepare('SELECT status FROM ad_observe_reports').get().status,'open');
    assert.deepEqual(h.calls.map(x=>x.name),['answerCallbackQuery']);assert.match(h.calls[0].body.text,/未保存样本或处罚/);
  });
}

test('old o callback is forwarded when pool is configured while ordinary moderation stays local', async () => {
  const h=harness();await init(h);h.env.POOL_CONTROL_URL='https://pool.invalid';
  h.sqlite.prepare("INSERT INTO ad_observe_reports (id,user_id,chat_id,body_text,status,created_at) VALUES (1,'555','-1009','广告样本','open',1)").run();
  await fakeFetch({ok:true},()=>worker.handleUpdate(h.env,{callback_query:{...callback,data:'o:dismiss:1'}},{}),(url,options)=>{
    assert.equal(url,'https://pool.invalid/api/beta/legacy-review');assert.equal(options.redirect,'manual');
    assert.equal(JSON.parse(options.body).callback.data,'o:dismiss:1');
  });
  assert.equal(h.sqlite.prepare('SELECT status FROM ad_observe_reports').get().status,'open');
  h.calls.length=0;await worker.handleUpdate(h.env,{message:{message_id:1,chat:{id:GROUP,type:'supergroup'},from:{id:'555',first_name:'会员'},text:'出售实名号四件套长期招代理'}},{});
  assert.ok(h.calls.some(x=>x.name==='restrictChatMember'));
});
