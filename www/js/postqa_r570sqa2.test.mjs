// POST-QA r570sqa2 (post-deploy, 2026-10-17): MAIL-FU3's retirement of the r569 bare
// `turn-failed`. Each test asserts the correct behaviour, so red is a reproduced defect.
// Run: node --test www/js/postqa_r570sqa2.test.mjs
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWindow } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = readPage(join(HERE, 'daimond.js'), 'utf8');
const ALERTS = readPage(join(HERE, 'alerts.js'), 'utf8');

function balanced(src, start) {
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}
function extractFn(src, name) {
	const m = new RegExp('\\n\\t+(?:async )?function ' + name + '\\(').exec(src);
	return m ? balanced(src, m.index + 1) : '';
}

// QA2-M1. `retireR569MailFailures` leaves a Diamond whose actions were not read alone ("a read
// that failed reads as no actions", `Triggers.load` falls back to the defaults, which are NO
// actions). `judgeTriggeredTurn`'s own clear does not: an answered mail turn reads
// `Triggers.of(f.id)`, and an empty list passes `!acts.some(non-mail)`, so it takes down the bare
// `turn-failed` -- which on a Diamond with a timer action is that timer's CURRENT, genuine
// failure. The cache is re-read at every Diamond walk (`Triggers.reload`), so a walk whose
// triggers.json read failed while the mail turn ran is enough. The clear is a stamped register on
// the sync parcel: it lands on every device.
test('QA2-M1: an answered mail turn leaves turn-failed up when the Diamond\'s actions are unread', () => {
	const w = makeWindow({ now: 1_790_000_000_000 });
	new Function('window', 'with (window) {\n' + ALERTS + '\n}')(w);
	const J = new Function('window', `
		var _lastSteer = {};
		// The walk's re-read failed: the cache holds the defaults, no actions.
		var Triggers = { of: function () { return []; } };
		function t(k) { return k; }
		${extractFn(APP, 'judgeTriggeredTurn')}
		return { judge: judgeTriggeredTurn, steer: _lastSteer };`)(w);
	const sweep = new Function('window', `
		var Triggers = { of: function () { return []; } };
		${extractFn(APP, 'retireR569MailFailures')}
		return retireR569MailFailures;`)(w);
	// The timer action's genuine failure, raised a minute ago.
	assert.equal(w.DaimondAlerts.raise('B', 'turn-failed', 'Ops: a turn failed', 'timer 10:41', true), 'new');
	w._setNow(1_790_000_100_000);
	sweep(w);
	assert.deepEqual(w.DaimondAlerts.live().map((a) => a.key), ['turn-failed'], 'the sweep (control) left it up');
	J.steer.B = { how: 'answered', calls: 1, failed: 0, refused: 0 };
	assert.equal(J.judge({ id: 'B', name: 'Ops' }, null, false, true), false);
	const up = w.DaimondAlerts.live().filter((a) => a.diamond === 'B' && a.needs).map((a) => a.key);
	assert.deepEqual(up, ['turn-failed'], 'an answered mail turn took down a failure it cannot know is r569\'s');
});

// QA2-W1. UNBLOCK-24 puts the Diamond's name in the row ⋯ ("Add to <name>", "Remove from <name>").
// `.railhead-menu` has a min-width and no max-width, and `.railhead-menu-item` is `nowrap` with no
// ellipsis, so the menu is as wide as the name; `openPop` clamps only its left edge to 8px. On a
// 390px phone a 61-character name draws the menu 432px wide, from x=8 to x=440: the item's words
// run off the right edge (dev/postqa_r570sqa2_wsadd.mjs, WebKit iPhone). Held here on the CSS that
// would keep it on screen: a max-width inside the viewport, and an item that ellipsises.
test('QA2-W1: the Workspace ⋯ menu cannot be wider than the screen, and a long item ellipsises', () => {
	const CSS = readPage(join(HERE, '..', 'css', 'app.css'), 'utf8');
	const rule = (sel) => {
		const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const m = new RegExp('(^|\\n)' + esc + '\\s*\\{([^}]*)\\}').exec(CSS);
		return m ? m[2] : '';
	};
	const menu = rule('.railhead-menu'), it = rule('.railhead-menu-item');
	assert.ok(menu, '.railhead-menu rule not found');
	assert.match(menu, /max-width:\s*(calc\(100(vw|%)|min\()/, '.railhead-menu has no max-width bounded by the viewport: ' + menu.trim());
	assert.match(it, /text-overflow:\s*ellipsis/, '.railhead-menu-item does not ellipsise: ' + it.trim());
	assert.match(it, /overflow:\s*hidden/, '.railhead-menu-item does not clip: ' + it.trim());
});
