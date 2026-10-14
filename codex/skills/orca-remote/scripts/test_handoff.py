import copy
import tempfile
import unittest
import uuid
from pathlib import Path

import handoff


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.local = dict(runtime='omp', role='master', environment='local', terminal='local', incarnation='a', session='local-session')
        self.remote = dict(runtime='codex', role='master', environment='local', terminal='native-remote', incarnation='b', session='remote-session')
        self.payload = dict(task_id=str(uuid.uuid4()), worktree=self.temp.name, source=self.local, target=self.remote,
                            summary={key: ('Continue the same task' if key == 'goal' else []) for key in handoff.FIELDS})
        self.state = {}

    def receipt(self, record):
        return dict(origin='assistant_turn', decision='accepted', target=record['target'], id=record['id'], sha256=record['sha256'], reply='Accepted the goal; next action is waiting for user continuation.')

    def test_bidirectional_handoff_carries_latest_state_and_preserves_identity(self):
        outbound = handoff.prepare(self.state, self.payload)
        handoff.claim(outbound, self.remote)
        handoff.accept(outbound, self.receipt(outbound))
        returning = copy.deepcopy(self.payload)
        returning.update(source=self.remote, target=self.local)
        returning['summary']['completed'] = ['Remote implementation finished; validation remains pending']
        inbound = handoff.prepare(self.state, returning)
        self.assertEqual(inbound['revision'], 2)
        self.assertEqual(inbound['previous'], outbound['id'])
        self.assertEqual(inbound['summary']['completed'], returning['summary']['completed'])
        handoff.claim(inbound, self.local)
        handoff.accept(inbound, self.receipt(inbound))
        self.assertEqual(self.state[self.payload['task_id']]['target']['session'], 'local-session')

    def test_ambiguous_delivery_cannot_be_resent_or_forked(self):
        record = handoff.prepare(self.state, self.payload)
        handoff.claim(record, self.remote)
        self.assertIs(handoff.prepare(self.state, self.payload), record)
        with self.assertRaises(ValueError):
            handoff.claim(record, self.remote)
        changed = copy.deepcopy(self.payload)
        changed['summary']['goal'] = 'A conflicting task'
        with self.assertRaises(ValueError):
            handoff.prepare(self.state, changed)

    def test_echo_stale_ack_and_restarted_target_do_not_accept(self):
        record = handoff.prepare(self.state, self.payload)
        with self.assertRaises(ValueError):
            handoff.claim(record, {**self.remote, 'incarnation': 'restarted'})
        handoff.claim(record, self.remote)
        for override in ({'origin': 'input_echo'}, {'sha256': 'stale'}, {'target': self.local}):
            with self.assertRaises(ValueError):
                handoff.accept(record, {**self.receipt(record), **override})
        self.assertEqual(record['status'], 'delivery_uncertain')

    def test_old_owner_and_inflight_operations_block_switch(self):
        record = handoff.prepare(self.state, self.payload)
        handoff.claim(record, self.remote)
        handoff.accept(record, self.receipt(record))
        with self.assertRaises(ValueError):
            handoff.prepare(self.state, self.payload)
        changed = copy.deepcopy(self.payload)
        changed['task_id'] = str(uuid.uuid4())
        changed['summary']['inflight'] = ['A write is still running']
        with self.assertRaises(ValueError):
            handoff.prepare(self.state, changed)

    def test_rejection_retains_source_and_allows_corrected_revision(self):
        record = handoff.prepare(self.state, self.payload)
        handoff.claim(record, self.remote)
        with self.assertRaises(ValueError):
            handoff.accept(record, {**self.receipt(record), 'decision': None})
        handoff.accept(record, {**self.receipt(record), 'decision': 'rejected', 'reply': 'Role does not match; rejected.'})
        with self.assertRaises(ValueError):
            handoff.accept(record, self.receipt(record))
        correction = copy.deepcopy(self.payload)
        correction['target']['role'] = 'master-codex-remote'
        next_record = handoff.prepare(self.state, correction)
        self.assertEqual(next_record['revision'], 2)
        self.assertEqual(next_record['source'], self.local)

    def test_native_client_rebinding_allows_return_with_the_same_conversation(self):
        self.remote['runtime'] = 'omp'
        outbound = handoff.prepare(self.state, self.payload)
        handoff.claim(outbound, self.remote)
        handoff.accept(outbound, self.receipt(outbound))
        original_receipt = copy.deepcopy(outbound['receipt'])
        current = {**self.remote, 'terminal': 'reopened', 'incarnation': 'new-ui'}
        outbound['owner_rebindings'] = [{'previous': self.remote, 'current': current}]
        with self.assertRaises(ValueError):
            handoff.prepare(self.state, {**self.payload, 'source': self.remote, 'target': self.local})
        inbound = handoff.prepare(self.state, {**self.payload, 'source': current, 'target': self.local})
        self.assertEqual(inbound['revision'], 2)
        self.assertEqual(inbound['previous'], outbound['id'])
        self.assertEqual(inbound['source'], current)
        self.assertEqual(outbound['receipt'], original_receipt)

    def test_native_rebinding_cannot_change_the_conversation_or_skip_an_owner(self):
        self.remote['runtime'] = 'omp'
        outbound = handoff.prepare(self.state, self.payload)
        handoff.claim(outbound, self.remote)
        handoff.accept(outbound, self.receipt(outbound))
        for changed in ('runtime', 'role', 'environment', 'session', 'previous'):
            with self.subTest(changed=changed):
                record = copy.deepcopy(outbound)
                current = {**self.remote, 'terminal': 'reopened', 'incarnation': 'new-ui'}
                previous = dict(self.remote)
                if changed == 'previous':
                    previous['terminal'] = 'another-owner'
                else:
                    current[changed] = 'different'
                record['owner_rebindings'] = [{'previous': previous, 'current': current}]
                state = {record['task_id']: record}
                with self.assertRaises(ValueError):
                    handoff.prepare(state, {**self.payload, 'source': current, 'target': self.local})
                self.assertIs(state[record['task_id']], record)



if __name__ == '__main__':
    unittest.main()
