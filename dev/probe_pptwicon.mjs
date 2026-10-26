// probe_pptwicon.mjs — is the play/pause icon drawn at a size on a WebKit phone?
//
// THE FAULT (daimond-mail-b's render matrix, 26 Oct; the owner's iPhone). The
// shared control's <svg class="pptw-ic"> carried a viewBox and no size, so WebKit
// laid it out at 0x0 inside the 36px phone button and Chromium at its 300x150
// default, clipped. The icon takes its size by role in app.css; this asserts it.
//
// Every surface that mounts the control is measured, not only the one in view:
// the rail's global row and the web panel are real nodes in index.html; the
// rest (a Diamond's tile header, its dialog, a trigger pick, and the four Email
// panel rows) are built from their real classes and given the real widget from
// `DaimondUI.pauseWidget`, so a rule scoped to one host cannot pass for all.
//
//   eval "$(node dev/rig/gateclock.mjs env probe_pptwicon)"
//   DAIMOND_LEASE_BAND=66-80 node dev/probe_pptwicon.mjs [--engine chromium]
import { open } from './harness.mjs';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const i = process.argv.indexOf('--engine');
const ENGINE = i > 0 ? process.argv[i + 1] : 'webkit';

// No sign-in: a WebKit device boots only once paired (it has no file store), and
// the control's drawing and CSS are loaded at the gate already.
const s = await open({ name: 'pptwicon', browser: ENGINE, touch: true, signIn: false, connect: false,
	viewport: { width: 390, height: 844 },
	ua: ENGINE === 'webkit'
		? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
			+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
		: null,
	isMobile: ENGINE === 'chromium' });
const p = s.page;
// The app's CSS is what is under test and it is loaded at the gate. The real
// widget comes from `DaimondUI.pauseWidget` once the app is up; on a WebKit
// device that is not paired it is not, so its DOM is built here exactly as
// pauseWidget builds it (span.pptw > button.pptw-act > svg.pptw-ic, viewBox only).
await p.waitForFunction(() => document.readyState === 'complete', null, { timeout: 30000 });
await p.waitForTimeout(1500);

const rows = await p.evaluate(() => {
	// Host chains: outermost first. Each is the class path the widget sits in.
	const real = !!(window.DaimondUI && window.DaimondPause);
	const mk = () => {
		// A leaf by its own id: not in the tree, so it always governs and is drawn.
		if (real) return DaimondUI.pauseWidget(DaimondPause.id('root', 'diamonds', 'probe-pptwicon'), 'x');
		const g = document.createElement('span');
		g.className = 'pptw';
		for (const act of ['play', 'pause']) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'pptw-act pptw-' + act;
			b.innerHTML = '<svg class="pptw-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 3.2 13.5 8 5.2 12.8z"/></svg>';
			g.appendChild(b);
		}
		const lamp = document.createElement('span');
		lamp.className = 'pptw-lamp';
		g.appendChild(lamp);
		return g;
	};
	const hosts = {
		'tile header':     ['session-box', 'session-box-header'],
		'tile dialog':     ['tile-dlg-pause'],
		'trigger pick':    ['trig-pick'],
		'mail account':    ['mail-acct'],
		'mail globals':    ['mail-globals'],
		'mail self':       ['mail-tile mail-tile-self'],
		'mail folder':     ['mail-tile'],
	};
	const stage = document.createElement('div');
	stage.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:var(--bg-primary)';
	document.body.appendChild(stage);
	const out = [];
	const measure = (label, root) => {
		const ics = root.querySelectorAll('.pptw-ic');
		if (!ics.length) { out.push({ label, w: -1, h: -1, bw: -1, bh: -1 }); return; }
		ics.forEach((ic) => {
			const r = ic.getBoundingClientRect();
			const b = ic.closest('.pptw-act').getBoundingClientRect();
			out.push({ label, w: r.width, h: r.height, bw: b.width, bh: b.height });
		});
	};
	// The two real slots. The rail is shown so its row is laid out.
	if (real) try { DaimondPanels.show('web'); } catch (e) { /* not on this build */ }
	out.push({ label: real ? 'widget: DaimondUI.pauseWidget' : 'widget: built as pauseWidget builds it', w: 1, h: 1, bw: 1, bh: 1 });
	for (const id of ['pptw-global', 'web-pause']) {
		const el = document.getElementById(id);
		if (!el) { out.push({ label: id + ' (missing)', w: -1, h: -1, bw: -1, bh: -1 }); continue; }
		// A hidden or still-empty slot reads nothing whatever the CSS says; measure it in place
		// when shown, and in a copy of its own head row otherwise.
		if (el.getClientRects().length && el.querySelector('.pptw-ic')) { measure('#' + id, el); continue; }
		const row = document.createElement('div');
		row.className = id === 'pptw-global' ? 'pptw-head' : (el.parentElement && el.parentElement.className) || '';
		const slot = document.createElement('span');
		slot.className = 'pptw-slot';
		slot.appendChild(mk());
		row.appendChild(slot);
		stage.appendChild(row);
		measure('#' + id + ' (hidden in place, measured in its row)', row);
	}
	for (const [label, chain] of Object.entries(hosts)) {
		let parent = stage;
		for (const cls of chain) {
			const d = document.createElement('div');
			d.className = cls;
			parent.appendChild(d);
			parent = d;
		}
		const w = mk();
		if (w) parent.appendChild(w);
		measure(label, stage.lastElementChild);
	}
	stage.remove();
	return out;
});

let bad = 0;
for (const r of rows) {
	// Drawn, and inside its own button: a 0x0 icon is the WebKit fault, one
	// larger than its box is the Chromium one.
	const ok = r.w > 0 && r.h > 0 && r.w <= r.bw && r.h <= r.bh;
	if (!ok) bad++;
	console.log((ok ? 'PASS ' : 'FAIL ') + r.label.padEnd(48) + ` icon ${r.w}x${r.h} in button ${r.bw}x${r.bh}`);
}
console.log(`${ENGINE}: ${rows.length - bad}/${rows.length} icons sized`, s.errs.length ? 'errors: ' + s.errs.slice(0, 3) : '');
await s.close();
process.exit(bad || !rows.length ? 1 : 0);
