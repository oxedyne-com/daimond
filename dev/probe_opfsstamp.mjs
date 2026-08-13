// probe_opfsstamp.mjs — does an OPFS file keep the same `lastModified` when nobody
// writes it?
//
// The live view decides a source has changed by asking every watched file for
// `lastModified` and `size` and comparing the answer with last time's. That is the
// only mechanism there is — the File System Access API has no change events — so if
// a browser hands back a fresh time on every `getFile()`, the watch loop rebuilds
// once a second with nothing edited, which is exactly what the author reported and
// what headless Chromium here does NOT do. So ask each engine, with no app in the
// way: one file, written once, asked five times over five seconds.
//
// It asserts nothing and is not a verifier.
//
//     eval "$(bash dev/world.sh 5 --env)"
//     node dev/probe_opfsstamp.mjs                 # every engine that is installed
//     node dev/probe_opfsstamp.mjs chromium webkit
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const pw = await import(pathToFileURL(PW).href);
const APP = process.env.DAIMOND_APP || 'http://localhost:8777';

const want = process.argv.slice(2).filter(a => !a.startsWith('-'));
const engines = (want.length ? want : ['chromium', 'firefox', 'webkit']);

const SCRIPT = async () => {
	const out = { steps: [] };
	try {
		const root = await navigator.storage.getDirectory();
		const h = await root.getFileHandle('stampprobe.txt', { create: true });
		const w = await h.createWritable();
		await w.write('one');
		await w.close();
		for (let i = 0; i < 5; i++) {
			const f = await h.getFile();
			out.steps.push({ at: i, lastModified: f.lastModified, size: f.size });
			await new Promise(r => setTimeout(r, 1000));
		}
	} catch (e) {
		out.error = String(e && e.message ? e.message : e);
	}
	return out;
};

for (const name of engines) {
	const type = pw[name];
	if (!type) { console.log(`${name}: not in playwright-core`); continue; }
	let b;
	try {
		b = await type.launch({ headless: true });
	} catch (e) {
		console.log(`${name}: will not launch — ${String(e.message).split('\n')[0]}`);
		continue;
	}
	try {
		const p = await b.newPage();
		await p.goto(APP + '/index.html', { waitUntil: 'domcontentloaded' });
		const r = await p.evaluate(SCRIPT);
		if (r.error) { console.log(`${name}: ${r.error}`); }
		else {
			const st = r.steps.map(s => s.lastModified);
			const same = st.every(v => v === st[0]);
			console.log(`${name}: lastModified ${same ? 'STABLE' : 'MOVES'} — ${st.join(', ')}`);
			if (!same) console.log('    → a watch loop on this engine rebuilds on every poll');
		}
		const ua = await p.evaluate(() => navigator.userAgent);
		console.log(`    ${ua}`);
	} catch (e) {
		console.log(`${name}: ${String(e.message).split('\n')[0]}`);
	}
	await b.close();
}
