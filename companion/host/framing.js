// Native messaging wire format shared by Chromium and Gecko: a 32-bit
// little-endian byte length followed by that many bytes of UTF-8 JSON.
// Pure functions so the host's parsing is unit tested without a browser.

// Browsers cap native messages at 1 MB; anything larger is a corrupt stream.
export const MAX_FRAME = 1048576;

export function encodeFrame(obj) {
    let body = new TextEncoder().encode(JSON.stringify(obj));
    let out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint32(0, body.length, true);
    out.set(body, 4);
    return out;
}

// Decodes every complete frame in `bytes`. A frame whose body is not valid
// JSON yields null so the caller can skip it. Bytes after the last complete
// frame come back as `rest` for the caller to prepend to the next read.
export function decodeFrames(bytes) {
    let messages = [];
    let offset = 0;
    let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (bytes.length - offset >= 4) {
        let len = view.getUint32(offset, true);
        if (len > MAX_FRAME)
            throw new RangeError(`frame length ${len} exceeds ${MAX_FRAME}`);
        if (bytes.length - offset - 4 < len)
            break;
        let body = bytes.subarray(offset + 4, offset + 4 + len);
        try {
            messages.push(JSON.parse(new TextDecoder().decode(body)));
        } catch {
            messages.push(null);
        }
        offset += 4 + len;
    }
    return { messages, rest: bytes.slice(offset) };
}
