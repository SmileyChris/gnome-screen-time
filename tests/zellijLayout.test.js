import { test, assertEqual } from './harness.js';
import { sessionFromTitle, focusedPane, basename } from '../src/zellijLayout.js';

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

// Trimmed from a real `zellij action dump-layout` on zellij 0.44.3.
const REAL_LAYOUT = `layout {
    cwd "/home/chris"
    tab name="cineshelf" hide_floating_panes=true {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        pane command="claude" cwd="dev/lab/cineshelf" {
            start_suspended true
        }
        pane size=1 borderless=true {
            plugin location="zellij:status-bar"
        }
        floating_panes {
            pane command="uv" cwd="dev/lab/cineshelf/web" {
                start_suspended true
                height 28
                width 119
                x 60
                y 15
                args "run" "--project" "/home/chris/dev/lab/localghost" "localghost" "run"
            }
        }
    }
    tab name="screentime" focus=true hide_floating_panes=true {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        pane command="claude" cwd="dev/lab/gnome-screen-time" focus=true {
            start_suspended true
        }
        pane size=1 borderless=true {
            plugin location="zellij:status-bar"
        }
    }
    tab name="penpot" hide_floating_panes=true {
        pane command="claude" cwd="dev/lab/penpot" focus=true {
            start_suspended true
        }
    }
}
`;

test('focusedPane: real layout picks the focused pane of the focused tab', () => {
    assertEqual(focusedPane(REAL_LAYOUT),
        { command: 'claude', cwd: 'dev/lab/gnome-screen-time' });
});

test('focusedPane: focused pane with no command', () => {
    let layout = `layout {
    tab name="x" focus=true {
        pane cwd="dev/lab/fondly" focus=true
    }
}`;
    assertEqual(focusedPane(layout), { command: null, cwd: 'dev/lab/fondly' });
});

test('focusedPane: focused pane with no cwd', () => {
    let layout = `layout {
    tab name="x" focus=true {
        pane command="htop" focus=true {
            start_suspended true
        }
    }
}`;
    assertEqual(focusedPane(layout), { command: 'htop', cwd: null });
});

test('focusedPane: focused floating pane', () => {
    let layout = `layout {
    tab name="x" focus=true {
        pane command="claude" cwd="dev/a" {
            start_suspended true
        }
        floating_panes {
            pane command="uv" cwd="dev/a/web" focus=true {
                height 28
            }
        }
    }
}`;
    assertEqual(focusedPane(layout), { command: 'uv', cwd: 'dev/a/web' });
});

test('focusedPane: escaped quote in cwd is unescaped', () => {
    let layout = `layout {
    tab name="x" focus=true {
        pane command="vim" cwd="dev/say \\"hi\\"" focus=true
    }
}`;
    assertEqual(focusedPane(layout), { command: 'vim', cwd: 'dev/say "hi"' });
});

test('focusedPane: focused tab without a focused pane', () => {
    let layout = `layout {
    tab name="x" focus=true {
        pane command="claude" cwd="dev/a"
    }
}`;
    assertEqual(focusedPane(layout), null);
});

test('focusedPane: no focused tab', () => {
    let layout = `layout {
    tab name="x" {
        pane command="claude" cwd="dev/a" focus=true
    }
}`;
    assertEqual(focusedPane(layout), null);
});

test('focusedPane: malformed and empty input', () => {
    assertEqual(focusedPane(''), null);
    assertEqual(focusedPane('not a layout at all'), null);
    assertEqual(focusedPane(null), null);
    assertEqual(focusedPane('tab focus=true'), null);
});

test('basename: relative, absolute, trailing slash, spaces', () => {
    assertEqual(basename('dev/lab/gnome-screen-time'), 'gnome-screen-time');
    assertEqual(basename('/home/chris'), 'chris');
    assertEqual(basename('dev/lab/x/'), 'x');
    assertEqual(basename('Brain/Tactful/BNZ Finance Application'), 'BNZ Finance Application');
    assertEqual(basename('single'), 'single');
});

test('focusedPane: braces inside quoted args on an earlier pane do not end the tab early', () => {
    let layout = `layout {
    tab name="x" focus=true {
        pane command="rg" cwd="dev/a" {
            args "--replace" "}"
        }
        pane command="claude" cwd="dev/b" focus=true {
            start_suspended true
        }
    }
}`;
    assertEqual(focusedPane(layout), { command: 'claude', cwd: 'dev/b' });
});

test('focusedPane: a brace inside a quoted value on the focused pane line itself', () => {
    let layout = `layout {
    tab name="x" focus=true {
        pane command="fd" cwd="dev/{a,b}" focus=true {
            args "-e" "{js,tsx}"
        }
    }
}`;
    assertEqual(focusedPane(layout), { command: 'fd', cwd: 'dev/{a,b}' });
});

test('focusedPane: attributes after focus=true on the pane line are still read', () => {
    let layout = `layout {
    tab name="x" focus=true {
        pane focus=true command="vim" cwd="dev/c" {
            start_suspended true
        }
    }
}`;
    assertEqual(focusedPane(layout), { command: 'vim', cwd: 'dev/c' });
});
