import { test, assert, assertEqual } from './harness.js';
import { encodeFrame, decodeFrames, MAX_FRAME } from '../companion/host/framing.js';

function concat(...arrays) {
    let n = arrays.reduce((s, a) => s + a.length, 0);
    let out = new Uint8Array(n);
    let off = 0;
    for (let a of arrays) {
        out.set(a, off);
        off += a.length;
    }
    return out;
}

test('framing: encode produces little-endian length then utf-8 json', () => {
    let f = encodeFrame({ a: 1 });
    assertEqual([...f.slice(0, 4)], [7, 0, 0, 0]);
    assertEqual(new TextDecoder().decode(f.slice(4)), '{"a":1}');
});

test('framing: round trip of two concatenated frames', () => {
    let bytes = concat(encodeFrame({ ping: true }), encodeFrame({ browser: 'brave', host: 'x', detail: '' }));
    let { messages, rest } = decodeFrames(bytes);
    assertEqual(messages, [{ ping: true }, { browser: 'brave', host: 'x', detail: '' }]);
    assertEqual(rest.length, 0);
});

test('framing: a partial frame is returned as rest', () => {
    let full = encodeFrame({ browser: 'zen', host: 'example.com', detail: 'a' });
    let cut = full.slice(0, full.length - 3);
    let { messages, rest } = decodeFrames(cut);
    assertEqual(messages, []);
    assertEqual(rest.length, cut.length);
    let { messages: m2, rest: r2 } = decodeFrames(concat(rest, full.slice(full.length - 3)));
    assertEqual(m2, [{ browser: 'zen', host: 'example.com', detail: 'a' }]);
    assertEqual(r2.length, 0);
});

test('framing: fewer than four bytes is all rest', () => {
    let { messages, rest } = decodeFrames(new Uint8Array([7, 0]));
    assertEqual(messages, []);
    assertEqual(rest.length, 2);
});

test('framing: malformed json yields null and does not stop later frames', () => {
    let bad = new TextEncoder().encode('{nope');
    let badFrame = concat(new Uint8Array([bad.length, 0, 0, 0]), bad);
    let { messages } = decodeFrames(concat(badFrame, encodeFrame({ ok: 1 })));
    assertEqual(messages, [null, { ok: 1 }]);
});

test('framing: unicode survives', () => {
    let { messages } = decodeFrames(encodeFrame({ detail: 'café/ünïcode' }));
    assertEqual(messages[0].detail, 'café/ünïcode');
});

test('framing: an absurd length is a protocol error', () => {
    let header = new Uint8Array([0, 0, 0, 0x7f]);   // ~2 GB
    let threw = false;
    try {
        decodeFrames(header);
    } catch (e) {
        threw = e instanceof RangeError;
    }
    assert(threw, 'RangeError expected');
    assert(MAX_FRAME === 1048576);
});
