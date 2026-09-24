import { test, assertEqual } from './harness.js';
import { splitWindowClass } from '../src/windowClass.js';

test('splitWindowClass: the last two capitalised segments become app and child', () => {
    assertEqual(splitWindowClass('org.gnome.Shell.Extensions.ScreenTime.Timesheet'), {
        appClass: 'org.gnome.Shell.Extensions.ScreenTime',
        appName: 'Screen Time',
        child: { id: 'Timesheet', name: 'Timesheet' },
    });
});

test('splitWindowClass: a single app segment has no child', () => {
    assertEqual(splitWindowClass('com.example.MyApp'),
        { appClass: 'com.example.MyApp', appName: 'My App', child: null });
});

test('splitWindowClass: an all-lowercase class keeps its last segment', () => {
    assertEqual(splitWindowClass('org.kde.kate'),
        { appClass: 'org.kde.kate', appName: 'kate', child: null });
});

test('splitWindowClass: runs of capitals stay one word', () => {
    assertEqual(splitWindowClass('com.jetbrains.IDEAProject').appName, 'IDEA Project');
});

test('splitWindowClass: anything not reverse-DNS is left to the Shell', () => {
    for (let plain of ['Firefox', 'jetbrains-idea', 'My App', '', null, 'a..b', '.a.b'])
        assertEqual(splitWindowClass(plain), null, String(plain));
});
