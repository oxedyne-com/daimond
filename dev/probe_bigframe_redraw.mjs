// probe_bigframe_redraw.mjs -- UNBLOCK-47 (27 Oct): gilgamesh's page froze while it followed a
// handed-off turn on a 558-message, ~2 MB thread. Every streamed frame redrew the WHOLE thread
// (`renderHistory`'s rebuild), and the frame carrying the runner's `fold_log` was the last the page
// drew. This drives the asker's own frame path on such a thread and bounds the work per frame.
//
// One page, in a world: the page's daimond.js is served with its frame path named on
// `window.__lp` (as dev/turn_parity.mjs's seam does), a ~550-message chat is put on screen with a
// turn handed to a runner that holds the lease, and frames of 5 rows arrive, the way the runner's
// door carries them: the newest rows, the first of them the row the last frame ended on, grown
// (a tool's result, the answer's next tokens). One frame mid-way carries a `fold_log` (folded > 0).
// Sharing is on, so the lens's page observer (`debugshare.js` uiWatch) sees what the frame did.
//
// Per frame it measures: the synchronous ms of `onProgressFrame` plus the layout it forces, the
// thread's direct children removed (a full redraw removes them all), the mutation records the
// lens's observer would get, and the ms of one lens scan (`_uiScan`). Then it asks whether the
// redraw settles: an idle `renderHistory` of the unchanged thread must remove nothing.
//
// Gates (exit 1 on any): no frame redraws the thread; no frame's records exceed REC_MAX;
// the idle redraw removes nothing; what the frames drew equals a whole rebuild of the messages.
//
//   source ~/.cache/daimond/w90.env; node dev/probe_bigframe_redraw.mjs
import { open, newChat } from './harness.mjs';

const N_MSGS   = 550;			// the thread's length before the turn, as his was (558)
const N_FRAMES = Number(process.env.FRAMES || 8);
const FOLD_AT  = 4;			// the frame whose rows carry the runner's `fold_log`
const REC_MAX  = 400;			// lens observer records per frame: a frame touches its rows, not the thread

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// The page's frame path, named before its closure ends. Nothing in it is stubbed.
const EXPOSE = '\nwindow.__lp = { onProgressFrame: onProgressFrame, renderHistory: renderHistory,\n'
	+ '\trebuildDispatchedIndex: rebuildDispatchedIndex, updateExpedite: updateExpedite,\n'
	+ '\tchat: function () { return current; }, self: function () { return selfDeviceId(); },\n'
	+ '\twatched: function () { return _progressWatched; },\n'
	+ '\trebuild: function () { _renderSynced = false; renderHistory(current.messages); } };\n';
const route = async (pg) => pg.route(/\/js\/daimond\.js(\?.*)?$/, async (r) => {
	const res = await r.fetch();
	const body = await res.text();
	const at = body.lastIndexOf('})();');
	await r.fulfill({ response: res, body: at < 0 ? body : body.slice(0, at) + EXPOSE + body.slice(at) });
});

const s = await open({ name: 'lostapp', route, connect: false });
const pg = s.page;
try {
	await pg.waitForFunction(() => !!(window.__lp && window.DaimondPeer && window.DaimondLease), null, { timeout: 20000 });
	await newChat(s);
	const tid = 'lp' + Date.now().toString(36) + '-7-tst-rt';
	const setup = await pg.evaluate(([n, tid]) => {
		const T = window.__lp, c = T.chat(), self = T.self(), now = Date.now();
		const para = (i, k) => Array.from({ length: k }, (_, j) => 'Paragraph ' + j + ' of message ' + i
			+ ': the quick brown fox jumps over the lazy dog, and the **thread** keeps growing with `code` and words. ').join('\n\n');
		const ms = [];
		let t = now - 6 * 3600e3;
		for (let i = 0; ms.length < n; i++) {
			const it = 'h' + i;
			ms.push({ role: 'user', content: 'Question ' + i + ': ' + para(i, 1), mid: it, ts: t += 1000 });
			ms.push({ role: 'tool_log', name: 'file_read', args: JSON.stringify({ path: 'src/f' + i + '.rs' }),
				content: para(i, 30), outcome: 'done', mid: it + 't', iturn: it, callId: 'c' + i, ts: t += 1000 });
			ms.push({ role: 'assistant', content: para(i, 40), mid: it + 'a', iturn: it, ts: t += 1000 });
			if (i % 60 === 59) ms.push({ role: 'fold_log', content: 'Summary of the work so far.', folded: 40, kept: 12,
				mid: it + 'f', iturn: it, ts: t += 1000 });
		}
		ms.length = n;
		ms.push({ role: 'user', content: 'Carry on with the edit.', mid: tid, ts: now - 20000 });
		ms.push({ role: 'assistant', content: '', interrupted: true, why: 'dispatched', iturn: tid, mid: tid + '-ph',
			itext: 'Carry on with the edit.', dispatchedBy: self, toDevice: 'dev-runner', toName: 'argonaut',
			claimedBy: 'dev-runner', ts: now - 20000, deadline: now + 3600e3 });
		// The runner holds the turn's lease, as kdu5d0t4 held his.
		const rec0 = DaimondLease.record;
		DaimondLease.record = (k) => String(k) === tid
			? { turnId: tid, holder: 'dev-runner', mode: 'run', expiry: Date.now() + 60000, renewedAt: Date.now() - 5000 }
			: rec0(k);
		const hold0 = DaimondLease.holder;
		DaimondLease.holder = (k) => String(k) === tid ? 'dev-runner' : hold0(k);
		c.messages = ms;
		c._loaded = true;
		T.rebuildDispatchedIndex();
		T.updateExpedite();
		T.renderHistory(c.messages);
		const bytes = JSON.stringify(ms).length;
		return { n: ms.length, bytes, kids: document.getElementById('chat-output').children.length,
			watched: !!T.watched()[tid] };
	}, [N_MSGS, tid]);
	console.log('thread: ' + setup.n + ' messages, ' + (setup.bytes / 1e6).toFixed(2) + ' MB, '
		+ setup.kids + ' tiles; the turn watched: ' + setup.watched);
	check('the turn is watched (its frames reach the page)', setup.watched);
	// The lens is on, as it was on gilgamesh: its page observer runs over every frame.
	const lens = await pg.evaluate(() => { try { window.DEBUG_SHARE.setEnabled(true); } catch (e) { return String(e); }
		return window.DEBUG_SHARE.isOn(); });
	console.log('lens sharing on: ' + lens);

	const rows = [];
	let seq = 0, mid = 0, last = null;
	const frameRows = (k) => {
		const out = [];
		// The row the last frame ended on, grown: the tool's result, or the answer's next tokens.
		if (last) { last = { ...last, content: last.content + ' more output for frame ' + k + '.' }; out.push(last); }
		while (out.length < 5) {
			const i = mid++;
			const r = (k === FOLD_AT && out.length === 2)
				? { role: 'fold_log', content: 'The runner folded the turn so far.', folded: 30, kept: 10 }
				: i % 2 ? { role: 'tool_log', name: 'shell', args: '{"cmd":"cargo check"}', content: 'checking ' + i, outcome: 'done', callId: 'r' + i }
				: { role: 'assistant', content: 'Working on step ' + i + '.' };
			out.push({ ...r, mid: tid + '-r' + i, ts: Date.now() });
		}
		last = out[out.length - 1];
		return out;
	};
	for (let k = 0; k < N_FRAMES; k++) {
		const msgs = frameRows(k);
		const m = await pg.evaluate(([tid, seq, msgs]) => {
			const out = document.getElementById('chat-output');
			const kids0 = out.children.length;
			let removed = 0, recs = 0;
			const mo = new MutationObserver(() => {});
			mo.observe(out, { childList: true });
			const lo = new MutationObserver(() => {});
			lo.observe(document.body, { childList: true, subtree: true, characterData: true,
				attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
			const t0 = performance.now();
			window.__lp.onProgressFrame(tid, { seq, final: false, tail: JSON.stringify({ v: 1, msgs }) });
			void document.body.offsetHeight;
			const ms = performance.now() - t0;
			mo.takeRecords().forEach((r) => { removed += r.removedNodes.length; });
			recs = lo.takeRecords().length;
			mo.disconnect(); lo.disconnect();
			let scan = 0;
			try { const s0 = performance.now(); window.DEBUG_SHARE._uiScan(); scan = performance.now() - s0; } catch (e) { scan = -1; }
			return { ms, removed, kids0, kids: out.children.length, recs, scan,
				heap: performance.memory ? performance.memory.usedJSHeapSize : 0 };
		}, [tid, ++seq, msgs]);
		const full = m.removed >= m.kids0 / 2;
		m.full = full;
		rows.push(m);
		console.log(`  frame ${k}${k === FOLD_AT ? ' (fold_log)' : ''}: ${m.ms.toFixed(0)} ms, removed ${m.removed}/${m.kids0} tiles`
			+ `${full ? ' FULL REDRAW' : ''}, lens records ${m.recs}, lens scan ${m.scan.toFixed(0)} ms`);
		await pg.waitForTimeout(200);
	}
	const fulls = rows.filter((r) => r.full).length;
	const worst = Math.max(...rows.map((r) => r.ms));
	const recMax = Math.max(...rows.map((r) => r.recs));
	console.log(`summary: ${fulls}/${rows.length} frames redrew the thread; worst frame ${worst.toFixed(0)} ms; `
		+ `mean ${(rows.reduce((a, r) => a + r.ms, 0) / rows.length).toFixed(0)} ms; most lens records ${recMax}`);
	check('no frame redraws the whole thread', fulls === 0, fulls + ' of ' + rows.length);
	check('no frame gives the lens observer more than ' + REC_MAX + ' records', recMax <= REC_MAX, String(recMax));
	// THE REDRAW SETTLES: the thread unchanged, a store-driven redraw draws nothing.
	const idle = await pg.evaluate(() => {
		const out = document.getElementById('chat-output');
		let removed = 0;
		const mo = new MutationObserver(() => {});
		mo.observe(out, { childList: true });
		window.__lp.renderHistory(window.__lp.chat().messages);
		mo.takeRecords().forEach((r) => { removed += r.removedNodes.length; });
		mo.disconnect();
		return removed;
	});
	check('an idle redraw of the unchanged thread removes nothing (it settles)', idle === 0, 'removed ' + idle);
	// WHAT THE FRAMES DREW IS WHAT A WHOLE REBUILD DRAWS: the thread's markup, and the turn
	// numbers and fold marks on it, match a from-scratch draw of the same messages.
	const same = await pg.evaluate(() => {
		const out = document.getElementById('chat-output');
		const read = () => Array.from(out.children).map((k) => k.outerHTML);
		const a = read();
		window.__lp.rebuild();
		const b = read();
		let at = -1;
		for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { at = i; break; }
		return { n: a.length, m: b.length, at, a: at < 0 ? '' : String(a[at]).slice(0, 300), b: at < 0 ? '' : String(b[at]).slice(0, 300) };
	});
	check('the drawn thread equals a whole rebuild of the same messages', same.at < 0,
		same.at < 0 ? same.n + ' tiles' : `tiles ${same.n} vs ${same.m}, first difference at ${same.at}:\n    drawn:   ${same.a}\n    rebuilt: ${same.b}`);
} catch (e) {
	console.log('probe error: ' + (e && e.stack || e));
	bad.push('probe error');
} finally {
	await s.close();
}
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
