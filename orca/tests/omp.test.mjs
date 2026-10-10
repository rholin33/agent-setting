import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchArguments, validateTranscript } from '../lib/sessions.mjs';
import { classifyWindows } from '../lib/windows-health.mjs';
import { updateAgentsBeforeStart } from '../lib/agent-update.mjs';
test('OMP launch uses native executable, exact session and role skill overlay', t => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'omp-test-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const skills=path.join(home,'source','archi','skills');fs.mkdirSync(skills,{recursive:true});
 const transcriptPath=path.join(home,'session.jsonl');fs.writeFileSync(transcriptPath,JSON.stringify({type:'session',id:'original',cwd:home})+'\n');
 const role={agent:'omp',model:'pay/gpt-6-astra',thinking:'xhigh',role:'agentroles.archi'};
 const session={id:'original',transcriptPath};validateTranscript({...role,session},home);
 const launch=launchArguments(role,'prompt.md',session,home,home);
 assert.match(launch.executable,/omp(?:\.exe)?$/);
 assert.equal(launch.args[launch.args.indexOf('--session')+1],transcriptPath);
 assert.equal(launch.args.includes('--skill'),false);
 const overlay=launch.args[launch.args.indexOf('--config')+1];
 assert.deepEqual(JSON.parse(fs.readFileSync(overlay)).skills.customDirectories,[skills]);
});
test('native OMP is recognized separately from Pi and unknown children',()=>{
 const root={ProcessId:1,ParentProcessId:0,Name:'pwsh.exe',Created:'100',SessionId:1};
 const child={...root,ProcessId:2,ParentProcessId:1,Name:'omp.exe',Created:'110'};
 assert.equal(classifyWindows([root,child],{pid:1},'omp'),'agent');
 assert.equal(classifyWindows([root,child],{pid:1},'pi'),'unverifiable');
});
test('OMP prehook stops managed roles, updates binary/plugins, then resumes',async()=>{
 const calls=[];
 await updateAgentsBeforeStart({agents:['omp'],processes:async()=>[],log:()=>{},
 lifecycle:{stop:async()=>{calls.push('stop');return ['original'];},resume:async()=>calls.push('resume')},
 run:async(command,args)=>{assert.equal(command,'omp');calls.push(args.join(' '));return {status:0};}});
 assert.deepEqual(calls,['stop','update','update --plugins','resume']);
});
