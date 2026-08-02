// verify_toolreload.mjs — does the model still know what it did, after a reload?
//
// A page reload used to amputate the agent's memory of its own tool use.
// `DaimondApp::restore` rebuilt a session from the transcript on SCREEN, which
// carries prose and nothing else: the assistant turns came back bare
// (`tool_calls: Vec::new()`) and the tool results were dropped outright. So a
// reloaded daimon saw what it had SAID and had no record of what it had read,
// written or run. It re-read files it had already read, and could claim work it
// could no longer check.
//
// It could not have carried them. An assistant turn bearing `tool_calls` must be
// followed by a `tool` reply for each one or the provider rejects the whole
// request — and the browser never sees the provider's call ids. It mints its own
// (`t1`, `t2`) for drawing the thread, and those pair with nothing.
//
// The fix keeps the ids in Rust: `export_session` / `restore_session` carry the
// session's own message list across the boundary, ids and all.
//
// WHAT IS ASSERTED, and against what. Not the app's belief about what it sent —
// the MOCK PROVIDER'S OWN LOG of what actually arrived (dev/mockllm.log). The
// pairing rule is re-implemented here, independently of the Rust that repairs
// it, and applied to every request in the log rather than to the one this test
// is about: a fix that makes turn two legal by making turn three illegal has
// fixed nothing.
//
// Needs dev/serve.mjs (:8777) and dev/mockllm.mjs (:9099).
import { open, chat, signInAs, clearMockLog, mockLog, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The provider's rule, written out here rather than trusted ──────────────
//
// An assistant message carrying `tool_calls` must be followed IMMEDIATELY by one
// `tool` message per call, each naming a call it made; and a `tool` message must
// answer a call in the assistant message before it. Anything else is a request an
// OpenAI-compatible provider rejects outright — not degrades, rejects.
//
// Returns the faults, so a failure says which message broke which half.
function faultsIn(messages) {
	const faults = [];
	const seen = new Set();
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
			const want = m.tool_calls.map(tc => (tc.id != null ? String(tc.id) : ''));
			for (const id of want) {
				if (!id) faults.push(`msg ${i}: a tool_call with no id`);
				if (seen.has(id)) faults.push(`msg ${i}: tool_call id ${id} used twice`);
				seen.add(id);
			}
			const answered = [];
			let j = i + 1;
			while (j < messages.length && messages[j].role === 'tool') {
				answered.push(String(messages[j].tool_call_id == null ? '' : messages[j].tool_call_id));
				j++;
			}
			for (const id of want) {
				if (!answered.includes(id)) faults.push(`msg ${i}: tool_call ${id} was never answered`);
			}
			for (const id of answered) {
				if (!want.includes(id)) faults.push(`msg ${i}: a tool reply answers ${id}, which was not asked for`);
			}
			i = j - 1;
		} else if (m.role === 'tool') {
			faults.push(`msg ${i}: a tool reply with no assistant turn asking for it`);
		}
	}
	return faults;
}

/// Reload the page for real, get back in, and open the first chat in the rail.
async function reloadAndOpen(s, name) {
	await s.page.reload({ waitUntil: 'domcontentloaded' });
	await s.page.waitForTimeout(1200);
	await signInAs(s, name);
	await s.page.waitForTimeout(900);
	const box = s.page.locator('#session-list .chat-box').first();
	await box.click({ force: true });
	await s.page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
	await s.page.waitForTimeout(400);
}

const NAME = 'toolreload';
const s = await open({ name: NAME });

// ── Turn one: read a file and write a file ─────────────────────────────────
clearMockLog();
await chat(s, '@tool file_write {"path":"reload-note.txt","content":"the number is 4711"}');
await chat(s, '@tool file_read {"path":"reload-note.txt"}');

const before = mockLog();
const beforeLast = before[before.length - 1] || { messages: [] };
check('before the reload the model is shown its own tool calls',
	beforeLast.messages.some(m => m.tool_calls && m.tool_calls.length),
	`${beforeLast.messages.length} messages`);

// What the browser stored as the model's own conversation.
const storedSession = await s.page.evaluate(async () => {
	const rows = await new Promise((res) => {
		const req = indexedDB.open('daimond-chats', 1);
		req.onsuccess = () => {
			const db = req.result;
			const t = db.transaction('chats', 'readonly');
			const out = [];
			const cur = t.objectStore('chats').openCursor();
			cur.onsuccess = () => { const c = cur.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
			cur.onerror = () => res([]);
		};
		req.onerror = () => res([]);
	});
	const c = rows[0] || {};
	return c.session ? { n: (c.session.msgs || []).length, msgs: c.session.msgs } : null;
});
check('the model\'s own conversation is stored, not only the screen transcript',
	!!(storedSession && storedSession.n), storedSession ? `${storedSession.n} messages` : 'nothing stored');
check('and it carries the provider\'s own call ids, which the screen cannot',
	!!(storedSession && storedSession.msgs.some(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length
		&& String(m.tool_calls[0].id || '').length > 0)),
	storedSession ? JSON.stringify((storedSession.msgs.find(m => m.tool_calls && m.tool_calls.length) || {}).tool_calls || null) : '');

// ── Reload, then ask a follow-up ───────────────────────────────────────────
await reloadAndOpen(s, NAME);
clearMockLog();
await chat(s, '@text What did you write, and what did you read?');

const after = mockLog();
check('the reloaded chat sent something at all', after.length > 0, `${after.length} requests`);
const last = after[after.length - 1] || { messages: [] };

const sawCall   = last.messages.some(m => m.tool_calls && m.tool_calls.length);
const sawResult = last.messages.some(m => m.role === 'tool');
check('after a reload the request still carries the assistant turn that asked for a tool', sawCall);
check('and the tool replies that answered it', sawResult);
// In a TOOL REPLY, not merely somewhere in the request: the same number is in the
// directive the user typed, so a looser search would pass on prose alone — which
// is exactly the amputated state this is meant to catch.
check('and the result text itself, so the model can see what it read',
	last.messages.some(m => m.role === 'tool' && String(m.content || '').includes('4711')));

// Every request in the log, not only the one this test is about.
let allFaults = [];
for (const req of after) {
	const f = faultsIn(req.messages || []);
	if (f.length) allFaults = allFaults.concat(f);
}
check('every request the provider was sent is whole by the pairing rule',
	allFaults.length === 0, allFaults.slice(0, 4).join('; '));

// ── A second reload: it must still be durable, not merely survive once ─────
await reloadAndOpen(s, NAME);
clearMockLog();
await chat(s, '@text And again?');
const twice = mockLog();
const lastTwice = twice[twice.length - 1] || { messages: [] };
check('a second reload keeps it too',
	lastTwice.messages.some(m => m.tool_calls && m.tool_calls.length)
	&& lastTwice.messages.some(m => m.role === 'tool'));
let twiceFaults = [];
for (const req of twice) twiceFaults = twiceFaults.concat(faultsIn(req.messages || []));
check('and every request is still whole', twiceFaults.length === 0, twiceFaults.slice(0, 4).join('; '));

// ── Switching model mid-session drops the app; the memory must not go ──────
await s.page.evaluate(() => {
	const sel = document.getElementById('chat-model-select');
	if (!sel) return;
	const other = [...sel.options].map(o => o.value).find(v => v && v !== sel.value);
	if (!other) return;
	sel.value = other;
	sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await s.page.waitForTimeout(500);
clearMockLog();
await chat(s, '@text after the switch');
const sw = mockLog();
const lastSw = sw[sw.length - 1] || { messages: [] };
check('a mid-session model switch keeps the tool history too',
	lastSw.messages.some(m => m.tool_calls && m.tool_calls.length));
let swFaults = [];
for (const req of sw) swFaults = swFaults.concat(faultsIn(req.messages || []));
check('and its requests are whole', swFaults.length === 0, swFaults.slice(0, 4).join('; '));

// ── A store that has LOST a tool reply must cost that call, not every turn ──
//
// The store is merged across tabs, synced between devices and restored from
// backups, so a session list arriving with a reply missing is a thing that will
// happen. An assistant turn whose call is unanswered is a request the provider
// rejects WHOLE — so one lost reply from last Tuesday would take every turn after
// it, for ever. `pair_up` in src/wasm/app.rs repairs it on the way in; this is
// what proves the repair exists, by breaking the store on purpose.
const damage = await s.page.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats', 1);
	req.onsuccess = () => {
		const db = req.result;
		const t = db.transaction('chats', 'readwrite');
		const st = t.objectStore('chats');
		const all = st.getAll();
		all.onsuccess = () => {
			const rows = all.result || [];
			let dropped = 0;
			rows.forEach((c) => {
				if (!c.session || !c.session.msgs) return;
				const before = c.session.msgs.length;
				// Take out the FIRST tool reply, leaving the call that asked for it.
				const i = c.session.msgs.findIndex(m => m.role === 'tool');
				if (i >= 0) { c.session.msgs.splice(i, 1); dropped += before - c.session.msgs.length; }
				st.put(c);
			});
			t.oncomplete = () => res(dropped);
			t.onerror = () => res(-1);
		};
		all.onerror = () => res(-1);
	};
	req.onerror = () => res(-1);
}));
check('a tool reply was taken out of the store, to see what a reload makes of it',
	damage > 0, `${damage} removed`);

await reloadAndOpen(s, NAME);
clearMockLog();
await chat(s, '@text after the damage');
const dmg = mockLog();
let dmgFaults = [];
for (const req of dmg) dmgFaults = dmgFaults.concat(faultsIn(req.messages || []));
check('a session missing a tool reply is repaired, not sent as it stands',
	dmg.length > 0 && dmgFaults.length === 0, dmgFaults.slice(0, 4).join('; ') || `${dmg.length} requests`);
const dmgLast = dmg[dmg.length - 1] || { messages: [] };
check('and the turn still happened rather than being refused',
	(dmgLast.messages || []).length > 0);

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw while all that happened', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
