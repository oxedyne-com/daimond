// verify_feedreports.mjs — the operator console's report queue drawing a FEED
// report: the post id, the words, and the one act that differs from a message
// report -- "Remove post" instead of a bare "Uphold", because the only way this
// panel reaches 'upheld' for a feed row is by taking the post down.
//
// THE WIRE IS MOCKED AND SAID TO BE MOCKED. `admin.rs reports_read`/`reports_write`
// growing `kind` and `post_id`, and taking `remove:true`, is lane A's and is not
// built in this tree yet (feed plan §4.2) -- every `/api/admin` answer below is
// this file's own, on the contract the plan publishes. So nothing here is
// evidence that the gateway does any of it; it is evidence that THIS PANEL draws
// what the contract says a feed row is, and sends what the contract says Remove
// sends. The real-gateway run happens at integration, alongside verify_admin.
//
// What is proved, and each is a thing that goes wrong silently:
//
//   1. A FEED ROW NAMES THE POST. `kind:'feed'` draws a pill with the post id,
//      beside the reason -- the only handle an operator has on what to remove,
//      since there is no envelope or artefact behind a feed report.
//   2. THE WORDS ARE THE GATEWAY'S OWN READ, drawn the same way a message's are.
//   3. THE CHECK BUTTON DOES NOT OFFER TO OPEN A CIPHERTEXT THAT DOES NOT EXIST.
//      A feed report carries no envelope/artefact/ckey, so Check is not drawn.
//   4. REMOVE IS ONE DECISION, NOT TWO. A feed row's 'upheld' move reads "Remove
//      post" and sends `{status:'upheld', remove:true}` -- never a bare Uphold
//      that leaves the post standing under an upheld report.
//   5. ONCE REMOVED, THE ROW SAYS SO AND KEEPS THE WORDS as the evidence record.
//
//   node dev/verify_feedreports.mjs

import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const APP  = process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`;

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const procs = [];
function launch(cmd, args, opts) {
	const p = spawn(cmd, args, opts);
	procs.push(p);
	return p;
}
function cleanup() {
	for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} }
}
async function waitFor(fn, ms = 20000, gap = 300) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}

// ── The two report rows the mock gateway holds ──────────────────────
//
// One of each kind, so every assertion below has a control to fail against:
// a check that only ever looked at the feed row could not tell "feed rows
// are drawn right" from "every row is drawn that way".
const FEED_ROW = {
	id: 'rp_feed_1',
	status: 'new',
	kind: 'feed',
	post_id: 42,
	subject: 'acct_a',
	subject_handle: 'amber-fox-9k2q',
	reason: 'spam',
	reporter: 'acct_b',
	reporter_handle: 'quiet-heron-22aa',
	filed_ts: Math.floor(Date.now() / 1000) - 3600,
	filed_n: 1,
	body: 'Buy cheap watches now, link in bio.',
};
const MESSAGE_ROW = {
	id: 'rp_msg_1',
	status: 'new',
	kind: 'message',
	subject: 'acct_c',
	subject_handle: 'brisk-otter-77zz',
	reason: 'threat',
	reporter: 'acct_d',
	reporter_handle: 'plain-wren-11qq',
	filed_ts: Math.floor(Date.now() / 1000) - 7200,
	filed_n: 1,
	body: 'A threatening message.',
	envelope: 'AAAA',
	artefact: 'AAAA',
	ckey: 'AAAA',
};

let removeCalls = [];
let rows = [FEED_ROW, MESSAGE_ROW];

function reportsAnswer() {
	const upheld = rows.filter(r => r.status === 'upheld').length;
	const dismissed = rows.filter(r => r.status === 'dismissed').length;
	const fresh = rows.filter(r => r.status === 'new').length;
	return { ok: true, reports: rows, total: rows.length, new: fresh, upheld, dismissed };
}

async function routeAdmin(route) {
	const req = route.request();
	const u = new URL(req.url());
	const view = u.searchParams.get('view');
	if (view === 'whoami') {
		return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
			ok: true, account_id: 'acct_owner', client_fp: 'FPOWNER01',
			role: 'owner', can_grant: true,
		}) });
	}
	if (view === 'reports') {
		if (req.method() === 'POST') {
			let body = {};
			try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
			removeCalls.push(body);
			rows = rows.map(r => {
				if (r.id !== body.id) return r;
				const next = Object.assign({}, r, { status: body.status || r.status });
				if (body.remove) next.body = r.body;	// stays as evidence
				next.decided_by = 'owner';
				next.decided_ts = Math.floor(Date.now() / 1000);
				return next;
			});
			return route.fulfill({ status: 200, contentType: 'application/json',
				body: JSON.stringify(reportsAnswer()) });
		}
		return route.fulfill({ status: 200, contentType: 'application/json',
			body: JSON.stringify(reportsAnswer()) });
	}
	// Every other view: answered fast and refused, so a panel that is not
	// under test here fails quietly into its own status line rather than
	// hanging this run on an unmocked fetch.
	return route.fulfill({ status: 200, contentType: 'application/json',
		body: JSON.stringify({ ok: false, error: 'not mocked' }) });
}

// ── Reading one row out of the DOM ──────────────────────────────────
async function rowInfo(page, id) {
	return page.evaluate((rid) => {
		const row = document.querySelector(`.admin-rel-row[data-report-id="${rid}"]`);
		if (!row) return null;
		const btns = Array.from(row.querySelectorAll('.admin-rel-actions button'))
			.map(b => b.textContent.trim());
		return {
			pills: Array.from(row.querySelectorAll('.admin-pill')).map(p => p.textContent.trim()),
			body: (row.querySelector('.admin-rp-body') || {}).textContent || '',
			buttons: btns,
			removedNote: Array.from(row.querySelectorAll('.admin-rel-sub'))
				.some(d => d.textContent.indexOf('Removed from the feed.') >= 0),
		};
	}, id);
}

// ── Main ─────────────────────────────────────────────────────────────
(async () => {
	let already = false;
	try { already = (await fetch(`${APP}/console/`)).ok; } catch (e) {}
	if (!already) launch('node', ['dev/serve.mjs'], { cwd: ROOT, stdio: 'ignore' });
	const serveUp = await waitFor(async () => (await fetch(`${APP}/console/`)).ok, 10000);
	check('dev server serves /console/', serveUp);
	if (!serveUp) { cleanup(); console.log(`\n${ok.length} passed, ${bad.length} failed`); process.exit(1); }

	const { chromium } = await import(pathToFileURL(PW).href);
	const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
	try {
		const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
		await page.route('**/api/admin*', routeAdmin);

		await page.goto(`${APP}/console/#reports`, { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('#admin-app:not([hidden])', { timeout: 10000 });
		await page.waitForSelector('#view-reports:not([hidden])', { timeout: 10000 });
		await page.waitForSelector('.admin-rel-row', { timeout: 10000 }).catch(() => {});
		await sleep(300);

		const feed = await rowInfo(page, FEED_ROW.id);
		const msg  = await rowInfo(page, MESSAGE_ROW.id);
		check('a feed report row rendered', !!feed, JSON.stringify(feed));
		check('a message report row rendered as a control', !!msg, JSON.stringify(msg));

		if (feed) {
			check('the feed row names the post id',
				feed.pills.some(p => p === 'feed post #42'), feed.pills.join(' | '));
			check('the feed row carries the words the gateway read',
				feed.body.indexOf(FEED_ROW.body) >= 0, feed.body);
			check('the feed row offers no Check button (there is no ciphertext to open)',
				!feed.buttons.includes('Check'), feed.buttons.join(' | '));
			check('the feed row offers Remove post beside Dismiss, and no bare Uphold',
				feed.buttons.includes('Remove post') && feed.buttons.includes('Dismiss')
					&& !feed.buttons.includes('Uphold'),
				feed.buttons.join(' | '));
		}
		if (msg) {
			check('a message row is not marked as a feed post',
				!msg.pills.some(p => p.indexOf('feed post') >= 0), msg.pills.join(' | '));
			check('a message row keeps its Check button, as a control on the feed row above',
				msg.buttons.includes('Check'), msg.buttons.join(' | '));
			check('a message row keeps the ordinary Uphold, unlike the feed row',
				msg.buttons.includes('Uphold'), msg.buttons.join(' | '));
		}

		// Press Remove post, and read what actually travelled.
		removeCalls = [];
		await page.evaluate((rid) => {
			const row = document.querySelector(`.admin-rel-row[data-report-id="${rid}"]`);
			const btn = Array.from(row.querySelectorAll('.admin-rel-actions button'))
				.find(b => b.textContent.trim() === 'Remove post');
			if (btn) btn.click();
		}, FEED_ROW.id);
		await waitFor(() => removeCalls.length > 0, 5000);
		check('Remove post sent one call', removeCalls.length === 1, JSON.stringify(removeCalls));
		if (removeCalls.length) {
			const c = removeCalls[0];
			check('the call names the report and asks for removal',
				c.id === FEED_ROW.id && c.status === 'upheld' && c.remove === true,
				JSON.stringify(c));
		}

		await sleep(400);
		const after = await rowInfo(page, FEED_ROW.id);
		check('the removed row keeps the words as evidence',
			after && after.body.indexOf(FEED_ROW.body) >= 0, after && after.body);
		check('the removed row says it was removed',
			after && after.removedNote, JSON.stringify(after));
		check('the removed row no longer offers Remove post again',
			after && !after.buttons.includes('Remove post'), after && after.buttons.join(' | '));
	} catch (e) {
		check('browser run completed without throwing', false, e.message);
	} finally {
		await browser.close();
	}

	cleanup();
	console.log(`\n${ok.length} passed, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
