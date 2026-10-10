import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ompExecutable } from '../lib/omp.mjs';
import { inspectMac, sessionArgumentPaths, macTree } from '../lib/macos-health.mjs';
import { terminateMacAgent } from '../lib/force-exit.mjs';
const root={pid:1,parent:0,group:1,foreground:2,tty:'ttys001',created:'Thu Oct 8 14:00:00 2026',name:'zsh'};
const agent={...root,pid:2,parent:1,group:2,name:'omp',created:'Thu Oct 8 14:00:01 2026'};
const terminal={handle:'h',ptyId:'pty',incarnationId:'i',connected:true,executionHostId:'local'};
const host={identity:{launchNonce:'host'},sessions:[{terminalHandle:'h',sessionId:'pty',incarnationId:'i',pid:1,isAlive:true}]};
test('macOS resolves installed OMP without an interactive shell PATH',()=>{
 assert.equal(ompExecutable({platform:'darwin',env:{},home:'/Users/test',exists:p=>p==='/Users/test/.local/bin/omp'}),'/Users/test/.local/bin/omp');
 assert.equal(ompExecutable({platform:'darwin',env:{ORCA_OMP_COMMAND:'/custom/omp'},exists:()=>false}),'/custom/omp');
 assert.equal(ompExecutable({platform:'darwin',env:{},home:'/Users/test',exists:p=>p==='/opt/homebrew/bin/omp'}),'/opt/homebrew/bin/omp');
});
test('macOS inspects exact OMP transcript arguments and refuses PID changes',async()=>{
 const options={inventory:async()=>host,processes:async()=>[root,agent],show:async()=>terminal,
 execute:async()=>({stdout:'omp --resume "/Users/test/a b/session.jsonl"'})};
 const live=await inspectMac(terminal,'omp',options);
 assert.equal(live.kind,'agent');assert.deepEqual(live.sessionPaths,['/Users/test/a b/session.jsonl']);
 let scans=0;
 await assert.rejects(inspectMac(terminal,'omp',{...options,processes:async()=>[root,++scans>1?{...agent,created:'Thu Oct 8 14:00:02 2026'}:agent]}),/unverified/);
 assert.deepEqual(sessionArgumentPaths("omp --session='/Users/test/session.jsonl'"),['/Users/test/session.jsonl']);
 assert.deepEqual(sessionArgumentPaths('omp --resume latest'),[]);
});
test('macOS OMP force exit preserves shell and external agents',async()=>{
 const child={...agent,pid:3,parent:2,name:'curl'};let rows=[root,agent,child,{...agent,pid:99,parent:0,tty:'ttys002'}];const killed=[];
 assert.ok(macTree(rows,1,'omp'));
 await terminateMacAgent({terminal,saved:{agent:'omp'},inventory:async()=>host,processes:async()=>rows,
 kill:pid=>{killed.push(pid);rows=rows.filter(row=>row.pid!==pid);}});
 assert.deepEqual(killed,[3,2]);assert.deepEqual(rows.map(row=>row.pid),[1,99]);
});
test('startup selects models before the update prehook resumes roles',()=>{
 const source=fs.readFileSync(new URL('../bin/orca-team.mjs',import.meta.url),'utf8');
 const selection=source.indexOf("await stage('Model selection'");
 const update=source.indexOf("await stage('Agent update prehook', () => updatePrehook(home, names))");
 assert.ok(selection>=0 && update>selection);
});

import os from 'node:os';
import path from 'node:path';
import { verifyMacAbsence } from '../lib/macos-health.mjs';
test('macOS absence checks reject the original OMP conversation in another pane',async t=>{
 const project=fs.mkdtempSync(path.join(os.tmpdir(),'omp-absence-'));
 t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
 const original=path.join(project,'original.jsonl'),other=path.join(project,'other.jsonl');
 for(const [file,id] of [[original,'original'],[other,'different']])fs.writeFileSync(file,JSON.stringify({type:'session',id,cwd:project})+'\n');
 const pane={...terminal,ptyId:`repo::${project}@@live`,tabId:'live',leafId:'leaf',agentIdentity:'pi'};
 const options={project,missing:[{name:'master',saved:{agent:'omp',tabId:'closed',leafId:'closed',session:{id:'original',transcriptPath:original}}}],
 inventory:async()=>({identity:host.identity,sessions:[{...host.sessions[0],sessionId:pane.ptyId}]}),
 cli:async()=>({terminals:[pane],totalCount:1,truncated:false,hostScope:{hostIds:['local'],omittedHostIds:[]}}),
 processes:async()=>[root,agent,{pid:process.pid}],snapshot:async()=>({}),conversationUsers:async()=>{},
 inspect:async()=>({kind:'agent',sessionPaths:[original]})};
 await assert.rejects(verifyMacAbsence(options),/another pane/);
 assert.equal(await verifyMacAbsence({...options,inspect:async()=>({kind:'agent',sessionPaths:[other]})}),true);
 await assert.rejects(verifyMacAbsence({...options,inspect:async()=>({kind:'agent',sessionPaths:[]})}),/unbound/);
});
