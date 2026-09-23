import test from 'node:test';
import assert from 'node:assert/strict';
import { macTree, inspectMac } from '../lib/macos-health.mjs';
const root = { pid: 1, parent: 0, group: 1, foreground: 2, tty: 'ttys001', created: 'Mon Sep 21 16:34:38 2026', name: 'login' };
const agent = { ...root, pid: 2, parent: 1, group: 2, name: 'pi' };
test('macOS requires one foreground provider in the same PTY descendant tree', () => {
 assert.ok(macTree([root,agent],1,'pi'));
 for (const replacement of [{...agent,tty:'ttys002'},{...agent,group:3},{...agent,name:'node'},{...agent,parent:99}]) assert.equal(macTree([root,replacement],1,'pi'),null);
 assert.equal(macTree([root,agent,{...agent,pid:3}],1,'pi'),null);
});
test('macOS rejects changed pane incarnation across native inspection', async () => {
 const terminal={handle:'t',ptyId:'p',incarnationId:'i',connected:true};
 const inventory=async()=>({identity:{launchNonce:'n'},sessions:[{terminalHandle:'t',sessionId:'p',incarnationId:'i',isAlive:true,pid:1}]});
 await assert.rejects(inspectMac(terminal,'pi',{inventory,processes:async()=>[root,agent],show:async()=>({...terminal,incarnationId:'changed'})}),/unverified/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyMacAbsence } from '../lib/macos-health.mjs';
test('macOS full-team close restores only after complete stable absence proof', async t => {
 const project=fs.mkdtempSync(path.join(os.tmpdir(),'orca-absence-'));
 t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
 const transcriptPath=path.join(project,'original.jsonl');
 fs.writeFileSync(transcriptPath,JSON.stringify({type:'session',id:'original',cwd:project})+'\n');
 const missing=[{name:'master',saved:{agent:'pi',session:{id:'original',transcriptPath}}}];
 const options={project,missing,inventory:async()=>({identity:{launchNonce:'stable'},sessions:[]}),cli:async()=>({terminals:[],totalCount:0,truncated:false,hostScope:{hostIds:['local'],omittedHostIds:[]}}),processes:async()=>[{pid:process.pid}],conversationUsers:async()=>{}};
 assert.equal(await verifyMacAbsence(options),true);
 await assert.rejects(verifyMacAbsence({...options,conversationUsers:async()=>{throw Error('still open');}}),/still open/);
 await assert.rejects(verifyMacAbsence({...options,inventory:async()=>({identity:{launchNonce:'stable'},sessions:[{sessionId:`repo::${project}@@a`,isAlive:true}]})}),/live terminals/);
 await assert.rejects(verifyMacAbsence({...options,cli:async()=>({terminals:[],totalCount:0,truncated:true,hostScope:{hostIds:['local'],omittedHostIds:[]}})}),/Incomplete/);
 let n=0;
 await assert.rejects(verifyMacAbsence({...options,inventory:async()=>({identity:{launchNonce:String(n++)},sessions:[]})}),/host changed/);
});
test('macOS verifies a foreground idle shell but refuses unknown shell descendants', () => {
 const shell={...agent,name:'zsh'};
 assert.ok(macTree([root,shell],1,'pi'));
 assert.equal(macTree([root,shell,{...agent,pid:3,parent:2,name:'curl'}],1,'pi'),null);
});
