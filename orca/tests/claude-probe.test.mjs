import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('native Claude proof accepts the exact fresh or resumed session and rejects ambiguous process arguments', () => {
  const script = `
import ast,json,pathlib,shlex,sys
tree=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='matches_claude_process']
assert len(functions)==1,'native process argument matcher missing'
exec(compile(ast.Module(body=functions,type_ignores=[]),'probe','exec'))
cases=[
 ('claude --model opus --session-id exact',True),
 ('/opt/bin/claude --resume "exact" --model opus',True),
 ('claude --model opus --resume other',False),
 ('claude --model sonnet --resume exact',False),
 ('claude --model opus --resume exact --session-id other',False),
 ('sh -c "claude --model opus --session-id exact"',False),
 ('claude --model opus --resume exact-extra',False),
 ('claude --model opus --resume',False),
]
for command,expected in cases:
 assert matches_claude_process(command,'exact') is expected,command
print(json.dumps({'passed':len(cases)}))
`;
  const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script,
    fileURLToPath(new URL('../remote-master/claude_probe.py', import.meta.url))], { encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(output).passed, 8);
});
