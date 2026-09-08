import { test, assertEqual } from './harness.js';
import { sessionFromTitle } from '../src/zellijLayout.js';

test('sessionFromTitle: real kgx title yields the session token', () => {
    assertEqual(
        sessionFromTitle('stellar-galaxy | * Penpot MCP main page sketch'),
        'stellar-galaxy');
});

test('sessionFromTitle: non-greedy on repeated separators', () => {
    assertEqual(sessionFromTitle('a | b | c'), 'a');
});

test('sessionFromTitle: plain title has no session', () => {
    assertEqual(sessionFromTitle('Terminal'), null);
});

test('sessionFromTitle: empty and non-string input', () => {
    assertEqual(sessionFromTitle(''), null);
    assertEqual(sessionFromTitle(null), null);
    assertEqual(sessionFromTitle(undefined), null);
});
