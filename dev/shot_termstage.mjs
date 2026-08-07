// shot_termstage.mjs — look at the Terminal in its new zone.
//
// The panel moved from the dock to the stage, and the two are laid out by
// different rules: a dock panel fills a 300px column of a tiled grid, a stage
// panel takes a seat beside the conversation and is sized inline by the engine.
// What that change is worth cannot be read off a passing assertion — the screen
// is the artefact — so this opens a live session against the same two doubles
// dev/verify_termpanel.mjs uses, writes something into it, and takes the picture
// at the widths that matter. The narrow one is the point of the whole move: below
// 1900px the dock's automatic grid is ONE column of four, so a fifth panel there
// could only arrive by closing one of the four already in it.
//
// It also measures, because an eye is not a ruler: the terminal's box against the
// panel it lives in, the grid the kernel was last told, and how many panels the
// dock is actually seating.
//
//	node dev/shot_termstage.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099).

import { open, shot } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await open({ name: 'termstage' });
const p = s.page;

/// The link double: what hand.js is asked to provide, and nothing more.
async function installLink() {
	await p.evaluate(() => {
		window.__link = { sent: [], subs: {}, opens: 0 };
		const fire = (id, msg) => (window.__link.subs[id] || []).slice().forEach((f) => f(msg));
		window.__emit = fire;
		window.DaimondHand = {
			send(m) {
				window.__link.sent.push(m);
				if (m.t === 'open') {
					window.__link.opens++;
					setTimeout(() => fire(m.id, { t: 'opened', pid: 4242 }), 0);
				}
				if (m.t === 'signal') setTimeout(() => fire(m.id, { t: 'closed', exit: 0 }), 0);
				return Promise.resolve();
			},
			subscribe(id, fn) {
				(window.__link.subs[id] = window.__link.subs[id] || []).push(fn);
				return () => {};
			},
			status() {
				return Promise.resolve(JSON.stringify({
					paired: true, transport: 'machine', machine: 'double', os: 'linux',
					root: '/nowhere/ws', caps: ['fence:linux', 'landlock:abi-8'],
				}));
			},
			hasHand: () => true,
		};
	});
}

/// The Rust answer double. The fence is a fiction and nothing here reads it.
async function installComposer() {
	await p.evaluate(() => {
		window.DaimondTerm._setRequestForTest(async (json) => {
			const ask = JSON.parse(json);
			return JSON.stringify({
				t: 'open', id: 'ts-' + (++window.__seq || (window.__seq = 1)),
				argv: ['bash', '-i'], cwd: '/nowhere/ws', env: [],
				size: { cols: ask.cols, rows: ask.rows },
				fence: { rw: ['/nowhere/ws'], ro: [], deny: [], net: false },
			});
		});
	});
}

/// Push bytes at the live session the way the hand would.
async function write(text, seq) {
	const id = await p.evaluate(() => window.DaimondTerm.session());
	if (!id) return;
	await p.evaluate(({ id, text, seq }) => {
		const u8 = new TextEncoder().encode(text);
		let raw = '';
		for (const b of u8) raw += String.fromCharCode(b);
		window.__emit(id, { t: 'output', seq, data: btoa(raw) });
	}, { id, text, seq });
	await sleep(400);
}

/// The panel, the terminal inside it, and what the dock is holding.
const measure = () => p.evaluate(() => {
	const panel = document.getElementById('panel-term');
	const card  = panel && panel.querySelector('.termp-card');
	const host  = document.getElementById('termp-host');
	const term  = document.querySelector('#termp-host .term');
	const box   = (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
	return {
		zone:      panel && panel.dataset.zone,
		parent:    panel && panel.parentElement && (panel.parentElement.id || panel.parentElement.className),
		panel:     panel && box(panel),
		card:      card  && box(card),
		host:      host  && box(host),
		term:      term  && box(term),
		grid:      term  && { cols: +term.dataset.cols, rows: +term.dataset.rows },
		stage:     window.DaimondPanels.model().panels.filter((x) => x.zone === 'stage' && x.open).map((x) => x.id),
		dockOpen:  window.DaimondPanels.model().panels.filter((x) => x.zone === 'dock'  && x.open).map((x) => x.id),
		dockSeats: [...document.querySelectorAll('#dock .pcol > .panel')]
			.filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.dataset.panel),
		dockMax:   window.DaimondPanels.model().dockMax,
		lastSize:  (window.__link.sent.filter((m) => m.t === 'resize').pop() || {}).size || null,
	};
});

await installLink();
await installComposer();
await p.evaluate(() => window.DaimondPanels.show('term'));
await sleep(1200);
await write('$ ls -la\r\ntotal 24\r\ndrwxr-xr-x  5 you you 4096 Aug  3 00:14 .\r\n'
	+ 'drwxr-xr-x 18 you you 4096 Aug  3 00:12 ..\r\n-rw-r--r--  1 you you  221 Aug  3 00:13 notes.txt\r\n$ ', 0);

for (const [w, h] of [[1500, 950], [1440, 900], [1280, 820]]) {
	await p.setViewportSize({ width: w, height: h });
	await p.evaluate(() => window.DaimondPanels.reflow());
	await sleep(900);
	for (const theme of ['dark', 'light']) {
		await p.evaluate((t) => window.DaimondTheme.set(t), theme);
		await sleep(500);
		await shot(s, `termstage-${w}-${theme}`);
	}
	await p.evaluate(() => window.DaimondTheme.set('dark'));
	await sleep(400);
	console.log(`\n${w}x${h}: ` + JSON.stringify(await measure(), null, 1));
}

// And a resize that has to reach the kernel: drag the stage's own divider.
//
// At 1900 rather than at the laptop width, because MIN_W.stage is 380 for each
// seat and a 1440px window leaves the two of them about twenty pixels of play
// between them -- a correct clamp, and a useless demonstration.
await p.setViewportSize({ width: 1900, height: 950 });
await p.evaluate(() => window.DaimondPanels.reflow());
await sleep(900);
const before = await measure();
// A real drag, with the mouse, because the handle captures the pointer and a
// synthesised PointerEvent with no capture never reaches the engine's move.
{
	const box = await p.$eval('#handle-stage', (e) => {
		const r = e.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	await p.mouse.move(box.x, box.y);
	await p.mouse.down();
	await p.mouse.move(box.x - 90, box.y, { steps: 8 });
	await p.mouse.move(box.x - 180, box.y, { steps: 8 });
	await p.mouse.up();
}
await sleep(1200);
const after = await measure();
console.log('\nafter dragging the stage divider 180px left:');
console.log(' grid  ' + JSON.stringify(before.grid) + ' -> ' + JSON.stringify(after.grid));
console.log(' told  ' + JSON.stringify(before.lastSize) + ' -> ' + JSON.stringify(after.lastSize));
console.log(' term  ' + JSON.stringify(before.term) + ' -> ' + JSON.stringify(after.term));
await shot(s, 'termstage-1900-dragged');

// ── The phone ───────────────────────────────────────────────────────
//
// A stage panel on a phone is not a destination on the bottom bar: it RISES as a
// sheet over the conversation, so the daimon stays under the thing being worked
// in. The Terminal already did that as a dock panel with no seat; what changes
// with the zone is only that it is now doing it for the reason the others do.
//
// The sheet is also where the fit has to catch up: the panel is measured while
// it is still hidden behind the phone stylesheet, so the first grid is the 20x4
// minimum, and the terminal's own ResizeObserver is what turns it into the
// sheet's real size a moment later. That is the transition worth watching.
await p.setViewportSize({ width: 390, height: 844 });
await p.evaluate(() => window.DaimondPanels.hide('term'));
await sleep(600);
await p.evaluate(() => window.DaimondPanels.show('term'));
await sleep(1800);
const phone = await p.evaluate(() => {
	const panel = document.getElementById('panel-term');
	const term  = document.querySelector('#termp-host .term');
	const sheet = document.getElementById('msheet');
	const r = (e) => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
	return {
		inSheet:  !!(panel && panel.closest('#msheet')),
		sheetOpen: !!(sheet && sheet.classList.contains('open')),
		sheetTitle: (document.querySelector('.msheet-title') || {}).textContent,
		floor:    document.body.dataset.mpanel,
		barSeats: [...document.querySelectorAll('#mnav button')].map((b) => b.dataset.mp),
		panel:    panel && r(panel),
		term:     term && r(term),
		grid:     term && { cols: +term.dataset.cols, rows: +term.dataset.rows },
		told:     (window.__link.sent.filter((m) => m.t === 'resize').pop() || {}).size || null,
		// The panel's own name must not be said twice, once by the sheet and once
		// by the head inside it.
		nameShown: !!(panel && panel.querySelector('.chead .ctitle')
			&& getComputedStyle(panel.querySelector('.chead .ctitle')).display !== 'none'),
		startVisible: !!(panel && panel.querySelector('[data-act="term-start"]')
			&& getComputedStyle(panel.querySelector('[data-act="term-start"]')).display !== 'none'),
	};
});
console.log('\nphone 390x844: ' + JSON.stringify(phone, null, 1));
await shot(s, 'termstage-phone');

const noise = s.errs.filter((e) => !/favicon|ERR_ABORTED|502|Bad Gateway|net::ERR/i.test(e));
console.log('\nconsole: ' + (noise.length ? noise.slice(0, 4).join(' | ') : 'clean'));
await s.close();
