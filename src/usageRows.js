import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatTime } from './formatTime.js';
import { ROW_W, BAR_W, DIM_OPACITY, makeUsageBar } from './usageBar.js';

// Pixels of indent per nesting level. The bar shrinks by the same amount so
// every level's right edge stays aligned.
export const INDENT = 12;

const ARROW_CLOSED = ' ▸';
const ARROW_OPEN = ' ▾';

// Name, "time · pct%" and a bar, wrapped in a non-activating menu item.
// `arrow` is an optional trailing St.Label owned by an expandable row.
function buildRow({ name, seconds, pct, color, depth = 0, dim = false }, arrow) {
    let item = new PopupMenu.PopupBaseMenuItem({activate: false});
    item.track_hover = false;
    item.style = 'padding: 0;';

    let indent = depth * INDENT;
    let row = new St.BoxLayout({
        vertical: true,
        style: `padding: 4px 10px 4px ${10 + indent}px; width: ${ROW_W}px;`,
    });

    let topRow = new St.BoxLayout();
    topRow.add_child(new St.Label({
        text: name,
        opacity: dim ? DIM_OPACITY : 255,
        style: 'font-size: 11px; font-weight: 500;',
    }));
    topRow.add_child(new St.BoxLayout({x_expand: true}));
    topRow.add_child(new St.Label({
        text: formatTime(seconds) + ' · ' + pct + '%',
        opacity: DIM_OPACITY,
        style: 'font-size: 10px;',
    }));
    if (arrow)
        topRow.add_child(arrow);
    row.add_child(topRow);

    let barW = BAR_W - indent;
    row.add_child(makeUsageBar(Math.round(barW * pct / 100), color, barW));
    return { item, row };
}

// A leaf row. `collapse` exists so parents can treat every child alike.
export function makeRow(opts) {
    let { item, row } = buildRow(opts, null);
    item.add_child(row);
    return { item, collapse() {} };
}

// A row that shows and hides the rows handed to setChildren. Children are
// menu items the caller adds right after this one; they start hidden.
// Collapsing also collapses each child so a re-expand never reveals a stale
// open grandchild.
export function makeExpandableRow(opts) {
    let arrow = new St.Label({
        text: ARROW_CLOSED,
        opacity: DIM_OPACITY,
        style: 'font-size: 10px;',
    });
    let { item, row } = buildRow(opts, arrow);
    let btn = new St.Button({child: row, style: 'padding: 0;'});
    item.add_child(btn);

    let children = [];
    let expanded = false;
    let collapse = () => {
        expanded = false;
        arrow.text = ARROW_CLOSED;
        for (let c of children) {
            c.item.hide();
            c.collapse();
        }
    };
    btn.connect('clicked', () => {
        if (expanded) {
            collapse();
            return;
        }
        expanded = true;
        arrow.text = ARROW_OPEN;
        for (let c of children)
            c.item.show();
    });

    return {
        item,
        collapse,
        setChildren(rows) {
            children = rows;
            for (let c of rows)
                c.item.hide();
        },
    };
}
