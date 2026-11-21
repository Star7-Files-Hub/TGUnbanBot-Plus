// Authenticated observer ingress with actual SQLite; no real Telegram/provider calls.
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const source = fs.readFileSync(new URL('./_worker.js',import.meta.url),'utf8');
const w = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const GROUP='-1001971423490', TOKEN='collector-test-token', OWNER='999';
const sample={chat_id:GROUP,chat_title:'观察目标',message_id:12,user_id:'123456',first_name:'会员',text:'出售实名号四件套长期合作'};
async function harness() {
 w.resetSchemaState();w.invalidateOwners();w.invalidateGroups();w.invalidateAdminCache();w.invalidateObserveGroups();w.invalidateUserWhitelist();
 const db=new DatabaseSync(':memory:'), calls=[], ai=[];
 const env={DB:{prepare(sql){let args=[];return {bind(...a){args=a;return this;},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};},async batch(st){return Promise.all(st.map(s=>s.run()));}}, OWNER_ID:OWNER,GROUP_ID:'-1001',OBSERVE_INGEST_TOKEN:TOKEN,WEBHOOK_SECRET:'other-secret',AI:{async run(model,input){ai.push(model);return model.includes('bge')?{data:[[1,0,0]]}:{response:'ok'};}},__tgMock:{}};
 for(const name of ['sendMessage','banChatMember','restrictChatMember','deleteMessage','getChatMember'])env.__tgMock[name]=async body=>{calls.push({name,body});return {ok:true,result:{message_id:14}};};
 await w.adDetectionReady(env);db.prepare('INSERT INTO ad_observe_groups VALUES (?,?,?,?)').run(GROUP,null,OWNER,1);w.invalidateObserveGroups();
 return {env,db,calls,ai};
}
async function send(h,data=sample,token=TOKEN,method='POST') {
 const res=await w.default.fetch(new Request('https://test.invalid/api/observe/ingest',{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:method==='POST'?JSON.stringify(data):undefined}),h.env,{});
 return {status:res.status,body:await res.json()};
}
test('ingress disabled/unauthorized cannot touch Telegram or DB',async()=>{
 const h=await harness();assert.equal((await send(h,sample,'wrong')).status,401);assert.equal((await send(h,sample,TOKEN,'GET')).status,405);
 delete h.env.OBSERVE_INGEST_TOKEN;assert.equal((await send(h)).status,503);assert.equal(h.calls.length,0);
});
test('ingress only accepts numeric identity, positive message id and allowed group',async()=>{
 const h=await harness();for(const data of [{...sample,chat_id:'-1002'},{...sample,user_id:''},{...sample,message_id:0},{...sample,text:'a'.repeat(4001)}])assert.ok([400,403].includes((await send(h,data)).status));
 assert.equal(h.calls.length,0);
});
test('unmatched candidate sends owner review without any moderation and duplicates are not resent',async()=>{
 const h=await harness();const r=await send(h);assert.equal(r.status,200);assert.equal(r.body.status,'observe');
 assert.deepEqual(h.calls.map(x=>x.name),['sendMessage']);assert.equal(String(h.calls[0].body.chat_id),OWNER);
 assert.equal(h.db.prepare('SELECT count(*) n FROM blacklist').get().n,0);
 assert.equal((await send(h)).body.status,'duplicate');assert.equal(h.calls.length,1);
});
test('known fingerprints skip review; novel normal text calls classifier but never enrolls or punishes',async()=>{
 const h=await harness();h.db.prepare("INSERT INTO ad_fingerprints (type,value,norm_value,status,created_at,updated_at) VALUES ('keyword','实名号四件套','实名号四件套','confirmed',1,1)").run();
 assert.equal((await send(h)).body.status,'pass');assert.equal(h.calls.length,0);
 assert.equal((await send(h,{...sample,message_id:13,text:'今天聊聊日常天气'})).body.status,'pass');assert.equal(h.ai.length,1);assert.equal(h.calls.length,0);
});
test('novel AI advertising produces one review; AI errors stay retryable',async()=>{
 const h=await harness();h.env.AI.run=async()=>({response:'ad'});
 const r=await send(h,{...sample,text:'欢迎参加产品推广活动联系本人'});assert.equal(r.body.status,'observe');assert.equal(h.calls.length,1);
 h.env.AI.run=async()=>({response:'unknown'});
 assert.equal((await send(h,{...sample,message_id:13,text:'今天日常天气如何'})).status,503);
 h.env.AI.run=async()=>({response:'ok'});
 assert.equal((await send(h,{...sample,message_id:13,text:'今天日常天气如何'})).status,200);
});
test('owner notification error is retryable and reuses report instead of enrolling duplicate',async()=>{
 const h=await harness();h.env.__tgMock.sendMessage=async()=>({ok:false});
 assert.equal((await send(h)).status,503);assert.equal(h.db.prepare('SELECT count(*) n FROM ad_observe_reports').get().n,1);
 h.env.__tgMock.sendMessage=async()=>({ok:true});assert.equal((await send(h)).status,200);
 assert.equal(h.db.prepare('SELECT count(*) n FROM ad_observe_reports').get().n,1);
});
test('oversized JSON fails with 413 and no moderation',async()=>{
 const h=await harness();assert.equal((await send(h,{...sample,extra:'a'.repeat(33000)})).status,413);assert.equal(h.calls.length,0);
});
