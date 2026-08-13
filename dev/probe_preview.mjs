// probe_preview.mjs — a look at the source/preview split while it is being built.
import { open, shot } from './harness.mjs';

const s = await open({ name: 'previewprobe', connect: false });
const p = s.page;
await p.setViewportSize({ width: 2400, height: 950 });
await p.waitForTimeout(1200);

// A text file and a PDF, both real.
await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool('file_write', JSON.stringify({ path: 'notes.md', content: '# Notes\n\nhello\n' }));
	// A minimal but genuinely openable PDF.
	const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
		+ '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
		+ '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
		+ 'trailer<</Root 1 0 R>>\n%%EOF\n';
	const bytes = new Uint8Array([...pdf].map((c) => c.charCodeAt(0)));
	await app.write_bytes('paper.pdf', bytes);
});

const geom = () => p.evaluate(() => {
	const st = document.getElementById('stage');
	return {
		seats: [...st.children].filter((k) => k.getClientRects().length)
			.map((k) => (k.dataset.panel || 'handle') + ':' + Math.round(k.getBoundingClientRect().width)),
		docName: (document.getElementById('doc-name') || {}).textContent,
		pvName:  (document.getElementById('pv-name') || {}).textContent,
		docBody: !!document.querySelector('#doc-view .files-view-body'),
		pvEmbed: !!document.querySelector('#pv-view .fileview embed'),
		lineno:  (document.getElementById('doc-lineno') || {}).style.display,
	};
});

await p.evaluate(() => window.DaimondDoc.show('notes.md'));
await p.waitForTimeout(900);
console.log('after notes.md ', JSON.stringify(await geom()));

await p.evaluate(() => window.DaimondDoc.show('paper.pdf'));
await p.waitForTimeout(1500);
console.log('after paper.pdf', JSON.stringify(await geom()));

await shot(s, "probe-preview-split");
console.log('errors:', s.errs.filter((e) => !/502|Bad Gateway/.test(e)).slice(0, 8));
await s.close();
