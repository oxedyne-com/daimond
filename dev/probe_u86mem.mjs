// probe_u86mem.mjs -- UNBLOCK-86 U86-MEM: where a long-lived Daimond tab's memory goes.
//
// One page on this world's mock. Each cycle sends a turn (the transcript grows) and redraws
// the page the way a day of sync pulls and settings saves does (a locale round trip, which
// fires every DaimondI18n.onChange listener). After each cycle it forces a full GC and samples
// Blink's live node and document counters against the nodes actually in the document, and the
// JS heap. A node Blink still holds that is not in the document after a full GC is retained.
// At the end it writes a heap snapshot for dev/u86_retainers.mjs.
//
//   eval "$(bash dev/world.sh N --up)"; ... node dev/probe_u86mem.mjs [cycles] [snapshot-path]
import fs from 'node:fs';
import { open, chat } from './harness.mjs';

const CYCLES = Number(process.argv[2] || 12);
const SNAP   = process.argv[3] || '';
const s = await open({ realClock: true });
const cdp = await s.browser.newCDPSession(s.page);
await cdp.send('HeapProfiler.enable');

async function sample(label) {
	await cdp.send('HeapProfiler.collectGarbage');
	await cdp.send('HeapProfiler.collectGarbage');
	const c = await cdp.send('Memory.getDOMCounters');
	const d = await s.page.evaluate(() => {
		let text = 0; const w = document.createTreeWalker(document, NodeFilter.SHOW_TEXT); while (w.nextNode()) text++;
		const el = document.getElementsByTagName('*').length;
		const ml = document.getElementById('models-list');
		return { inDoc: el + text, el, models: ml ? ml.getElementsByTagName('*').length : -1,
			chat: (document.getElementById('chat-output') || document.body).getElementsByTagName('*').length,
			heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576) };
	});
	const row = { label, nodes: c.nodes, docs: c.documents, listeners: c.jsEventListeners, ...d, held: c.nodes - d.inDoc };
	console.log('SAMPLE ' + JSON.stringify(row));
	return row;
}

const rows = [await sample('start')];
for (let i = 1; i <= CYCLES; i++) {
	await chat(s, `cycle ${i}: say something about memory`);
	if (process.env.U86_LOCALE !== '0') await s.page.evaluate(async () => {
		const I = window.DaimondI18n; const was = I.locale ? I.locale() : 'en';
		await I.setLocale(was === 'en' ? 'fr' : 'en'); await I.setLocale(was);
	});
	rows.push(await sample('cycle ' + i));
}
const a = rows[1], b = rows[rows.length - 1], n = rows.length - 2;
console.log('GROWTH per cycle ' + JSON.stringify({ held: ((b.held - a.held) / n).toFixed(0), docs: ((b.docs - a.docs) / n).toFixed(2),
	inDoc: ((b.inDoc - a.inDoc) / n).toFixed(0), heapMB: ((b.heapMB - a.heapMB) / n).toFixed(2) }));
if (SNAP) {
	const out = fs.openSync(SNAP, 'w');
	cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => fs.writeSync(out, e.chunk));
	await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
	fs.closeSync(out);
	console.log('SNAPSHOT ' + SNAP);
}
await s.browser.close();
