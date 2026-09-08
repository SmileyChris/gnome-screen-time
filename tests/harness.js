// Minimal test registry for `gjs -m`. No GNOME imports so it runs anywhere gjs does.
const tests = [];

export function test(name, fn) {
    tests.push({ name, fn });
}

export function assert(cond, msg = 'assertion failed') {
    if (!cond)
        throw new Error(msg);
}

// Deep equality by JSON, which is exact enough for the plain data these
// modules produce and prints both sides on failure.
export function assertEqual(actual, expected, msg = '') {
    let a = JSON.stringify(actual);
    let e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${msg}\n    expected: ${e}\n    actual:   ${a}`);
}

export async function runAll() {
    let failed = 0;
    for (let t of tests) {
        try {
            await t.fn();
            print(`ok   ${t.name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${t.name}\n     ${e.message}`);
        }
    }
    print(`\n${tests.length - failed}/${tests.length} passed`);
    return failed;
}
