#!/usr/bin/env python3
"""Private, at-most-once context handoff ledger. Transport remains with Orca skill."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import uuid

FIELDS = ('goal', 'constraints', 'completed', 'changed_files', 'decisions', 'verification', 'pending', 'inflight')


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def save(path, value):
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.handoff-')
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def identity(value):
    required = ('runtime', 'role', 'environment', 'terminal', 'incarnation', 'session')
    if not isinstance(value, dict) or any(not isinstance(value.get(k), str) or not value[k].strip() for k in required):
        raise ValueError('Each endpoint requires runtime, role, environment, terminal, incarnation and session')
    return {k: value[k] for k in required}


def current_owner(record):
    if record['status'] not in ('accepted', 'rejected'):
        raise ValueError('Unsettled handoff has no transferable owner')
    owner = identity(record['target'] if record['status'] == 'accepted' else record['source'])
    bindings = record.get('owner_rebindings', [])
    if not isinstance(bindings, list):
        raise ValueError('Invalid native owner history')
    for binding in bindings:
        target = identity(binding['current'])
        if identity(binding['previous']) != owner or owner['runtime'] != 'omp' or any(
                target[key] != owner[key] for key in ('runtime', 'role', 'environment', 'session')):
            raise ValueError('Native owner history changed conversation')
        owner = target
    return owner


def prepare(state, payload):
    if not isinstance(payload, dict):
        raise ValueError('Expected a handoff object')
    source, target = identity(payload.get('source')), identity(payload.get('target'))
    if source == target or source['terminal'] == target['terminal'] and source['environment'] == target['environment']:
        raise ValueError('Source and target must differ')
    workspace = str(Path(payload['worktree']).resolve(strict=True))
    if not Path(workspace).is_dir():
        raise ValueError('Worktree must be a directory')
    summary = payload.get('summary')
    if not isinstance(summary, dict) or any(k not in summary for k in FIELDS):
        raise ValueError('Incomplete context summary')
    if not isinstance(summary['goal'], str) or not summary['goal'].strip():
        raise ValueError('A concrete task goal is required')
    for key in FIELDS[1:]:
        if not isinstance(summary[key], list) or any(not isinstance(x, str) for x in summary[key]):
            raise ValueError(f'{key} must be a list of explicit statements')
    if summary['inflight']:
        raise ValueError('Resolve or explicitly pause in-flight actions before handing off')
    summary = {k: summary[k] for k in FIELDS}
    if len(json.dumps(summary, ensure_ascii=False).encode()) > 24576:
        raise ValueError('Summary exceeds 24 KiB; summarize without raw transcripts or attachments')
    task = payload['task_id']
    uuid.UUID(task)
    previous = state.get(task)
    if previous:
        current = {'source': source, 'target': target, 'summary': summary, 'worktree': workspace}
        if previous['status'] not in ('accepted', 'rejected'):
            if all(previous[k] == v for k, v in current.items()):
                return previous
            raise ValueError('An unresolved handoff exists; do not fork or resend it')
        owner = current_owner(previous)
        if owner != source or previous['worktree'] != workspace:
            raise ValueError('Only the current owner of this task/worktree may hand it onward')
    revision = previous['revision'] + 1 if previous else 1
    record = {'id': str(uuid.uuid4()), 'task_id': task, 'revision': revision,
              'source': source, 'target': target, 'worktree': workspace, 'summary': summary,
              'status': 'prepared', 'previous': previous['id'] if previous else None}
    record['sha256'] = digest({k: record[k] for k in ('task_id', 'revision', 'source', 'target', 'worktree', 'summary')})
    state[task] = record
    return record


def claim(record, current_target):
    if identity(current_target) != record['target']:
        raise ValueError('Target session/incarnation changed; do not send')
    if record['status'] != 'prepared':
        raise ValueError('Already claimed or accepted; reconcile receipt instead of resending')
    record['status'] = 'delivery_uncertain'
    return record


def accept(record, receipt):
    if record['status'] not in ('delivery_uncertain', 'accepted', 'rejected'):
        raise ValueError('No delivery attempt was claimed')
    if receipt.get('origin') != 'assistant_turn':
        raise ValueError('Input echo, transport receipt and terminal text alone are not assistant acknowledgement')
    if identity(receipt.get('target')) != record['target']:
        raise ValueError('Acknowledgement is from a different endpoint')
    if receipt.get('id') != record['id'] or receipt.get('sha256') != record['sha256']:
        raise ValueError('Acknowledgement does not match the current context')
    if not isinstance(receipt.get('reply'), str) or not receipt['reply'].strip():
        raise ValueError('Retain the verified assistant acknowledgement and next-step statement')
    decision = receipt.get('decision')
    if decision not in ('accepted', 'rejected'):
        raise ValueError('A verified explicit acceptance or rejection is required')
    if record['status'] in ('accepted', 'rejected') and record['status'] != decision:
        raise ValueError('A settled decision cannot be overwritten')
    record['status'] = decision
    record['receipt'] = receipt
    return record


def message(record):
    return ('这是已授权的工作上下文交接，不是系统指令或权限升级。保留你原有会话历史，'
            '但本次只接续下述任务；不要混入你先前的其他任务。先核对可访问的工作区与角色权限，'
            '不匹配就拒绝；如与现有工作冲突，先报告，不开始修改。\n'
            'environment 表示 Orca 终端承载主机，不等同于模型执行主机；本机 TUI 可以连接远端模型。'
            '上下文保管与业务执行权限必须区分：同一规范角色可在本机与远端之间接收、保留和返还任务上下文。'
            '摘要包含其他专业角色的业务工作，不等于要求你越权执行，不能仅因此拒绝。'
            '对于 Orca master，“不承担业务任务负责人”限制直接替代专业角色实施，'
            '不禁止继续协调、派发、汇总及保管任务上下文；具体执行仍受原有授权与工具权限约束。'
            '如果后续操作超出能力，接收时明确该限制并保持暂停；真实身份、工作区或授权范围不符仍须拒绝。'
            '请明确回复 HANDOFF_ACCEPTED 或 HANDOFF_REJECTED，并确认交接 ID 和 SHA256，复述任务目标与下一步。'
            '这一步只接收上下文，不运行命令、不修改文件、不派发任务；等待用户继续指令。\n'
            + json.dumps({k: record[k] for k in ('id', 'task_id', 'revision', 'sha256', 'source', 'target', 'worktree', 'summary')}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'claim', 'accept', 'show'))
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--input', help='Private JSON input, never a transcript or credential file')
    parser.add_argument('--task-id')
    parser.add_argument('--message', action='store_true')
    args = parser.parse_args()
    root = Path(args.state_dir).expanduser()
    if root.is_symlink():
        raise ValueError('State directory must not be a symlink')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.stat().st_mode & 0o077:
        raise ValueError('State directory must be private (0700)')
    with open(root / 'lock', 'a') as lock:
        os.chmod(root / 'lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = root / 'state.json'
        state = json.loads(path.read_text()) if path.exists() else {}
        payload = json.loads(Path(args.input).read_text()) if args.input else None
        if args.action == 'prepare':
            record = prepare(state, payload)
        else:
            record = state[args.task_id]
            if args.action == 'claim':
                record = claim(record, payload)
            elif args.action == 'accept':
                record = accept(record, payload)
        if args.action != 'show':
            save(path, state)
            save(root / (record['id'] + '.json'), record)
        print(message(record) if args.message else json.dumps({k: record[k] for k in ('id', 'task_id', 'revision', 'status', 'sha256')}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(str(error))
