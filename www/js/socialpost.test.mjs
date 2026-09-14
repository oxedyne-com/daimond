/* ============================================================
   Test — the Social panel's two ways out of the compose box, and
   the one number the forge will not tell a client.
   ------------------------------------------------------------
   Drives the REAL www/js/improve.js in a simulated tab: a
   Map-backed localStorage, a fake DOM holding only the nodes the
   compose box and the queue touch, a stubbed `DaimondTriage.polish`
   standing in for the model, and a `fetch` that counts every POST
   to /api/improve. No browser and no gateway -- the module's own
   store / queue / draft / refuse path is the code under test.

   THE TWO DEFECTS IT EXISTS FOR, both reported by the owner on
   2026-09-14 against build 1f8ca7ce44f0:

     (A) The forge refused a proposal because its title was longer
         than 200 characters, and said so in a sentence carrying no
         number. The row offered Send now -- which would re-send the
         same characters for the same refusal -- and Delete. There
         was no way to shorten the title and no statement of the
         limit anywhere on the screen.

     (B) "Polish & post" ran the model and posted what it wrote in
         the same breath, so the card carrying the revision was
         drawn and removed inside one turn: "It should wait for my
         permission."

   The state machine the fix asserts, in one line each:

     draft ─Post──────────────► sent            (verbatim, at once)
     draft ─Polish & post─────► awaiting-send   (drafted, NOTHING sent)
     awaiting-send ─Send now──► sent
     any ─forge 4xx───────────► refused         (editable, never re-queued)
     refused ─edit title, Send► sent

   Run:  node www/js/socialpost.test.mjs
   ============================================================ */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

// ── A fake DOM, only as much as improve.js's compose box and queue touch ──

function makeNode(tag) {
	const node = {
		tagName: String(tag || '').toUpperCase(),
		className: '', id: '', title: '', type: '', value: '', textContent: '',
		hidden: false, disabled: false, dataset: {}, style: {},
		children: [], _parent: null, _attrs: {},
		get parentNode() { return this._parent; },			// js/approvelist.js's host() reads this
		set innerHTML(v) { if (!v) { this.children.forEach((c) => { c._parent = null; }); this.children = []; } },
		get innerHTML() { return ''; },
		appendChild(c) { c._parent = this; this.children.push(c); return c; },
		insertBefore(c) { c._parent = this; this.children.unshift(c); return c; },
		removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
		setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') this.id = v; },
		getAttribute(k) { return this._attrs[k]; },
		addEventListener() {}, removeEventListener() {},
		// Enough of a selector engine for the three shapes this file uses:
		// `.class`, `[data-act="..."]` and `.imp-queue-row[data-note="..."]`.
		querySelector(sel) { return queryAll(this, sel)[0] || null; },
		querySelectorAll(sel) { return queryAll(this, sel); },
		closest(sel) {
			let n = this;
			while (n) { if (matches(n, sel)) return n; n = n._parent; }
			return null;
		},
	};
	return node;
}

function matches(node, sel) {
	// One selector may carry a class and an attribute test: `.a[data-x="y"]`.
	const parts = String(sel).match(/^(\.[\w-]+)?(\[[^\]]+\])?$/);
	if (!parts) return false;
	if (parts[1] && !(' ' + node.className + ' ').includes(' ' + parts[1].slice(1) + ' ')) return false;
	if (parts[2]) {
		const m = parts[2].match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
		if (!m) return false;
		const key = m[1].replace(/-(\w)/g, (w, c) => c.toUpperCase());
		if (node.dataset[key] === undefined) return false;
		if (m[2] !== undefined && String(node.dataset[key]) !== m[2]) return false;
	}
	return !!(parts[1] || parts[2]);
}

function walk(root, sel) {
	const out = [];
	(function down(n) {
		n.children.forEach((c) => { if (!sel || matches(c, sel)) out.push(c); down(c); });
	})(root);
	return out;
}

/// `walk` plus ONE descendant combinator -- `.a[data-x="y"] .b` -- which is the
/// one compound shape js/approvelist.js's `boxed()` emits, to read a row's own
/// textarea by the draft id on its ancestor. No `>`, no commas: enough for the
/// selectors this file's production code actually writes, not a css engine.
function queryAll(root, sel) {
	const s = String(sel || '').trim();
	if (!s || s.indexOf(' ') === -1) return walk(root, s);
	const i = s.indexOf(' ');
	const scopes = walk(root, s.slice(0, i));
	const out = [];
	scopes.forEach((scope) => {
		queryAll(scope, s.slice(i + 1)).forEach((n) => { if (out.indexOf(n) === -1) out.push(n); });
	});
	return out;
}

/// One tab: the module loaded into a window of its own, with the store, the
/// network and the model all in hand.
function makeTab(cfg = {}) {
	const store = new Map();
	const posts = [];					// every POST that opens a proposal
	let refusing = cfg.refusing || null;	// { status, error, said } or null
	let nextN = 100;

	const byId = new Map();
	const root = makeNode('div');
	const add = (id, tag) => {
		const n = makeNode(tag || 'div');
		n.id = id;
		root.appendChild(n);
		byId.set(id, n);
		return n;
	};
	add('improve-box', 'textarea');
	add('improve-acts');
	add('improve-say');
	add('improve-queue');
	add('improve-raised');

	const listeners = new Map();
	const document = {
		readyState: 'complete',
		// The seeded hosts, and anything the module has created and hung under
		// one of them -- the box's counter is made on the first keystroke.
		getElementById(id) {
			if (byId.has(id)) return byId.get(id);
			return walk(root, '').find((n) => n.id === id) || null;
		},
		createElement: makeNode,
		createTextNode(text) { const n = makeNode('#text'); n.textContent = String(text); return n; },
		querySelector: (sel) => root.querySelector(sel),
		querySelectorAll: (sel) => root.querySelectorAll(sel),
		addEventListener(type, fn) {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type).push(fn);
		},
		removeEventListener() {},
	};
	const fire = (type, ev) => (listeners.get(type) || []).forEach((fn) => fn(ev));

	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};

	async function fetchOne(path, opts) {
		const method = (opts && opts.method) || 'GET';
		const body = (opts && opts.body) || '';
		if (method === 'POST' && String(path).includes('/api/improve') && !/[?&]n=/.test(path)) {
			posts.push(body);
			if (refusing) {
				return {
					ok: false, status: refusing.status,
					text: async () => JSON.stringify({ error: refusing.error, said: refusing.said }),
				};
			}
			const n = nextN++;
			return {
				ok: true, status: 200,
				text: async () => JSON.stringify({
					number: n, title: 't', body: 'b', state: 'open', author: 'ada',
					comments: 0, opened: 1, changed: 2, discussion: [],
					votes: { for: 0, against: 0 }, mark: null, build: null, revisions: [],
				}),
			};
		}
		return { ok: true, status: 200, text: async () => '{}' };
	}

	const polished = [];
	const win = {
		localStorage,
		navigator: { onLine: true, clipboard: { writeText: async () => {} } },
		fetch: fetchOne,
		DaimondVoice: { has: () => true, send: (p, o) => fetchOne(p, o) },
		DaimondTriage: {
			draw() {},
			polish: async (text) => {
				polished.push(text);
				return cfg.polish ? cfg.polish(text) : { title: 'A tidier title', body: 'A tidier body.' };
			},
		},
		innerWidth: 1000, innerHeight: 800,
		addEventListener() {}, removeEventListener() {},
		setTimeout, clearTimeout, Date,
	};
	win.window = win;

	const src = readFileSync(join(HERE, 'improve.js'), 'utf8');
	const fn = new Function('window', 'document', 'localStorage', 'navigator', 'fetch',
		'setTimeout', 'clearTimeout', 'with (window) {\n' + src + '\n}');
	fn(win, document, localStorage, win.navigator, fetchOne, setTimeout, clearTimeout);

	return {
		win, document, store, posts, polished,
		I: () => win.DaimondImprove,
		refuse(r) { refusing = r; },
		type(text) { byId.get('improve-box').value = text; },
		notes: () => win.DaimondImprove.notes(),
		row: () => byId.get('improve-queue').children.find((c) => c.className.includes('imp-queue-row')) || null,
		fire,
		byId,
		/// Reload this tab's store into a fresh module, which is what a boot is.
		reboot() { return makeTab({ ...cfg, store }); },
		seed: store,
	};
}

/// A tab whose store is somebody else's -- what a reload sees.
function reboot(tab, cfg = {}) {
	const next = makeTab(cfg);
	tab.store.forEach((v, k) => next.store.set(k, v));
	return next;
}

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/// One row, as it is drawn.
function readRow(tab) {
	const row = tab.row();
	if (!row) return null;
	const state = row.querySelector('.imp-note-state');
	const input = row.querySelector('.imp-note-title-in');
	const count = row.querySelector('.imp-note-count');
	const send  = row.querySelector('[data-act="improve-resend"]');
	return {
		id:    row.dataset.note,
		state: state ? state.dataset.state : '',
		says:  state ? state.textContent : '',
		input: input ? input.value : null,
		count: count ? count.textContent : null,
		over:  count ? count.dataset.over === '1' : false,
		send:  send ? { label: send.textContent, disabled: !!send.disabled, why: send.title } : null,
		draftBody: (row.querySelector('.imp-note-draftbody') || {}).textContent || null,
		node:  row,
	};
}

const LONG = 'L'.repeat(247);

/// Type into one row's title editor, as a person does. Answers false where there
/// is no editor at all, so a build without one reddens the checks about what the
/// editor does rather than throwing on the first keystroke.
function typeTitle(tab, row, text) {
	const inp = row && row.node ? row.node.querySelector('.imp-note-title-in') : null;
	if (!inp) return false;
	inp.value = text;
	tab.fire('input', { target: inp });
	return true;
}

/// A minimal tab for js/approvelist.js alone -- the queue triage.js's `run()`
/// fills and the ONE place a batch of drafts is ticked and sent. No compose
/// box, no note store: just the host node the list hangs from, a stubbed
/// forge that records every `open`/`say`/`amend` it actually sees, and a
/// stubbed `DaimondImprove.titleLimit()` standing in for the real 200 --
/// stubbed rather than 200 written twice, so a check that changes the limit
/// changes it in one place.
function makeApproveTab(cfg = {}) {
	const store = new Map();
	const calls = [];					// every forge.open/say/amend actually made

	const byId = new Map();
	const root = makeNode('div');
	const add = (id) => { const n = makeNode('div'); n.id = id; root.appendChild(n); byId.set(id, n); return n; };
	add('improve-list');

	const document = {
		getElementById(id) { return byId.has(id) ? byId.get(id) : (walk(root, '').find((n) => n.id === id) || null); },
		createElement: makeNode,
		createTextNode(text) { const n = makeNode('#text'); n.textContent = String(text); return n; },
		querySelector: (sel) => root.querySelector(sel),
		querySelectorAll: (sel) => root.querySelectorAll(sel),
		addEventListener() {}, removeEventListener() {},
	};

	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};

	const win = {
		localStorage,
		DaimondVoice: { has: () => cfg.voice !== false },
		DaimondImprove: {
			titleLimit: () => (cfg.limit || 200),
			forge: {
				open:  async (parts)    => { calls.push(['open', parts]);    return { ok: true, data: { number: 9, title: parts.title, body: parts.body } }; },
				say:   async (n, text)  => { calls.push(['say', n, text]);   return { ok: true, data: { number: n } }; },
				amend: async (n, parts) => { calls.push(['amend', n, parts]); return { ok: true, data: { number: n } }; },
				mayAmend: () => true,
				saying: () => 'The forge would not take it.',
				absorb: () => {},
			},
			fold: () => {}, render: () => {},
		},
	};
	win.window = win;

	const src = readFileSync(join(HERE, 'approvelist.js'), 'utf8');
	const fn = new Function('window', 'document', 'with (window) {\n' + src + '\n}');
	fn(win, document);

	return {
		win, store, calls,
		A:   () => win.DaimondApproveList,
		row: (id) => root.querySelector('.apl-row[data-draft="' + id + '"]'),
	};
}

async function main() {
	console.log('socialpost: the forge\'s title limit, and a draft that waits to be sent');

	// ── The limit is the forge's own, and this client says so ──
	{
		const tab = makeTab();
		// Guarded, so a build that does not publish the figure at all reddens THIS
		// check and goes on to redden the behavioural ones, rather than throwing
		// here and proving only that the export is missing.
		const limit = tab.I().titleLimit ? tab.I().titleLimit() : 0;
		check('the client knows the forge\'s title limit', limit === 200, String(limit));

		// The figure is read back out of the Rust that owns it, when that tree is
		// on this disk. `oregami` publishes no limit on any answer -- its refusal
		// carries a `&'static str` and its own comment says a client "must be told
		// elsewhere what that rule's number is" -- so the two copies are kept in
		// step by this check and by nothing else.
		// Found by walking up from here rather than by a counted number of `..`,
		// because this file is read from the shared checkout and from a lane
		// worktree, which sit at different depths.
		let RUST = '';
		for (let up = join(HERE, '..', '..'), i = 0; i < 8; up = join(up, '..'), i++) {
			const t = join(up, 'web', 'apps', 'oxedyne', 'oregami', 'src', 'propose.rs');
			if (existsSync(t)) { RUST = t; break; }
		}
		if (RUST) {
			const m = readFileSync(RUST, 'utf8').match(/pub const TITLE_LIMIT:\s*usize\s*=\s*(\d+)/);
			check('and it is the number oregami\'s TITLE_LIMIT actually holds',
				!!m && Number(m[1]) === limit, m ? m[1] : 'no TITLE_LIMIT in ' + RUST);
		} else {
			console.log('  --   oregami is not on this disk; the limit is not cross-checked');
		}
	}

	// ── (A1) A title over the limit never enters the queue ──
	{
		const tab = makeTab();
		tab.type(LONG + '\nThe body says what happened.');
		await tab.I().submit('verbatim');
		await settle();
		check('(A1) an over-length title is refused at the box: nothing was posted',
			tab.posts.length === 0, tab.posts.length + ' posts');
		check('(A1) and nothing was queued to be posted later',
			tab.notes().length === 0, tab.notes().length + ' notes');
		const said = tab.byId.get('improve-say').textContent;
		check('(A1) the box says both numbers, which the forge\'s refusal cannot',
			/247/.test(said) && /200/.test(said), said.slice(0, 90));
	}

	// ── (A2) The box counts the first line, and only once it is over ──
	{
		const tab = makeTab();
		tab.I().render();
		const count = () => tab.document.getElementById('improve-count');
		tab.type('A short title\nbody');
		tab.fire('input', { target: tab.byId.get('improve-box') });
		check('(A2) under the limit the counter is silent',
			!count() || count().hidden === true, count() ? count().textContent : 'no counter');
		tab.type(LONG + '\nbody');
		tab.fire('input', { target: tab.byId.get('improve-box') });
		check('(A2) over it the counter appears, naming both numbers',
			!!count() && count().hidden === false
			&& /247/.test(count().textContent) && /200/.test(count().textContent),
			count() ? count().textContent : 'no counter');
		check('(A2) and it is marked as over, not merely present',
			!!count() && count().dataset.over === '1');
	}

	// ── (A3) A refusal is an EDITABLE state, not a dead end ──
	{
		const tab = makeTab();
		// The forge refuses this one the way it refused the owner's, verbatim.
		tab.refuse({ status: 400, error: 'malformed', said: 'That title is longer than a title '
			+ 'here may be. Nothing was written; the length is there so that a listing stays a listing.' });
		// Queued past the box's own guard, which is what an older build, another
		// tab, or a title edited up to length would do.
		tab.type('A title that fits\nThe body says what happened.');
		await tab.I().submit('verbatim');
		await settle();
		const id = tab.notes()[0] && tab.notes()[0].id;
		const rec = tab.notes()[0];
		check('(A3) the refused note is kept: the forge has no copy of it',
			tab.notes().length === 1 && !!rec.refused, JSON.stringify(rec && rec.refused));
		// Now make it the owner's case: a title past the limit, refused.
		tab.I().resend(id);				// a press with the short title still sends
		await settle();
		check('(A3) a press re-sent it once, and it was refused again',
			tab.posts.length === 2 && !!tab.notes()[0].refused, tab.posts.length + ' posts');

		// The long-title case proper: the row opens the title for editing.
		const tab2 = makeTab();
		tab2.refuse({ status: 400, error: 'malformed', said: 'That title is longer than a title here may be.' });
		tab2.type('short\nbody');
		await tab2.I().submit('verbatim');
		await settle();
		// The forge refused it; now the title is the over-length one the owner had.
		const n2 = tab2.notes()[0];
		tab2.I().render();
		let r = readRow(tab2);
		check('(A3) the row says the forge would not take it',
			!!r && r.state === 'refused' && /would not take/i.test(r.says), JSON.stringify(r && r.says));
		check('(A3) and the title is open for editing, with a live count beside it',
			!!r && r.input === 'short' && r.count === '5 / 200', JSON.stringify(r && [r.input, r.count]));

		// Type an over-length title into the row's editor: Send goes dark.
		check('(A3) the row offers an editor to type the over-length title into',
			typeTitle(tab2, r, LONG));
		r = readRow(tab2);
		check('(A3) typing past the limit disables Send now',
			!!r && r.send && r.send.disabled === true, JSON.stringify(r && r.send));
		check('(A3) the count says how far over, and is marked over',
			!!r && r.count === '247 / 200' && r.over === true, JSON.stringify(r && [r.count, r.over]));
		check('(A3) and the disabled Send says why, in both numbers',
			!!r && r.send && /247/.test(r.send.why) && /200/.test(r.send.why), r && r.send && r.send.why);
		check('(A3) Copy is still on the row',
			!!r && !!r.node.querySelector('[data-act="improve-copy"]'));

		// A press while it is over must send nothing, even from a caller that
		// never looked at the button.
		const before = tab2.posts.length;
		await tab2.I().resend(n2.id);
		await settle();
		check('(A3) and a press while it is over sends nothing at all',
			tab2.posts.length === before, (tab2.posts.length - before) + ' posts');

		// Shorten it, and the same press goes. The row is read again first: the
		// refused press redrew the queue, so the node typed into above is no
		// longer the one on the screen.
		tab2.refuse(null);
		r = readRow(tab2);
		check('(A3) the redrawn row still holds the over-length title, ready to cut',
			!!r && r.input === LONG, r && r.input && r.input.length);
		typeTitle(tab2, r, 'A title that fits');
		r = readRow(tab2);
		check('(A3) shortening it enables Send now again',
			!!r && r.send && r.send.disabled === false && r.count === '17 / 200',
			JSON.stringify(r && [r.count, r.send]));
		await tab2.I().resend(n2.id);
		await settle();
		const sent = tab2.posts[tab2.posts.length - 1] || '';
		check('(A3) the press sends the SHORTENED title',
			/title=A\+title\+that\+fits/.test(sent), sent.slice(0, 80));
		check('(A3) and the body is untouched by the title edit',
			/body=body/.test(sent), sent.slice(0, 80));
		check('(A3) the note leaves the queue once the forge takes it',
			tab2.notes().length === 0, tab2.notes().length + ' notes');
	}

	// ── (A4) A refused note is never re-queued for an automatic send ──
	{
		const tab = makeTab();
		tab.refuse({ status: 400, error: 'malformed', said: 'That title is longer than a title here may be.' });
		tab.type('A title\nA body.');
		await tab.I().submit('verbatim');
		await settle();
		check('(A4) one attempt, one refusal', tab.posts.length === 1, tab.posts.length + ' posts');

		await tab.I().flushQueue();
		await tab.I().onOpen();
		await settle();
		check('(A4) a flush and a panel open send it nowhere',
			tab.posts.length === 1, tab.posts.length + ' posts');

		// A BOOT. The refusal has to survive the write to storage and the read back
		// out of it, or the note rejoins the queue at the next start -- which is the
		// loop this field was added to end.
		const next = reboot(tab);
		check('(A4) after a reload the note is still there, still refused',
			next.notes().length === 1 && !!next.notes()[0].refused,
			JSON.stringify(next.notes()[0] && next.notes()[0].refused));
		await next.I().flushQueue();
		await next.I().onOpen();
		await settle();
		check('(A4) and a reload posts nothing: a 4xx is final until it is edited',
			next.posts.length === 0, next.posts.length + ' posts');
	}

	// ── (B1) Polish & post DRAFTS and waits ──
	{
		const tab = makeTab();
		tab.type('the reply box scrolls to the top on send');
		await tab.I().submit('polish');
		await settle();
		check('(B1) the model ran', tab.polished.length === 1);
		check('(B1) and NOTHING was posted', tab.posts.length === 0, tab.posts.length + ' posts');
		// A build that posted the draft has already emptied the queue here, so the
		// record may not exist at all -- which is the defect, and is read as a
		// failure rather than thrown on.
		const rec = tab.notes()[0] || null;
		check('(B1) the note is still here, holding the model\'s draft',
			tab.notes().length === 1 && !!rec && !!rec.draft && rec.draft.title === 'A tidier title',
			JSON.stringify(rec && rec.draft));
		check('(B1) the person\'s own words are untouched beside it',
			!!rec && rec.text === 'the reply box scrolls to the top on send', rec && rec.text);

		const r = readRow(tab);
		check('(B1) the row says nothing has been sent',
			!!r && r.state === 'drafted' && /[Nn]othing has been sent/.test(r.says), JSON.stringify(r && r.says));
		check('(B1) the model\'s proposal is on the row, title and body',
			!!r && r.input === 'A tidier title' && /tidier body/.test(r.draftBody || ''),
			JSON.stringify(r && [r.input, r.draftBody]));
		check('(B1) with an ENABLED Send now beside it',
			!!r && r.send && r.send.label === 'Send now' && r.send.disabled === false,
			JSON.stringify(r && r.send));

		// Nothing automatic may take it. This is the defect itself.
		await tab.I().flushQueue();
		await tab.I().onOpen();
		await settle();
		check('(B1) a flush and a panel open still post nothing',
			tab.posts.length === 0, tab.posts.length + ' posts');
		const after = reboot(tab);
		await after.I().flushQueue();
		await settle();
		check('(B1) and neither does a reload: the draft waits across a boot',
			after.posts.length === 0 && after.notes().length === 1 && !!after.notes()[0].draft,
			after.posts.length + ' posts');

		// ── (B2) The press is what sends it ──
		await tab.I().resend(rec ? rec.id : '');
		await settle();
		check('(B2) pressing Send now posts exactly once',
			tab.posts.length === 1, tab.posts.length + ' posts');
		const body = tab.posts[0] || '';
		check('(B2) and what went is the model\'s draft, not the raw note',
			/title=A\+tidier\+title/.test(body) && /tidier\+body/.test(body), body.slice(0, 90));
		check('(B2) the note leaves the queue', tab.notes().length === 0, tab.notes().length + ' notes');
	}

	// ── (B2b) A refused POLISH note with no draft offers another drafting ──
	//
	// The shape of every note refused by the build that posted the drafting
	// without holding it: what the forge rejected was the model's title, which
	// that build did not keep. An editor there would hold the note's own first
	// line -- not what was refused, and not what will be sent -- so the row
	// offers the drafting instead, under a prompt that now states the limit.
	{
		// Seeded into storage in the OLD shape -- mode polish, refused, no draft --
		// because that is what the build before this one wrote, and what is sitting
		// in the owner's browser now.
		const seeded = makeTab();
		seeded.store.set('daimond-improve', JSON.stringify({ v: 3, raised: [], notes: [{
			id: 'nold', at: Date.now(), mode: 'polish', build: '', sent: 0, n: 0, into: [],
			text: 'a note whose drafting the forge refused',
			refused: { why: 'malformed', at: Date.now(),
				said: 'That title is longer than a title here may be.' },
		}] }));
		const back = reboot(seeded);
		back.I().render();
		const r = readRow(back);
		check('(B2b) the row is refused and offers no editor for a title it would not send',
			!!r && r.state === 'refused' && r.input === null, JSON.stringify(r && [r.state, r.input]));
		check('(B2b) and its press is Polish it, not Send now',
			!!r && r.send && r.send.label === 'Polish it' && r.send.disabled === false,
			JSON.stringify(r && r.send));
		check('(B2b) the row says so in words',
			!!r && /Polish it/.test(r.says), JSON.stringify(r && r.says));
		await back.I().flushQueue();
		await settle();
		check('(B2b) and nothing automatic re-sends or re-drafts it',
			back.posts.length === 0 && back.polished.length === 0,
			back.posts.length + ' posts, ' + back.polished.length + ' draftings');
	}

	// ── (B3) A model that writes too long a title is held, not sent ──
	{
		const tab = makeTab({ polish: () => ({ title: LONG, body: 'A tidier body.' }) });
		tab.type('a note the model will over-title');
		await tab.I().submit('polish');
		await settle();
		check('(B3) nothing was posted', tab.posts.length === 0, tab.posts.length + ' posts');
		const r = readRow(tab);
		check('(B3) the over-length draft is held with Send now dark',
			!!r && r.send && r.send.disabled === true && r.over === true,
			JSON.stringify(r && [r.count, r.send]));
		check('(B3) and it is editable, at full length, so it can be cut',
			!!r && r.input === LONG, r && r.input && r.input.length);
	}

	// ── (B4) The model's prompt carries the limit ──
	{
		const tab = makeTab();
		const src = readFileSync(join(HERE, 'triage.js'), 'utf8');
		const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout',
			'with (window) {\n' + src + '\n}');
		try { fn(tab.win, tab.document, setTimeout, clearTimeout); } catch (e) { /* the panel half is absent */ }
		const prompt = tab.win.DaimondTriage && tab.win.DaimondTriage.polishSystem
			? tab.win.DaimondTriage.polishSystem() : '';
		check('(B4) the polish prompt states the forge\'s title limit',
			/TITLE IS AT MOST 200 CHARACTERS/.test(prompt), prompt.slice(0, 60));
		check('(B4) and says what a longer one costs, so it is a rule and not a preference',
			/refuses a\s+longer one outright|costs the person/.test(prompt));

		// ── (B5) The MULTI-NOTE triage prompt carries the same limit ──
		//
		// `polishSystem()` above states rule 5 for the single-note path; `brief()`
		// is triage's own equivalent -- the whole of what a run of "Draft from my
		// notes" tells the model -- and until now it never mentioned the limit at
		// all, so a plan of ten drafts could name ten titles the forge would
		// refuse and the model would never be told why.
		const brief = tab.win.DaimondTriage && tab.win.DaimondTriage.brief
			? tab.win.DaimondTriage.brief([{ id: 'n1', at: 1, text: 'a note about a fault' }], [])
			: { system: '' };
		check('(B5) the triage prompt states the forge\'s title limit',
			/TITLE IS AT MOST 200 CHARACTERS/.test(brief.system), brief.system.slice(0, 80));
		check('(B5) and says the forge refuses a longer one outright, so it is a rule',
			/refuses a longer one outright/.test(brief.system));
		check('(B5) and it is asked of the SAME titleLimit() the polish prompt asked -- one figure',
			(brief.system.match(/AT MOST (\d+) CHARACTERS/) || [])[1]
				=== (prompt.match(/AT MOST (\d+) CHARACTERS/) || [])[1],
			JSON.stringify([brief.system.match(/AT MOST (\d+)/), prompt.match(/AT MOST (\d+)/)]));
	}

	// ── (B6) A triage draft over the limit is queued, but never offered as sendable ──
	//
	// The multi-note plan reaches the forge through js/approvelist.js, not
	// through improve.js's own `fits`/`tooLong` -- a second surface the owner's
	// 2026-09-14 report never touched, and one the SYSTEM prompt's new rule 9
	// cannot enforce by itself: the model is asked nicely, and a plan is read
	// once and paid for already by the time an answer breaks the rule.
	{
		const tab = makeApproveTab();
		const A = tab.A();
		const added = A.enqueue([{ kind: 'new', title: LONG, body: 'The body says what happened.',
			from: ['n1'], why: 'one fault, corroborated once' }]);
		check('(B6) the over-length draft is queued -- a plan is never silently dropped',
			added === 1, String(added));
		const before = A.queue()[0];
		check('(B6) and its title is kept WHOLE, not quietly cut to fit',
			before.title.length === 247, String(before.title.length));

		check('(B6) ticking it is refused: an over-length title is never offered as sendable',
			A.select(before.id, true) === false, 'select() returned true');
		check('(B6) so it stays unticked',
			A.queue()[0].sel === false, JSON.stringify(A.queue()[0].sel));

		A.draw();
		const row = tab.row(before.id);
		check('(B6) the row draws no tick at all for a title the forge would refuse',
			!!row && !row.querySelector('.apl-tick'));
		const said = row ? ((row.querySelector('.apl-toolong') || {}).textContent || '') : '';
		check('(B6) and says both numbers, which the forge\'s own refusal cannot',
			/247/.test(said) && /200/.test(said), said);

		// A queue holding a draft already ticked -- what an older build without
		// this gate would have left in storage -- must still send nothing: the
		// batch send re-checks `sendable` at the moment it sends, not only at
		// the moment something was ticked.
		const seeded = makeApproveTab();
		seeded.store.set('daimond-approvelist', JSON.stringify({ v: 1, drafts: [
			{ id: 'd1', kind: 'new', n: 0, title: LONG, body: 'b', from: [], why: '', sel: true, err: '' },
		] }));
		await seeded.A().send();
		check('(B6) a pre-ticked over-length draft from an older build still sends nothing',
			seeded.calls.length === 0, JSON.stringify(seeded.calls));

		// The boundary: exactly at the limit sends; one over does not.
		const fit = makeApproveTab();
		fit.A().enqueue([{ kind: 'new', title: LONG.slice(0, 200), body: 'b', from: [], why: 'w' }]);
		const okDraft = fit.A().queue()[0];
		check('(B6) a title AT the limit is still offered as sendable',
			fit.A().select(okDraft.id, true) === true);
		fit.A().selectAll(true);
		await fit.A().send();
		check('(B6) and it reaches the forge',
			fit.calls.length === 1 && fit.calls[0][0] === 'open', JSON.stringify(fit.calls));

		const over = makeApproveTab();
		over.A().enqueue([{ kind: 'new', title: LONG.slice(0, 201), body: 'b', from: [], why: 'w' }]);
		const overDraft = over.A().queue()[0];
		check('(B6) one character over the limit is refused, not rounded up',
			over.A().select(overDraft.id, true) === false);
	}

	// ── An offline note still behaves: verbatim goes on reconnect, polish waits ──
	{
		const tab = makeTab();
		tab.win.navigator.onLine = false;
		tab.type('offline verbatim note\nabout a crash');
		await tab.I().submit('verbatim');
		tab.type('offline polish note about wording');
		await tab.I().submit('polish');
		await settle();
		check('(C) offline, nothing reached the forge and nothing was drafted',
			tab.posts.length === 0 && tab.polished.length === 0, tab.posts.length + ' posts');
		tab.win.navigator.onLine = true;
		await tab.I().flushQueue();
		await settle(20);
		check('(C) the reconnect POSTS the verbatim note', tab.posts.length === 1,
			tab.posts.length + ' posts');
		check('(C) and DRAFTS the polish note without posting it',
			tab.polished.length === 1 && tab.notes().length === 1 && !!tab.notes()[0].draft,
			JSON.stringify(tab.notes().map((n) => [n.mode, !!n.draft])));
		await tab.I().flushQueue();
		await settle(20);
		check('(C) a second flush neither re-drafts it nor sends it',
			tab.posts.length === 1 && tab.polished.length === 1,
			tab.posts.length + ' posts, ' + tab.polished.length + ' draftings');
	}

	console.log(failures === 0 ? '\nsocialpost: all checks pass'
		: `\nsocialpost: ${failures} check(s) FAILED`);
	if (failures) process.exit(1);
}

await main();
