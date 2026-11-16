import test from "node:test";
import assert from "node:assert/strict";
import {validateRequest, handleIssue} from "./issue-video-dispatch.mjs";
const now = new Date("2026-11-16T00:00:00Z");
const request = {request_id:"dot-20261116-proof-01",target_date:"2026-11-15",lookback_days:14,start_date:"",dry_run:true};
function event(overrides={}) {
 return {action:"edited",changes:{body:{from:"old"}},repository:{full_name:"Yobinori/yobinori.github.io"},
 issue:{number:14,state:"open",user:{id:32870956},body:JSON.stringify(request)},sender:{id:32870956,login:"Yobinori"},...overrides};
}
const env={GH_TOKEN:"test",GITHUB_REPOSITORY:"Yobinori/yobinori.github.io",GITHUB_RUN_ID:"123"};
test("accepts the authorized fixed issue and strict 14 day payload",()=>{
 assert.deepEqual(validateRequest(event(),now),request);
});
test("rejects other issue, sender, repository and title-only edits",()=>{
 for(const e of [event({sender:{id:1,login:"Yobinori"}}),event({repository:{full_name:"other/repo"}}),
 event({issue:{...event().issue,number:15}}),event({changes:{title:{from:"old"}}}),event({action:"opened"})]) {
  assert.throws(()=>validateRequest(e,now));
 }
});
test("rejects shell text, extra fields, invalid dates, future dates and wrong types",()=>{
 for(const changes of [{request_id:"$(echo unsafe)"},{request_id:"abcd1234\nBAD=value"},{target_date:"2026-02-30"},
 {target_date:"2026-11-16"},{dry_run:"false"},{lookback_days:1},{start_date:"2026-01-01"},{command:"echo unsafe"}]) {
  assert.throws(()=>validateRequest(event({issue:{...event().issue,body:JSON.stringify({...request,...changes})}}),now));
 }
});
test("claims before execution and leaves a public result",async()=>{
 const calls=[];let ran=0;
 const api=async(path,options)=>{calls.push({path,options});return options?{}:[];};
 const result=await handleIssue(event(),env,{now,api,runner:async received=>{
  ran++;assert.equal(calls.length,2);assert.equal(received.TARGET_DATE,"2026-11-15");assert.equal(received.DRY_RUN,"true");
  return {range:{start:"start",end:"end"},dryRun:true,detected:1,unresolved:[],created:[],duplicateSkipped:1};
 }});
 assert.equal(ran,1);assert.equal(result.status,"success");assert.equal(calls.length,3);
});
test("a claimed request is skipped even when the previous run failed",async()=>{
 let ran=false;
 const result=await handleIssue(event(),env,{now,api:async()=>[{user:{login:"github-actions[bot]",type:"Bot"},
 body:"<!-- youtube-dispatch-claim:"+request.request_id+" -->\nStatus: claimed"}],runner:async()=>{ran=true}});
 assert.equal(result.status,"duplicate_skipped");assert.equal(ran,false);
});
test("human-authored marker cannot suppress execution",async()=>{
 let ran=false;
 await handleIssue(event(),env,{now,api:async(path,options)=>options?{}:[{user:{login:"Yobinori",type:"User"},
 body:"<!-- youtube-dispatch-claim:"+request.request_id+" -->\n"}],runner:async()=>{
 ran=true;return {range:{},dryRun:true,detected:0,unresolved:[],created:[],duplicateSkipped:0};
 }});
 assert.equal(ran,true);
});
test("claim-write failure never proceeds to execution",async()=>{
 let ran=false;
 await assert.rejects(()=>handleIssue(event(),env,{now,api:async(path,options)=>{
 if(options)throw Error("uncertain write");return [];},runner:async()=>{ran=true}}));
 assert.equal(ran,false);
});
