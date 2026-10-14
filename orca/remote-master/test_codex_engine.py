import json
import unittest

from codex_engine import decode_events


class CodexEvents(unittest.TestCase):
    def test_error_is_not_success_even_if_completed_event_arrives(self):
        events = [
            {'type': 'thread.started', 'thread_id': 'thread-A'},
            {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'Partial answer'}},
            {'type': 'error', 'message': 'Provider disconnected'},
            {'type': 'turn.completed'},
        ]
        result = decode_events('\n'.join(map(json.dumps, events)))
        self.assertTrue(result['failed'])
        self.assertEqual(result['session_id'], 'thread-A')

    def test_only_final_agent_messages_and_completed_tools_are_reported(self):
        events = [
            {'type': 'thread.started', 'thread_id': 'thread-B'},
            {'type': 'item.started', 'item': {'type': 'agent_message', 'text': 'Do not repeat draft'}},
            {'type': 'item.completed', 'item': {'type': 'reasoning', 'text': 'Do not display reasoning'}},
            {'type': 'item.completed', 'item': {'type': 'mcp_tool_call', 'server': 'worktree', 'tool': 'read_file', 'status': 'completed'}},
            {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'Verified result'}},
            {'type': 'turn.completed'},
        ]
        result = decode_events('shell startup banner\n' + '\n'.join(map(json.dumps, events)))
        self.assertEqual(result['text'], 'Verified result')
        self.assertEqual(result['tool_calls'], [{'server': 'worktree', 'tool': 'read_file', 'status': 'completed'}])
        self.assertTrue(result['completed'])
        self.assertFalse(result['failed'])


if __name__ == '__main__':
    unittest.main()
