// verify_panelstate.mjs — a conversation's panels come back with it (UNBLOCK-14, D-20261015-17).
//
// WHAT HAPPENED. *"Panel state is not kept when switching between daimons and chats."* Leaving a
// conversation closed its Doc and Preview and remembered nothing, and a file a daimon showed while
// its conversation was off screen was TAKEN once on arrival: it showed, then was gone after the
// next switch away and back (diag_c §2, reproduced on world 97 step for step).
//
// THE PROPERTY, in a real page with two chats A and B:
//   1. A→B→A per panel kind: the Doc file, the Preview file, the Web page and the Terminal panel
//      each leave the screen with A and come back with A, and none of them shows in B.
//   2. A file shown for A while B is on screen survives TWO round trips (it was taken once).
//   3. A Web page opened for A while B is on screen does not take B's screen, and is there on A.
//
// RED on c295864b at 1 (Doc, Preview, Web), 2 and 3. Chromium pre-deploy; WebKit after.
//   eval "$(bash dev/world.sh 97 --up)"; node dev/verify_panelstate.mjs

import { open, newChat } from './harness.mjs';

const ok = [], bad = [];
function check(name, pass, detail) {
	(pass ? ok : bad).push(name);
	console.log((pass ? 'ok   ' : 'FAIL ') + name + (detail ? '  -- ' + detail : ''));
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let s;
try {
	s = await open({ name: 'panelstate' + Date.now().toString(36) });
	const p = s.page;
	// His widest desk (argonaut): room for Doc and Preview beside the thread at once.
	await p.setViewportSize({ width: 3440, height: 1321 });
	await p.evaluate(async (png) => {
		const root = await DaimondCloud.opfsRoot();
		const put = async (n, body) => {
			const w = await (await root.getFileHandle(n, { create: true })).createWritable();
			await w.write(body); await w.close();
		};
		await put('a_doc.md', '# A\n' + 'line\n'.repeat(200));
		await put('a_pic.png', Uint8Array.from(atob(png), (c) => c.charCodeAt(0)));
		await put('a_page.html', '<h1>A page</h1>');
		await put('later_page.html', '<h1>Later</h1>');
		await put('shown_by_A.md', '# shown by A');
	}, PNG);

	const A = await newChat(s);
	const B = await newChat(s);
	const go = async (id) => {
		await p.locator(`.session-box[data-id="${id}"]`).first().click();
		await p.waitForTimeout(1500);
	};
	const state = () => p.evaluate(() => {
		const vis = (e) => !!e && !!(e.offsetWidth || e.offsetHeight);
		const nm = document.getElementById('doc-name');
		const pv = document.getElementById('pv-name');
		const w = window.DaimondWeb ? DaimondWeb.status() : {};
		return {
			doc: vis(document.getElementById('panel-doc')) ? (nm ? nm.textContent.trim() : '(empty)') : '',
			preview: vis(document.getElementById('panel-preview')) ? (pv ? pv.textContent.trim() : '(empty)') : '',
			web: DaimondPanels.isOpen('web') ? (w.url || '(none)') : '',
			term: DaimondPanels.isOpen('term'),
		};
	});
	const has = (v, want) => typeof v === 'string' && v.indexOf(want) !== -1;

	// ── 1. Every panel kind, A→B→A ──────────────────────────────────────
	// In two passes, because the stage seats only so many panels beside the thread
	// (`stageMax`: three at 3440, fewer at 1920) and closes the newest past that, by
	// design. Asking for all four at once made the control itself drop one, and run 1
	// read that as "the Terminal does not come back" when A had never held it.
	const seats = await p.evaluate(() => DaimondPanels.snapshot().stage.length);
	const pass = async (label, setup, want) => {
		await go(A);
		await p.evaluate(() => ['doc', 'preview', 'web', 'term'].forEach((id) => DaimondPanels.userHide(id)));
		await p.evaluate(setup, A);
		await p.waitForTimeout(1200);
		const a0 = await state();
		check('[ctl] ' + label + ': open in A', want.every(([k, v]) => v === true ? a0[k] === true : has(a0[k], v)),
			JSON.stringify(a0) + ' seats at start ' + seats);
		await go(B);
		const b0 = await state();
		for (const [k, v] of want) check('B does not show A\'s ' + k, v === true ? !b0[k] : !has(b0[k], v), JSON.stringify(b0));
		await go(A);
		const a1 = await state();
		for (const [k, v] of want) check('back in A: the ' + k + ' is back', v === true ? a1[k] === true : has(a1[k], v), JSON.stringify(a1));
		// And only those: a panel the person closed in A before leaving stays closed.
		const kept = want.map(([k]) => k);
		check('back in A: nothing closed in A comes back', ['doc', 'preview', 'web', 'term']
			.filter((k) => kept.indexOf(k) === -1).every((k) => !a1[k]), JSON.stringify(a1));
	};
	await pass('Doc, Preview and Terminal', async (A) => {
		await DaimondDoc.show('a_doc.md', 0, 'chat:' + A);
		await DaimondDoc.show('a_pic.png', 0, 'chat:' + A);
		DaimondPanels.show('term');
	}, [['doc', 'a_doc.md'], ['preview', 'a_pic.png'], ['term', true]]);
	await pass('Web and Terminal', async () => {
		await DaimondWeb.open('a_page.html');
		DaimondPanels.show('term');
	}, [['web', 'a_page.html'], ['term', true]]);

	// Close them in A, so the next part starts from nothing of A's.
	await p.evaluate(() => {
		['doc', 'preview', 'web', 'term'].forEach((id) => DaimondPanels.userHide(id));
	});
	await p.waitForTimeout(500);

	// ── 2. A file shown for A while B is on screen survives two round trips ──
	await go(B);
	const r = JSON.parse(await p.evaluate((A) => DaimondDoc.show('shown_by_A.md', 0, 'chat:' + A), A));
	check('[ctl] the show for A is not drawn over B', r.shown === false, JSON.stringify(r));
	const b1 = await state();
	check('B is left as it was', !has(b1.doc, 'shown_by_A.md'));
	for (const trip of [1, 2, 3]) {
		await go(A);
		const st = await state();
		check('round trip ' + trip + ': A shows the file its turn showed while away',
			has(st.doc, 'shown_by_A.md'), JSON.stringify(st));
		await go(B);
	}

	// ── 3. A Web page opened for A while B is on screen ──────────────────
	const before = await state();
	const w = await p.evaluate((A) => DaimondWeb.open('later_page.html', 'chat:' + A), A);
	const b2 = await state();
	check('the page for A does not take B\'s screen', w.shown === false && !has(b2.web, 'later_page.html')
		&& b2.web === before.web, JSON.stringify(w) + ' ' + JSON.stringify(b2));
	await go(A);
	const a2 = await state();
	check('in A the page is open in the Web panel', has(a2.web, 'later_page.html'), JSON.stringify(a2));
	await go(B);
	await go(A);
	const a3 = await state();
	check('and it is still there after another round trip', has(a3.web, 'later_page.html'), JSON.stringify(a3));
} catch (e) {
	check('verifier ran', false, String(e && e.stack || e).slice(0, 600));
} finally {
	try { await s?.close(); } catch (e) { /* gone */ }
	console.log('\n' + ok.length + ' passed, ' + bad.length + ' failed' + (bad.length ? ': ' + JSON.stringify(bad) : ''));
	process.exit(bad.length ? 1 : 0);
}
