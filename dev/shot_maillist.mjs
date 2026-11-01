// shot_maillist.mjs -- the Mail panel's list as he saw it on 1 Nov 2026 (UNBLOCK-79), drawn by
// the REAL www/js/mail.js and www/css of a tree, over an in-page store: an inbox of 860 whose
// older half is in cloud storage, and the draft "Test email" to emma@example.com.
//
//   node dev/shot_maillist.mjs <tree> <out-dir> [prefix]
//
// <tree> is a checkout of this app (its www/ is served), so the same script shoots the base and
// the fix. It writes <prefix>inbox.png, <prefix>drafts.png (the Drafts folder, where the tree has
// one) and <prefix>discarded.png (after Discard on the draft row).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { chromium } = await import('./pw.mjs');

function chrome() {
	if (process.env.DAIMOND_CHROME) return process.env.DAIMOND_CHROME;
	const root = path.join(os.homedir(), '.cache/ms-playwright');
	let best = null;
	for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
		const n = parseInt(d.slice('chromium-'.length), 10);
		const exe = path.join(root, d, 'chrome-linux64', 'chrome');
		if (d.startsWith('chromium-') && fs.existsSync(exe) && (!best || n > best.n)) best = { n, exe };
	}
	if (!best) throw new Error('No playwright chromium under ' + root + '; set DAIMOND_CHROME.');
	return best.exe;
}

const [tree, outDir, prefix = ''] = process.argv.slice(2);
if (!tree || !outDir) { console.error('usage: node dev/shot_maillist.mjs <tree> <out-dir> [prefix]'); process.exit(2); }
const WWW = path.resolve(tree, 'www');
fs.mkdirSync(outDir, { recursive: true });

const PAGE = `<!doctype html><html lang="en" data-skin="night"><head><meta charset="utf-8">
<link rel="stylesheet" href="css/variables.css"><link rel="stylesheet" href="css/app.css">
<link rel="stylesheet" href="css/mail.css">
<style>body{margin:0;background:var(--bg-primary)} #panel-mail{position:static;width:380px;height:1240px;display:flex;flex-direction:column;overflow:auto}</style>
</head><body>
<aside class="panel mail" id="panel-mail"><div class="railhead"><span>Email</span></div>
<div class="mail-card"><div class="mail-state" id="mail-state"></div><div class="mail-accounts" id="mail-accounts"></div>
<div class="mail-folders" id="mail-folders"></div><div class="mail-list" id="mail-list"></div></div></aside>
<script>
const ADDR = 'hoogland@gmail.com', CUR = 'mail/' + ADDR + '/INBOX/cur';
const files = new Map(), away = new Map();
const msg = (f, s, d) => 'From: ' + f + '\\r\\nTo: ' + ADDR + '\\r\\nSubject: ' + s + '\\r\\nDate: ' + d
	+ '\\r\\nMessage-ID: <' + s.replace(/\\W/g, '') + '@k.test>\\r\\n\\r\\nHi.\\r\\n';
files.set(CUR + '/860.7.daimond:2,S', msg('Kraig Hoogland <k@k.test>', 'Gutters', 'Sat, 31 Oct 2026 21:57:00 +0800'));
files.set(CUR + '/859.7.daimond:2,S', msg('Bunnings <news@bunnings.test>', 'Spring catalogue', 'Sat, 31 Oct 2026 09:12:00 +0800'));
files.set(CUR + '/858.7.daimond:2,', msg('Westpac <alerts@westpac.test>', 'Your statement is ready', 'Fri, 30 Oct 2026 18:40:00 +0800'));
const old = [['Ann Lee <a@a.test>', 'Invoice 1142', 'Tue, 13 Oct 2026 09:00:00 +0800'],
	['Synergy <bills@synergy.test>', 'Electricity bill', 'Mon, 12 Oct 2026 08:00:00 +0800'],
	['Dan Wu <d@d.test>', 'Visit on Sunday', 'Sat, 10 Oct 2026 18:00:00 +0800'],
	['Cat <c@c.test>', 'Tickets', 'Thu, 08 Oct 2026 08:00:00 +0800'],
	['RAC <rac@rac.test>', 'Renewal notice', 'Tue, 06 Oct 2026 10:30:00 +0800'],
	['Bob <b@b.test>', 'Lunch', 'Mon, 05 Oct 2026 12:00:00 +0800'],
	['ATO <ato@ato.test>', 'Notice of assessment', 'Fri, 02 Oct 2026 15:00:00 +0800'],
	['Emma <e@e.test>', 'Photos', 'Thu, 01 Oct 2026 19:00:00 +0800']];
old.forEach((o, i) => away.set(CUR + '/' + (857 - i) + '.7.daimond:2,S', msg(o[0], o[1], o[2])));
files.set('mail/' + ADDR + '/drafts/draft-1.eml',
	'From: ' + ADDR + '\\r\\nTo: emma@example.com\\r\\nSubject: Test email\\r\\nDate: Sun, 01 Nov 2026 09:30:00 +0800\\r\\n\\r\\nHi.\\r\\n');
localStorage.setItem('daimond-mail', JSON.stringify({ sel: ADDR, accounts: [{ address: ADDR, host: 'imap.gmail.com',
	port: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465, user: ADDR, pass: 'w', folder: 'Sent', touched: Date.now() }] }));
const enc = new TextEncoder(), dec = new TextDecoder();
window.store = { files, away };
window.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s };
const FOLDERS = [{ name: 'INBOX', role: '', selectable: true, delimiter: '/' },
	{ name: '[Gmail]', role: '', selectable: false, delimiter: '/' },
	{ name: '[Gmail]/Drafts', role: 'drafts', selectable: true, delimiter: '/' },
	{ name: '[Gmail]/Sent Mail', role: 'sent', selectable: true, delimiter: '/' },
	{ name: '[Gmail]/Trash', role: 'trash', selectable: true, delimiter: '/' }];
window.DaimondGateway = { state: () => ({ authed: true }), noteBalance() {},
	gwFetch: async (p) => ({ status: 200, ok: true, json: async () => (p === '/api/mail/folders'
		? { ok: true, folders: FOLDERS } : { ok: true, unlocked: true, accounts: [], messages: [] }) }) };
// One message's fetch fails, so a row shows its reason and Retry.
window.DaimondCloud = { fetch: async (p) => {
	await new Promise((r) => setTimeout(r, 50));
	if (/852\\./.test(p)) return 'Error: the cloud storage allowance for this month is used up.';
	if (!away.has(p)) return 'Error: ' + p + ' is not in cloud storage.';
	files.set(p, away.get(p)); away.delete(p); return 'OK';
} };
window.mailDeps = {
	showCompose() {}, showMessage() {}, confirm: async () => true, openFile() {}, refreshFiles() {}, showDoc() {},
	writeBytes: async (p, b) => { files.set(p, dec.decode(b)); },
	readText:   async (p) => { if (!files.has(p)) throw new Error('not found'); return files.get(p); },
	readBytes:  async (p) => { if (!files.has(p)) throw new Error('not found'); return enc.encode(files.get(p)); },
	runTool: async (name, args) => {
		if (name === 'file_list') {
			const pre = args.path.replace(/\\/$/, '') + '/';
			const of = (m, tail) => [...m.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length))
				.filter((k) => !k.includes('/')).map((n) => '- ' + n + ' (12 bytes' + tail + ')');
			return { outcome: 'done', text: of(files, '').concat(of(away, ', in cloud storage')).join('\\n') };
		}
		if (name === 'file_delete') { files.delete(args.path); return { outcome: 'done', text: '' }; }
		if (name === 'file_write') { files.set(args.path, args.content); return { outcome: 'done', text: '' }; }
		return { outcome: 'done', text: '' };
	},
};
</script>
<script src="js/i18n.js"></script><script src="i18n/en.js"></script><script src="js/stamp.js"></script><script src="js/quiet.js"></script><script src="js/mail.js"></script>
</body></html>`;

const browser = await chromium.launch({ executablePath: chrome() });
try {
	const page = await browser.newPage({ viewport: { width: 380, height: 1240 } });
	await page.route('http://shot.local/**', (r) => {
		const u = new URL(r.request().url());
		if (u.pathname === '/maillist.html') return r.fulfill({ contentType: 'text/html', body: PAGE });
		const f = path.join(WWW, decodeURIComponent(u.pathname));
		if (!f.startsWith(WWW) || !fs.existsSync(f)) return r.fulfill({ status: 404, body: '' });
		const type = f.endsWith('.css') ? 'text/css' : f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
		return r.fulfill({ contentType: type, body: fs.readFileSync(f) });
	});
	page.on('pageerror', (e) => console.error('page:', e.message));
	await page.goto('http://shot.local/maillist.html');
	const settle = (ms = 600) => page.waitForTimeout(ms);
	await page.evaluate(async () => {
		const M = window.DaimondMail;
		M.init(window.mailDeps);
		await M.reload();
		M.onOpen();
		await new Promise((r) => setTimeout(r, 300));
		await M.loadFolders('hoogland@gmail.com', true);
		await M.selectFolder('INBOX');
		await M.refreshDrafts();
		M.reload();
	});
	await settle(1500);
	await page.screenshot({ path: path.join(outDir, prefix + 'inbox.png') });
	console.log('wrote', path.join(outDir, prefix + 'inbox.png'));
	const drafts = page.locator('#mail-folders [data-role="drafts"]');
	if (await drafts.count()) {
		await drafts.first().click();
		await settle();
	}
	await page.screenshot({ path: path.join(outDir, prefix + 'drafts.png') });
	console.log('wrote', path.join(outDir, prefix + 'drafts.png'));
	const x = page.locator('.mail-draft-discard');
	if (await x.count()) {
		await x.first().click();
		await settle();
		await page.screenshot({ path: path.join(outDir, prefix + 'discarded.png') });
		console.log('wrote', path.join(outDir, prefix + 'discarded.png'));
	} else console.log('no Discard on a draft row in this tree');
} finally {
	await browser.close();
}
