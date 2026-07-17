// verify/ext/background.js — the Daimond Verify service worker.
//
// On every load of a Daimond origin it re-checks the served build and colours
// the toolbar badge: a green tick means the code the browser just loaded is the
// published source and was sealed in the public log; a red cross means it is
// not; a query means it could not be sure (offline). The popup shows the detail.
//
// The check runs here, in installed code, against the site's own bytes and the
// log on GitHub — so the site being checked has no way to influence the verdict.

import { verifyOrigin } from './check.js';

// The origins this extension vouches for. Kept narrow on purpose: an extension
// that badged every site would teach the user to ignore the badge.
const MATCH = [
	/^https:\/\/daimond\.oxedyne\.com/,
	/^https?:\/\/(127\.0\.0\.1|localhost):8777/,
];

// Last verdict per tab, for the popup to read. Memory only.
const verdicts = {};

// Exposed for the tests, which drive the worker directly; unused in the field.
self.verifyOrigin = verifyOrigin;
self.__verdicts = verdicts;

function matched(url) { return !!url && MATCH.some(r => r.test(url)); }

async function configuredLog() {
	try { return (await chrome.storage.local.get('logUrl')).logUrl || undefined; }
	catch (e) { return undefined; }
}

async function setBadge(tabId, state) {
	const map = { busy: ['…', '#8a8a8a'], ok: ['✓', '#3a7d54'], no: ['✗', '#c0392b'], warn: ['?', '#c98a12'] };
	const m = map[state] || map.warn;
	try {
		await chrome.action.setBadgeText({ tabId, text: m[0] });
		await chrome.action.setBadgeBackgroundColor({ tabId, color: m[1] });
	} catch (e) { /* the tab may be gone */ }
}

async function run(tabId, url) {
	await setBadge(tabId, 'busy');
	let v;
	try {
		v = await verifyOrigin(new URL(url).origin, await configuredLog());
	} catch (e) {
		v = { ok: false, failed: false, build: '', bundle: '', checks: [{ name: 'check', ok: null, detail: String(e) }] };
	}
	verdicts[tabId] = { ...v, url, ts: Date.now() };
	await setBadge(tabId, v.ok ? 'ok' : v.failed ? 'no' : 'warn');
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
	if (info.status === 'complete' && matched(tab.url)) run(tabId, tab.url);
});

// A tab navigating away should not keep an old verdict's badge on a new page.
chrome.tabs.onRemoved.addListener((tabId) => { delete verdicts[tabId]; });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
	if (msg && msg.type === 'verdict') { reply(verdicts[msg.tabId] || null); return true; }
	if (msg && msg.type === 'recheck' && msg.tabId != null && msg.url) {
		run(msg.tabId, msg.url).then(() => reply(verdicts[msg.tabId] || null));
		return true;
	}
	return false;
});
