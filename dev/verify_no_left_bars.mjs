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
//
// RATING U2 (2026-10-01). The stage also takes the rated answer tile (its label
// bar, the lit and unlit arrows, the details control with `.on`, the phone row,
// the chip row with a pressed chip), the Rating tile (a line, its jump link, its
// score and the person's words) and the popup (`.rate-card`: the five steps, the
// tag chips, Details, a dimension, the words field, the where note and Withdraw),
// each with the classes the page gives it, in Obsidian and in Porcelain. A
// `data-nlb="label"` marks every element that is measured; a surface fails if any of
// them draws an accent.
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

// ── Rating U2: the markup is what daimond.js builds (`rateGroup`, `rateDress`,
// `rateDressTags`, `appendRatingLine`, `openRatePopup`), reduced to its classes.
// `host: 'chat'` puts the stage inside `#chat-output`, because some rules (the chip
// row's padding, the selecting hide) are written against it.
const IC   = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const GRP  = (up, dn, more) => '<span class="ctile-rate" data-chrome="rate" role="group" aria-label="Rate this answer">'
	+ `<button type="button" class="ctile-rate-up" aria-pressed="${up}" data-nlb="up (${up ? 'lit' : 'unlit'})">${IC}</button>`
	+ `<button type="button" class="ctile-rate-down" aria-pressed="${dn}" data-nlb="down (${dn ? 'lit' : 'unlit'})">${IC}</button>`
	+ `<button type="button" class="ctile-rate-more${more ? ' on' : ''}" aria-haspopup="dialog" data-nlb="details (${more ? 'on' : 'off'})">${IC}</button></span>`;
const TIME = '<span class="ctile-time"><span class="ctile-time-full">02026-10-01 12:00:00</span><span class="ctile-time-short">26-10-01 12:00</span></span>';
const TILE = (type, who, meta, lblMid, body, after) => `<div class="ctile csel-unit${type === 'reply' ? ' chat-msg-assistant' : ''}" data-t="${type}" data-dir="${type === 'rating' ? 'local' : 'from'}" data-mid="nlb-${type}" data-nlb="${type} tile">`
	+ `<div class="ctile-lbl" data-nlb="${type} label bar"><span class="ctile-dot"></span><span class="ctile-who">${who}</span><span class="ctile-meta">${meta}</span><span class="ctile-grow"></span><span class="ctile-peek"></span>${lblMid}${TIME}`
	+ '<span class="ctile-ctl"><button type="button" class="ctile-copy">' + IC + '</button><span class="ctile-chk"></span></span></div>'
	+ `<div class="ctile-body"><div class="chat-msg-content">${body}</div></div>${after}</div>`;
const SEG  = (cls, label, words, on, attrs = '') => `<div class="tile-dlg-seg ${cls}" role="group" data-nlb="${label}"${attrs}>`
	+ words.map((w, i) => `<button type="button" class="tile-dlg-level" aria-pressed="${i === on}" data-nlb="${label}: ${w}${i === on ? ' (pressed)' : ''}">${w}</button>`).join('') + '</div>';
const U2 = {
	'rated answer tile (lit, phone row, chip row)': { host: 'chat', html:
		TILE('reply', 'Daimond', 'fast', GRP(true, false, true), '<p>An answer.</p>',
			'<div class="ctile-rate-row" data-chrome="rate" data-nlb="phone row">' + GRP(false, true, false) + '</div>'
			+ SEG('ctile-rate-tags', 'chip row', ['Wrong', 'Ignored', 'Long'], 0, ' data-chrome="rate"')) },
	'rated answer tile (up and details lit)': { host: 'chat', html:
		TILE('reply', 'Daimond', 'fast', GRP(true, false, true), '<p>An answer.</p>', '') },
	'rating tile': { host: 'chat', html:
		TILE('rating', 'You', '', '', '<p class="rate-line" data-nlb="rate line"><span class="rate-score" data-nlb="rate score">−2</span> on <button type="button" class="rate-jump-link" data-nlb="jump link">the answer of 10:04</button> · Long · <span class="rate-said" data-nlb="rate said">“Just the command.”</span></p>'
			+ '<p class="rate-line"><span class="rate-score">+1</span> on <button type="button" class="rate-jump-link">the answer of 10:06</button></p>', '') },
	'rate popup (.rate-card)': { host: 'body', html:
		'<div class="modal dlg tile-dlg"><div class="modal-card dlg-card tile-dlg-card rate-card" role="dialog" aria-modal="true" data-nlb="popup card">'
		+ '<div class="ui-head"><h2>Rate this answer</h2><button type="button" class="ui-close tile-dlg-done" data-nlb="popup close">' + IC + '</button></div>'
		+ '<div class="rate-body"><div class="tile-dlg-head">Score</div>' + SEG('rate-scale', 'five steps', ['Wrong', 'Poor', 'Fine', 'Good', 'Great'], 0)
		+ '<div class="rate-tagbox"><div class="tile-dlg-head">Tags</div>' + SEG('ctile-rate-tags', 'popup chips', ['Ignored', 'Long', 'Style'], 1) + '</div>'
		+ '<details class="tile-dlg-adv" open data-nlb="details box"><summary class="tile-dlg-head tile-dlg-adv-sum" data-nlb="details summary">Details</summary>'
		+ '<div class="tile-dlg-field rate-dim" data-nlb="dimension"><span class="tile-dlg-label">Correct</span>' + SEG('', 'dimension steps', ['0', '1', '2', '3', '4'], 1) + '</div>'
		+ '<label class="tile-dlg-label rate-said-label" for="nlb-said">Your words</label><textarea id="nlb-said" class="rate-said-input" rows="3" data-nlb="words field">Too long.</textarea></details>'
		+ '<div class="tile-dlg-note rate-where" data-nlb="where note">Goes to the model it was rated on.</div>'
		+ '<div class="tile-dlg-actions"><button type="button" class="rate-clear tile-keep" data-nlb="withdraw">Withdraw</button></div></div></div></div>' },
};

// Every `[data-nlb]` element in the stage is measured; the surface is bad if any one of them draws an accent.
const measure = (name) => {
	const stage = document.getElementById('nlb-stage');
	const one = (el) => {
		const cs = getComputedStyle(el);
		const bw = { l: parseFloat(cs.borderLeftWidth) || 0, t: parseFloat(cs.borderTopWidth) || 0, r: parseFloat(cs.borderRightWidth) || 0, b: parseFloat(cs.borderBottomWidth) || 0 };
		// A bar on any one side: some side 2px or more, and the four not equal.
		const leftOnly = (bw.l > 0 && bw.l !== bw.t) || (Math.max(bw.l, bw.t, bw.r, bw.b) >= 2 && !(bw.l === bw.t && bw.t === bw.r && bw.r === bw.b));
		// Chromium's computed order is "<color> <x> <y> <blur> <spread> inset".
		// A left bar is x != 0, y == 0, blur == 0, inset present.
		const m = /^\S+\(.*?\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+inset/.exec(cs.boxShadow || '');
		const shadowBar = !!m && parseFloat(m[1]) !== 0 && parseFloat(m[2]) === 0 && parseFloat(m[3]) === 0;
		return { label: el.getAttribute('data-nlb') || el.className, leftOnly, shadowBar, borderLeftWidth: bw.l, borderTopWidth: bw.t, borderRightWidth: bw.r, boxShadow: cs.boxShadow };
	};
	const all = [...stage.querySelectorAll('[data-nlb]')].map(one);
	const bad = all.filter((r) => r.leftOnly || r.shadowBar);
	return { name, n: all.length, bad };
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

// One stage, moved to where the surface wants it: the body, or `#chat-output` (rules written against it).
const runSurface = async (name, html, host, tag) => {
	await ev(page, ([html, host]) => {
		let stage = document.getElementById('nlb-stage');
		if (!stage) { stage = document.createElement('div'); stage.id = 'nlb-stage'; }
		const to = host === 'chat' ? document.getElementById('chat-output') : document.body;
		if (stage.parentElement !== to) to.appendChild(stage);
		stage.innerHTML = html;
	}, [html, host]);
	await page.waitForTimeout(50);
	const r = await ev(page, measure, name);
	if (r.err) { fails++; console.log('  FAIL ' + tag + name + ' -- ' + r.err); return; }
	if (r.bad.length) fails++;
	console.log((r.bad.length ? '  FAIL ' : '  ok   ') + tag + name + (r.n > 1 ? ` (${r.n} measured)` : '')
		+ r.bad.map((b) => ` -- ${b.label}: borderLeftWidth=${b.borderLeftWidth} borderTopWidth=${b.borderTopWidth} borderRightWidth=${b.borderRightWidth} boxShadow=${b.boxShadow}`).join(''));
};
for (const [name, html] of Object.entries(SURFACES)) await runSurface(name, html, 'body', '');
// Rating U2, in both looks (the 5.2.6 gate reads Obsidian and Porcelain).
for (const look of ['obsidian', 'porcelain']) {
	await ev(page, (l) => window.DaimondTheme.set(l), look);
	await page.waitForTimeout(300);
	for (const [name, u] of Object.entries(U2)) await runSurface(name, u.html, u.host, look + ': ');
}
await s.close();
console.log(fails ? `FAIL: ${fails} left bar(s) found` : 'PASS: no left bars');
process.exit(fails ? 1 : 0);
