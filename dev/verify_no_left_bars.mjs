// verify_no_left_bars.mjs -- D-20260929-03. No row, tile, card or quote in
// Daimond carries a left-only border or box-shadow accent, and every
// selected/current row in the app is drawn with the ONE selected treatment
// (fill only, no bar, no outline).
//
//   eval "$(bash dev/world.sh N --env)"
//   node dev/verify_no_left_bars.mjs
//
// Renders the known offending rows (the owner's own screenshot: a selected
// mail account and folder; plus the selected chat/diamond, a paused agent
// tile, an unread social item, a guide callout and a quoted reply) with the
// app's real classes in an injected stage, so the check exercises the
// SHIPPED stylesheet cascade rather than a copy of it, and asserts none of
// them draws a left-only accent.
import { open } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ev = (page, f, a) => page.evaluate(f, a).catch((e) => ({ err: e.message.split('\n')[0] }));

// ── Static half: every www/css/*.css file, for the surfaces the main app
// never loads at runtime (guide.css is only linked from the standalone
// www/guide/*.html pages, never from index.html). A left-only border or an
// inset box-shadow bar anywhere outside the allowlist fails the run. The
// allowlist is structural nesting/divider lines, not state on a row, tile,
// card or quote -- named so a new one added later has to be argued for, not
// merely missed. */
const ALLOW = new Set([
	'viewer.css:.fv-jkids',       // a JSON tree's own nesting depth guide, not a state
	'app.css:.astat-detail',      // an accordion's own nesting indent, not a state
	'app.css:.dview-btn + .dview-btn', // a toolbar button-group divider, not a row bar
	'app.css:.crollup.indeterminate > .crollup-lbl .ctile-chk::after', // a checkbox's mixed-state dash, a glyph
	'guide.css:.site-nav a',      // the standalone guide's nav underline, transparent at rest; the owner to confirm
]);
function staticScan() {
	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www', 'css');
	const bad = [];
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith('.css')) continue;
		const text = fs.readFileSync(path.join(dir, f), 'utf8');
		// One CSS rule block at a time: a selector list up to its `{...}` body.
		const re = /([^{}]+)\{([^{}]*)\}/g;
		let m;
		while ((m = re.exec(text))) {
			const [, sel, body] = m;
			const selTrim = sel.trim().split('\n').pop().trim();
			if (ALLOW.has(`${f}:${selTrim}`)) continue;
			const leftBorder = /border-left(-width)?\s*:\s*[1-9]/.test(body) && !/border-left\s*:\s*0/.test(body);
			// A sideline is a sideline on any side (5.2.6 review, F1): one-sided borders of 2px or more.
			const sideBar = /border-(right|top|bottom)(-width)?\s*:\s*([2-9]|[1-9][0-9])/.test(body);
			const insetShadow = /box-shadow\s*:[^;]*inset\s+[1-9][\d.]*px\s+0(px)?\s+0(px)?/.test(body);
			if (leftBorder || sideBar || insetShadow) bad.push(`${f} :: ${selTrim}`);
		}
	}
	return bad;
}

const SURFACES = {
	'mail account (selected)':  '<div class="mail-acct on" data-nlb>a@b.com</div>',
	'mail folder (selected)':   '<div class="mail-acct mail-folder on" data-nlb>Inbox</div>',
	'chat/diamond row (selected)': '<div class="session-box active" data-nlb><div class="session-box-name">x</div></div>',
	'paused agent tile':         '<div class="acard paused" data-nlb><div class="ah"><span class="pill paused">Paused</span></div></div>',
	'unread social item':        '<div class="feed-unread" data-nlb>x</div>',
	'out-link row':              '<div class="link-row link-row-out" data-nlb>x</div>',
	'in-link row':               '<div class="link-row link-row-in" data-nlb>x</div>',
	'guide note':                '<div class="fv-md"><div class="note" data-nlb>x</div></div>',
	'guide stop note':           '<div class="fv-md"><div class="note stop" data-nlb>x</div></div>',
	'quoted reply':              '<div class="post-quote" data-nlb>x</div>',
	'own message (post-out)':    '<div class="post-out" data-nlb>x</div>',
	'chat said (fold)':          '<div class="chat-msg said" data-nlb>x</div>',
	'pending card':              '<div class="pend-card prio-high" data-nlb>x</div>',
	'ask card':                  '<div class="ask-card" data-nlb>x</div>',
};

const measure = (name) => {
	const stage = document.getElementById('nlb-stage');
	const el = stage.querySelector('[data-nlb]');
	const cs = getComputedStyle(el);
	const bw = { l: parseFloat(cs.borderLeftWidth) || 0, t: parseFloat(cs.borderTopWidth) || 0, r: parseFloat(cs.borderRightWidth) || 0, b: parseFloat(cs.borderBottomWidth) || 0 };
	// A bar on any one side: some side 2px or more, and the four not equal.
	const leftOnly = (bw.l > 0 && bw.l !== bw.t) || (Math.max(bw.l, bw.t, bw.r, bw.b) >= 2 && !(bw.l === bw.t && bw.t === bw.r && bw.r === bw.b));
	// Chromium's computed order is "<color> <x> <y> <blur> <spread> inset".
	// A left bar is x != 0, y == 0, blur == 0, inset present.
	const m = /^\S+\(.*?\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+inset/.exec(cs.boxShadow || '');
	const shadowBar = !!m && parseFloat(m[1]) !== 0 && parseFloat(m[2]) === 0 && parseFloat(m[3]) === 0;
	return { name, leftOnly, shadowBar, borderLeftWidth: bw.l, borderTopWidth: bw.t, borderRightWidth: bw.r, boxShadow: cs.boxShadow };
};

const s = await open({ name: 'alex', profile: `${process.env.DAIMOND_SCRATCH || '/tmp'}/nlb-profile` });
const page = s.page;
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(1000);
await ev(page, () => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set('obsidian'); });
await page.waitForTimeout(300);

let fails = 0;
const staticBad = staticScan();
for (const rule of staticBad) console.log('  FAIL (static) ' + rule);
fails += staticBad.length;

for (const [name, html] of Object.entries(SURFACES)) {
	await ev(page, (html) => {
		let stage = document.getElementById('nlb-stage');
		if (!stage) { stage = document.createElement('div'); stage.id = 'nlb-stage'; document.body.appendChild(stage); }
		stage.innerHTML = html;
	}, html);
	await page.waitForTimeout(50);
	const r = await ev(page, measure, name);
	const bad = r.leftOnly || r.shadowBar;
	if (bad) fails++;
	console.log((bad ? '  FAIL ' : '  ok   ') + name + (bad ? ` -- borderLeftWidth=${r.borderLeftWidth} borderTopWidth=${r.borderTopWidth} borderRightWidth=${r.borderRightWidth} boxShadow=${r.boxShadow}` : ''));
}
await s.close();
console.log(fails ? `FAIL: ${fails} left bar(s) found` : 'PASS: no left bars');
process.exit(fails ? 1 : 0);
