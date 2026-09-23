import { test, assert, assertEqual } from './harness.js';
import { ActivitySourceRegistry, ZellijSource, WindowClassSource, TERMINAL_APP_IDS, DEBOUNCE_MS }
    from '../src/activitySources.js';

class FakeSource {
    constructor(result) {
        this.result = result;
        this.calls = 0;
        this.destroyed = false;
    }
    claims(appId) { return appId === 'term.desktop'; }
    async resolve() { this.calls++; return this.result; }
    destroy() { this.destroyed = true; }
}

const SUB = { activityId: 'claude', activityName: 'claude', detailId: 'repo', detailName: 'repo' };

test('registry: unclaimed app resolves to null without asking any source', async () => {
    let src = new FakeSource(SUB);
    let reg = new ActivitySourceRegistry([src]);
    assertEqual(await reg.resolve({}, 'other.desktop'), null);
    assertEqual(src.calls, 0);
});

test('registry: claimed app returns the source result', async () => {
    let src = new FakeSource(SUB);
    let reg = new ActivitySourceRegistry([src]);
    assertEqual(await reg.resolve({}, 'term.desktop'), SUB);
    assertEqual(src.calls, 1);
});

test('registry: debounced to one resolve per window per DEBOUNCE_MS', async () => {
    let src = new FakeSource(SUB);
    let reg = new ActivitySourceRegistry([src]);
    let win = {};
    let t0 = 1000;
    await reg.resolve(win, 'term.desktop', t0);
    await reg.resolve(win, 'term.desktop', t0 + 100);
    await reg.resolve(win, 'term.desktop', t0 + DEBOUNCE_MS - 1);
    assertEqual(src.calls, 1, 'inside the window: cached');
    await reg.resolve(win, 'term.desktop', t0 + DEBOUNCE_MS);
    assertEqual(src.calls, 2, 'at the window edge: spawns again');
});

test('registry: debounce is per window', async () => {
    let src = new FakeSource(SUB);
    let reg = new ActivitySourceRegistry([src]);
    await reg.resolve({}, 'term.desktop', 0);
    await reg.resolve({}, 'term.desktop', 0);
    assertEqual(src.calls, 2);
});

test('registry: a throwing source yields null and is not fatal', async () => {
    let src = new FakeSource(null);
    src.resolve = async () => { throw new Error('boom'); };
    let reg = new ActivitySourceRegistry([src]);
    assertEqual(await reg.resolve({}, 'term.desktop'), null);
});

test('registry: destroy reaches every source', () => {
    let src = new FakeSource(SUB);
    new ActivitySourceRegistry([src]).destroy();
    assert(src.destroyed);
});

test('ZellijSource: claims the shipped terminal ids and nothing else', () => {
    let z = new ZellijSource();
    assert(TERMINAL_APP_IDS.includes('org.gnome.Console.desktop'));
    assert(z.claims('org.gnome.Console.desktop'));
    assert(!z.claims('org.mozilla.firefox.desktop'));
    z.destroy();
});

test('ZellijSource: a title without a session token resolves to null and never spawns', async () => {
    let z = new ZellijSource();
    z._dumpLayout = async () => { throw new Error('must not spawn'); };
    assertEqual(await z.resolve({ get_title: () => 'Terminal' }), null);
    assertEqual(await z.resolve({ get_title: () => null }), null);
    z.destroy();
});

test('ZellijSource: maps command and cwd basename onto the sub-path', async () => {
    let z = new ZellijSource();
    let asked = null;
    z._dumpLayout = async session => {
        asked = session;
        return `layout {
    tab name="t" focus=true {
        pane command="claude" cwd="dev/lab/gnome-screen-time" focus=true
    }
}`;
    };
    let sub = await z.resolve({ get_title: () => 'stellar-galaxy | * whatever' });
    assertEqual(asked, 'stellar-galaxy');
    assertEqual(sub, {
        activityId: 'claude', activityName: 'claude',
        detailId: 'gnome-screen-time', detailName: 'gnome-screen-time',
    });
    z.destroy();
});

test('ZellijSource: no command is the shell, no cwd is two levels', async () => {
    let z = new ZellijSource();
    z._dumpLayout = async () => `layout {
    tab name="t" focus=true {
        pane cwd="dev/x" focus=true
    }
}`;
    assertEqual(await z.resolve({ get_title: () => 's | t' }), {
        activityId: 'shell', activityName: 'shell', detailId: 'x', detailName: 'x',
    });
    z._dumpLayout = async () => `layout {
    tab name="t" focus=true {
        pane command="htop" focus=true
    }
}`;
    assertEqual(await z.resolve({ get_title: () => 's | t' }), {
        activityId: 'htop', activityName: 'htop', detailId: null, detailName: null,
    });
    z.destroy();
});

test('ZellijSource: a failed dump or no focused pane resolves to null', async () => {
    let z = new ZellijSource();
    z._dumpLayout = async () => null;
    assertEqual(await z.resolve({ get_title: () => 's | t' }), null);
    z._dumpLayout = async () => 'layout {\n}\n';
    assertEqual(await z.resolve({ get_title: () => 's | t' }), null);
    z.destroy();
});

test('ZellijSource: a missing binary disables the source for the session', async () => {
    let z = new ZellijSource();
    z._binary = 'definitely-not-zellij-' + Date.now();
    assertEqual(await z.resolve({ get_title: () => 's | t' }), null);
    assert(z._disabled, 'negative result cached');
    // Now even a working dump would not be attempted.
    z._dumpLayout = async () => { throw new Error('must not spawn'); };
    assertEqual(await z.resolve({ get_title: () => 's | t' }), null);
    z.destroy();
});

test('ZellijSource: _argv passes the session as --session=, never a positional value', () => {
    let z = new ZellijSource();
    assertEqual(z._argv('s'), ['zellij', '--session=s', 'action', 'dump-layout']);
    z.destroy();
});

test('ZellijSource: a session token starting with "-" resolves to null and never spawns', async () => {
    let z = new ZellijSource();
    z._dumpLayout = async () => { throw new Error('must not spawn'); };
    assertEqual(await z.resolve({ get_title: () => '--help | x' }), null);
    z.destroy();
});

test('ZellijSource: an implausibly long session token resolves to null and never spawns', async () => {
    let z = new ZellijSource();
    z._dumpLayout = async () => { throw new Error('must not spawn'); };
    let title = 'a'.repeat(200) + ' | x';
    assertEqual(await z.resolve({ get_title: () => title }), null);
    z.destroy();
});

test('ZellijSource: an empty command string is treated as no command', async () => {
    let z = new ZellijSource();
    z._dumpLayout = async () => `layout {
    tab name="t" focus=true {
        pane command="" cwd="dev/x" focus=true
    }
}`;
    assertEqual(await z.resolve({ get_title: () => 's | t' }), {
        activityId: 'shell', activityName: 'shell', detailId: 'x', detailName: 'x',
    });
    z.destroy();
});

test('ZellijSource: a detail directory named __other__ does not merge into the fold node', async () => {
    let z = new ZellijSource();
    z._dumpLayout = async () => `layout {
    tab name="t" focus=true {
        pane command="claude" cwd="dev/__other__" focus=true
    }
}`;
    let sub = await z.resolve({ get_title: () => 's | t' });
    assertEqual(sub.detailId, '_other_');
    z.destroy();
});

test('registry: passes the app id to the source', async () => {
    let seen = null;
    let src = new FakeSource(SUB);
    src.resolve = async (win, appId) => { seen = appId; return SUB; };
    let reg = new ActivitySourceRegistry([src]);
    await reg.resolve({}, 'term.desktop');
    assertEqual(seen, 'term.desktop');
});

test('registry: a source change drops the debounce cache and fans out', async () => {
    let src = new FakeSource(SUB);
    src.onChange = null;
    let reg = new ActivitySourceRegistry([src]);
    let fired = 0;
    reg.onChange = () => fired++;
    let win = {};
    await reg.resolve(win, 'term.desktop', 1000);
    src.onChange('term');
    assertEqual(fired, 1);
    await reg.resolve(win, 'term.desktop', 1001);
    assertEqual(src.calls, 2, 'resolved again despite the debounce window');
});

test('registry: onChange receives the source that changed', async () => {
    let src = new FakeSource(SUB);
    src.onChange = null;
    let reg = new ActivitySourceRegistry([src]);
    let seen = null;
    reg.onChange = s => { seen = s; };
    src.onChange('term');
    assertEqual(seen === src, true);
});

test('registry: a window-backed app gets its class\'s last segment as the activity', async () => {
    let registry = new ActivitySourceRegistry([]);
    let win = { get_wm_class: () => 'org.gnome.Shell.Extensions.ScreenTime.Timesheet' };
    assertEqual(await registry.resolve(win, 'wmclass:org.gnome.Shell.Extensions.ScreenTime'),
        { activityId: 'Timesheet', activityName: 'Timesheet' });
    let plain = { get_wm_class: () => 'com.example.MyApp' };
    assertEqual(await registry.resolve(plain, 'wmclass:com.example.MyApp'), null);
    assert(!new WindowClassSource().claims('org.gnome.Console.desktop'));
});
