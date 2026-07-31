// verify_grant.mjs — the Daimond Hands grant flow, driven under the real
// extension (xvfb, headed).
//
// Approving a site touches three surfaces, and a user meets them in this order:
//
//	1. the grant WINDOW the extension raises — what is being asked, what
//	   granting covers, and that Chrome will ask once more;
//	2. the TOOLBAR — the icon and its popup, the standing surface, which must
//	   say a question is waiting and offer the way back to it if the window
//	   was lost behind something;
//	3. the TOOL RESULT the daimon reads when the answer is no — which has to
//	   distinguish "the user declined" from "nobody answered", because the
//	   first means stop asking and the second means ask again.
//
// We cannot click Chrome's own permission bubble from a test — that is the known
// coverage gap, and it is the step AFTER Allow — but everything up to it, and
// every refusal path, is driven here for real. Run with:
//   xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_grant.mjs
import { open, errors, shot } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const EXT = path.resolve('ext');
const SHOTS = path.resolve('dev/shots');
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'grant', headed: true, extension: EXT });
// Give the extension's announce content-script a moment to register.
await s.page.waitForTimeout(1500);

const sw = s.browser.serviceWorkers()[0];
check('the broker service worker started', !!sw);
const extId = sw ? new URL(sw.url()).host : '';

/// Ask the page to open a site, without awaiting it: the call BLOCKS until the
/// human has answered. What it finally settles to is the tool result the daimon
/// reads, so it is stashed on the window for us to collect afterwards.
async function askFor(url) {
	await s.page.evaluate((u) => {
		window.__grant = { done: false, err: null, res: null };
		window.DaimondWeb.open(u)
			.then((r) => { window.__grant = { done: true, res: r, err: null }; })
			.catch((e) => { window.__grant = { done: true, res: null, err: String((e && e.message) || e) }; });
	}, url);
	for (let i = 0; i < 40; i++) {
		await s.page.waitForTimeout(250);
		for (const p of s.browser.pages()) if (/grant\.html/.test(p.url())) return p;
	}
	return null;
}

/// What the tool call finally answered.
async function toolResult() {
	for (let i = 0; i < 80; i++) {
		const g = await s.page.evaluate(() => window.__grant);
		if (g && g.done) return g;
		await s.page.waitForTimeout(250);
	}
	return { done: false };
}

/// The extension's own popup, opened as a page. It is the standing surface: what
/// mode the extension is in, what it is waiting for, and what may be revoked.
async function popup() {
	const p = await s.browser.newPage();
	await p.goto(`chrome-extension://${extId}/popup.html`);
	await p.waitForTimeout(700);
	return p;
}

const grant = await askFor('https://example.com');

// ── Surface 1: the grant window ─────────────────────────────────────

check('the grant window opens', !!grant,
	grant ? '' : 'no grant.html page appeared: ' + s.browser.pages().map((p) => p.url()).join(', '));

if (grant) {
	await grant.waitForLoadState('domcontentloaded');
	await grant.waitForTimeout(400);
	const info = await grant.evaluate(() => {
		const txt = (id) => ((document.getElementById(id) || {}).textContent || '');
		return { head: txt('head'), host: txt('host'), scope: txt('scope'), body: txt('body'), fine: txt('fine'), allow: txt('allow'), deny: txt('deny') };
	});
	check('it names the site it is asking about', /example\.com/.test(info.host), info.host);
	check('it sets the expectation that Chrome asks next',
		/Chrome/.test(info.fine) && /confirm in Chrome/i.test(info.allow), info.allow);
	// The grant is `*://*.host/*` — the site AND its subdomains, both schemes. A
	// window that shows the bare host alone is asking for more than it says.
	check('it says the approval covers subdomains',
		/subdomain/i.test(info.scope + info.body + info.fine), JSON.stringify(info.scope));
	check('refusing is offered in plain words', /not now|no/i.test(info.deny), info.deny);
	fs.mkdirSync(SHOTS, { recursive: true });
	await grant.screenshot({ path: path.join(SHOTS, 'grant-window.png') }).catch(() => {});
}

// The centring of that window is the whole reason it is seen at all, and it is
// best-effort in a try/catch — so a misspelled API fails silently and for ever.
// Check the source against the real API surface rather than the symptom.
if (sw) {
	const missing = await sw.evaluate(async () => {
		const src = await (await fetch(chrome.runtime.getURL('background.js'))).text();
		const out = [];
		for (const m of src.matchAll(/chrome\.(\w+)\.(\w+)\s*\(/g)) {
			const ns = chrome[m[1]];
			if (!ns) { out.push(m[1]); continue; }
			if (typeof ns[m[2]] !== 'function') out.push(m[1] + '.' + m[2]);
		}
		return [...new Set(out)];
	});
	check('the broker calls no browser API that does not exist', missing.length === 0, missing.join(', '));
}

// ── Surface 2: the toolbar, while the question is pending ───────────

if (sw) {
	const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
	check('the toolbar icon marks that a question is waiting', !!badge.trim(), JSON.stringify(badge));
	const title = await sw.evaluate(() => chrome.action.getTitle({}));
	check('the icon tooltip names the site being asked about', /example\.com/.test(title), title);
}

if (extId) {
	const p = await popup();
	const reply = await p.evaluate(() => chrome.runtime.sendMessage({ type: 'panel' }).then((r) => r, (e) => ({ ok: false, threw: String(e) })));
	check('the popup gets an answer from the broker', !!(reply && reply.ok), JSON.stringify(reply));
	const text = await p.evaluate(() => document.body.innerText);
	check('the popup says a site is waiting to be approved', /example\.com/.test(text), text.replace(/\n/g, ' / '));
	const raise = await p.evaluate(() => {
		const b = document.getElementById('raise');
		return b && !b.hidden ? b.textContent : '';
	});
	check('the popup offers a way back to the approval window', !!raise, JSON.stringify(raise));
	// It RAISES the window that is already open. A second window per ask is the
	// popup flood the mirror guard exists to prevent.
	const before = s.browser.pages().filter((q) => /grant\.html/.test(q.url())).length;
	const raised = await p.evaluate(() => chrome.runtime.sendMessage({ type: 'raise' }));
	await p.waitForTimeout(400);
	const after = s.browser.pages().filter((q) => /grant\.html/.test(q.url())).length;
	check('that way back reaches the waiting window', !!(raised && raised.ok), JSON.stringify(raised));
	check('and it opens no second window', after === before, `${before} -> ${after}`);
	// One question at a time: the broadest permission Chrome has is not offered
	// beside a site question the user has not answered yet.
	const mirrorShown = await p.evaluate(() => {
		const b = document.getElementById('mirror');
		return !!(b && !b.hidden);
	});
	check('the mirror is not offered while a site question is waiting', !mirrorShown);
	await p.screenshot({ path: path.join(SHOTS, 'grant-popup-pending.png') }).catch(() => {});
	await p.close();
}

// ── Surface 3: the refusal, as the daimon reads it ──────────────────

if (grant) {
	await grant.click('#deny');
}
const declined = await toolResult();
check('declining ends the tool call', declined.done && !!declined.err, JSON.stringify(declined));
check('the tool result says the USER declined',
	/user (declined|said no)|declined/i.test(declined.err || ''), declined.err);
check('it names the site that was refused', /example\.com/.test(declined.err || ''), '');
check('it tells the daimon what to do instead', /web_fetch/.test(declined.err || ''), '');
check('it tells the daimon not to keep asking', /not (retry|ask)|do not ask/i.test(declined.err || ''), declined.err);

if (sw) {
	const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
	check('the toolbar mark clears once the question is answered', !badge.trim(), JSON.stringify(badge));
}

// A window closed without an answer is NOT a refusal: the user may never have
// seen it. The daimon must be able to tell the two apart.
const dismissable = await askFor('https://example.org');
check('a second site raises its own question', !!dismissable);
if (dismissable) {
	await dismissable.close();
}
const dismissed = await toolResult();
check('closing the window unseen ends the tool call', dismissed.done && !!dismissed.err, JSON.stringify(dismissed));
check('the tool result says the window was closed, not that the user refused',
	/closed/i.test(dismissed.err || '') && !/user declined/i.test(dismissed.err || ''), dismissed.err);
check('it still says the site is not approved', /not approved/i.test(dismissed.err || ''), '');

// ── The standing popup, with nothing pending ────────────────────────

if (extId) {
	const p = await popup();
	const text = await p.evaluate(() => document.body.innerText);
	check('the popup paints its state when nothing is pending', /idle|driving/i.test(text), text.replace(/\n/g, ' / '));
	// Chrome reports the extension's OWN manifest origins among its permissions.
	// The user never granted those and cannot revoke them, so a list that shows
	// them claims a grant that was never given and offers a button that cannot act.
	check('it lists no grant the user did not give',
		!/localhost|127\.0\.0\.1|daimond\.oxedyne/.test(text), text.replace(/\n/g, ' / '));
	check('it says no site has been approved yet', /none yet/i.test(text), '');
	check('it is no longer asking about a site', !/example\.com/.test(text), '');
	await p.screenshot({ path: path.join(SHOTS, 'grant-popup-idle.png') }).catch(() => {});
	await p.close();
}

// The panel note the human reads, after a refusal.
await shot(s, 'grant-panel-declined');
const note = await s.page.evaluate(() => (document.getElementById('web-note') || {}).innerText || '');
console.log('\npanel note after refusal:\n  ' + note.replace(/\n/g, '\n  '));

// The account service is not what this exercises, and it may be absent (502) or
// present but unentitled for a throwaway identity (401, 402). Either is noise
// here; anything else the page logged is not.
const errs = errors(s).filter((e) => !/Failed to load resource.*\b(401|402|502|503)\b/.test(e));
check('the app logged no console errors', errs.length === 0, errs.join(' | '));

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
await s.close();
process.exit(bad.length ? 1 : 0);
