"""Read-only native Claude identity probe; prints no credentials or process argv."""
import base64
import json
import pathlib
import socket
import subprocess
import sys
import uuid

request = json.loads(base64.b64decode(sys.argv[1]))
directory = pathlib.Path.home() / 'Library/Application Support/orca/daemon'
matches = []
for file in directory.glob('daemon-v*.pid'):
    version = int(file.stem.split('-v')[1])
    expected = json.loads(file.read_text())
    try:
        connection = socket.socket(socket.AF_UNIX)
        connection.settimeout(4)
        connection.connect(str(directory / f'daemon-v{version}.sock'))
        stream = connection.makefile('rwb')
        def exchange(value):
            stream.write((json.dumps(value) + '\n').encode())
            stream.flush()
            return json.loads(stream.readline())
        hello = exchange(dict(type='hello', version=version, token=(directory / f'daemon-v{version}.token').read_text().strip(), clientId=str(uuid.uuid4()), role='control'))
        identity = hello.get('daemonIdentity', {})
        assert hello.get('ok') and identity.get('pid') == expected['pid'] and identity.get('launchNonce') == expected['launchNonce']
        reply = exchange(dict(id=str(uuid.uuid4()), type='listSessions'))
        assert reply.get('ok')
        matches += [s for s in reply['payload']['sessions'] if s.get('terminalHandle') == request['terminal'] and s.get('incarnationId') == request['incarnation'] and s.get('isAlive') is True]
        connection.close()
    except (OSError, AssertionError):
        continue
assert len(matches) == 1, 'Native PTY identity unavailable'
native = matches[0]
rows = {}
for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,tty=,command='], text=True).splitlines():
    parts = line.strip().split(None, 3)
    if len(parts) == 4:
        rows[int(parts[0])] = (int(parts[1]), parts[2], parts[3])
descendants = {native['pid']}
while True:
    expanded = descendants | {pid for pid, row in rows.items() if row[0] in descendants}
    if expanded == descendants:
        break
    descendants = expanded
agents = [(pid, row) for pid, row in rows.items() if pid in descendants and '--session-id ' + request['session'] in row[2] and '--model opus' in row[2] and 'claude ' in row[2]]
assert len(agents) == 1, 'Exact native Claude process unavailable'
pid, row = agents[0]
cwd = subprocess.check_output(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], text=True).split('\nn', 1)[1].strip()
assert cwd == request['remoteWorktree'], 'Native working directory changed'
files = list((pathlib.Path.home() / '.claude/projects').glob('*/' + request['session'] + '.jsonl'))
assert len(files) == 1
entries = [json.loads(line) for line in files[0].read_text().splitlines()]
assert {entry['sessionId'] for entry in entries if entry.get('sessionId')} == {request['session']}
assert {entry['cwd'] for entry in entries if entry.get('cwd')} == {cwd}
models = sorted({entry.get('message', {}).get('model') for entry in entries if entry.get('type') == 'assistant' and entry.get('message', {}).get('model')})
assert models == ['claude-opus-5-5'], 'Actual Claude model differs'
result = dict(terminal=request['terminal'], incarnation=request['incarnation'], ptyId=native['sessionId'], pid=pid, session=request['session'], cwd=cwd, models=models, nonce=request['nonce'])
print('CLAUDE_PROBE_' + request['nonce'] + ':' + base64.b64encode(json.dumps(result).encode()).decode() + ':END_PROBE')
