// A look at the New Facet dialog, with two providers seeded.
import { open, shot } from './harness.mjs';
import http from 'node:http';

function provider(port, models) {
	const srv = http.createServer((req, res) => {
		// The key rides in an `authorization` header, which makes the browser preflight. Without
		// an answer to OPTIONS the fetch never happens at all.
		if (req.method === 'OPTIONS') {
			res.writeHead(204, {
				'access-control-allow-origin': '*',
				'access-control-allow-headers': '*',
				'access-control-allow-methods': 'POST, GET, OPTIONS',
			});
			return res.end();
		}
		res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
		res.end(JSON.stringify({ data: models.map(id => ({ id })) }));
	});
	srv.listen(port, '127.0.0.1');
	return srv;
}
const a = provider(9111, ['llama-3.3-70b-instruct', 'qwen-2.5-coder-32b']);
const b = provider(9112, ['deepseek-v3', 'llama-3.3-70b-instruct']);

const s = await open({ name: 'focusdlg', connect: false });
const p = s.page;
await p.waitForTimeout(1200);
await p.evaluate(async () => {
	const M = window.DaimondModels;
	M.addProvider('fireworks', { name: 'Fireworks AI', url: 'http://127.0.0.1:9111/v1/chat/completions' });
	M.addProvider('groq',      { name: 'Groq',         url: 'http://127.0.0.1:9112/v1/chat/completions' });
	await M.setKey('fireworks', 'k1');
	await M.setKey('groq', 'k2');
	await M.fetchModels('fireworks');
	await M.fetchModels('groq');
	M.setDefault('fireworks', 'llama-3.3-70b-instruct');
});
await p.waitForTimeout(500);
await p.click('#new-facet-btn');
await p.waitForSelector('.dlg-select', { timeout: 8000 });
// Open the pulldown so the grouping is visible in the shot.
await p.click('.dlg-select');
await p.waitForTimeout(400);
await shot(s, 'focus-dialog');
console.log(await p.evaluate(() => {
	const sel = document.querySelector('.dlg-select');
	return [...sel.querySelectorAll('optgroup')]
		.map(g => g.label + ': ' + [...g.querySelectorAll('option')].map(o => o.textContent).join(', '))
		.join('\n');
}));
await s.close();
a.close(); b.close();
