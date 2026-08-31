/* ============================================================
   Daimond — the Tracker view (tracker.js)
   ------------------------------------------------------------
   A DECISION-QUEUE BOARD onto Daimond's own development, which
   is tracked as PROPOSALS on the Oregami forge repository
   `oxedyne/daimond`. The board is four columns, left to right the
   life of a proposal:

     Awaiting you  (open)      a decision is wanted
     Greenlit      (accepted)  taken on, with its latest activity
     Shipped       (done)      out, stamped with the build it went in
     Dropped       (declined)  not being done

   Settling happens FROM the board: an Accept, Decline or Mark done
   on an Awaiting-you card; a Reopen or Mark done further along. A
   card opens in full — its statement, revisions and comments — when
   its title is pressed.

   NOT THE SOCIAL ▸ PROPOSALS CHIP. That chip (js/improve.js,
   `DaimondImprove`) is where a user MAKES a proposal from a note and
   votes on one, with the pull voice; this board is where the owner
   and operators DECIDE one, with a settle voice. Same forge repo,
   two surfaces, two stores — see dev/IMPROVE_CONTRACT.md §3a.

   IT REACHES THE FORGE THROUGH THE DAIMOND GATEWAY, exactly as
   improve.js does: every request goes to the same-origin
   `/api/improve` route, which forwards over loopback to the forge
   and translates a Daimond voice header (`x-daimond-voice`) into
   the forge's own (`x-ore-voice`). READING NEEDS NO VOICE — the
   repository is public — so a read is a bare same-origin GET.
   `request()` below is the single place that path is decided.

   VOTES ARE DARK. The replicated log does not attribute a vote, so
   the forge answers a tally — `{for, against}` — and never a voter.

   THE OWNER (AND OPERATORS) MAY SETTLE. Accepting, declining,
   marking done or reopening is an `admin` decision, so it is offered
   ONLY when an admin voice is held. That voice is HAND-MINTED and
   pasted once, stored wrapped under the passphrase like the pull
   voice in voice.js — the auto-provisioned voice improve.js gets is
   pull-only and cannot settle. When none is held the board shows a
   terse "add your settle voice" affordance rather than settle
   buttons that would fail. Settle posts just the decide field —
   `state=<word>` — and sends the admin voice as `x-daimond-voice`.

   THE SHIPPED STAMP IS READ, NEVER INVENTED. An agent that ships a
   proposal comments the real deployed build id onto it (see
   dev/forge.mjs `ship`); the board parses that stamp out of the
   proposal's comments and draws it, clickable to the transparency
   log. A done proposal with no stamp yet reads "awaiting build
   stamp" — the board never guesses an id.

   Attaches one global, `window.DaimondTracker`.
   ============================================================ */
(function () {
	'use strict';

	// ── Saying things ──────────────────────────────────────────

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return v[name] != null ? String(v[name]) : whole;
		});
	}

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[tracker]'].concat([].slice.call(arguments))); }
		catch (e) { /* no console */ }
	}

	// ── What this view reads, and through what ─────────────────
	//
	// One account, one repository: Daimond's own forge repository, the same for
	// every reader, so none of these is a setting a person would ever change.
	// `base` is the Daimond gateway route the requests go through, the same door
	// improve.js uses; `configure()` lets a verifier point the whole view at a
	// stand-in without any of the drawing code learning that it moved.

	var cfg = {
		base:    '/api/improve',	// the Daimond gateway, same-origin; it forwards to the forge
		account: 'oxedyne',
		repo:    'daimond',
		// An in-memory admin voice, for a test or a session that already has one to
		// hand. When empty, the wrapped store below is consulted instead. Held only
		// in memory, never drawn, never logged.
		voice:   '',
	};

	/// Point the view at a gateway route, a repository, or an in-memory admin
	/// voice. Any field left out keeps what it had.
	function configure(next) {
		if (!next || typeof next !== 'object') return cfg;
		if (typeof next.base === 'string')    cfg.base    = next.base;
		if (typeof next.account === 'string') cfg.account = next.account;
		if (typeof next.repo === 'string')    cfg.repo    = next.repo;
		if (typeof next.voice === 'string')   cfg.voice   = next.voice;
		return cfg;
	}

	// ── The settle voice (hand-minted admin) ───────────────────
	//
	// Held wrapped under the passphrase, the same shape voice.js keeps the pull
	// voice in, and for the same reasons: a secret at rest is sealed, and reading
	// it needs an unlocked identity. This view keeps its OWN store because the
	// admin voice is a DIFFERENT voice from the pull one improve.js provisions —
	// the pull voice may not settle, so it cannot stand in here.

	var ADMIN_LS  = 'daimond-tracker-admin';	// namespaced per account by accounts.js, like other daimond-* keys
	var ADMIN_MIN = 16;							// a truncated paste is caught where the person can still see it
	var ADMIN_V   = 1;

	function adminRec() {
		try { return JSON.parse(localStorage.getItem(ADMIN_LS) || 'null'); }
		catch (e) { return null; }
	}

	/// Is an admin voice held on this device? Presence only; reading it needs the
	/// passphrase, asked at the moment of a settle.
	function adminHas() {
		var r = adminRec();
		return !!(r && typeof r.s === 'string' && r.s);
	}

	/// Trim the label the forge prints around a minted secret, so a pasted line
	/// stores as the secret alone.
	function tidy(secret) { return String(secret == null ? '' : secret).trim(); }

	/// What is wrong with a pasted secret, or '' — for validating as it is typed.
	function adminCheck(secret) {
		var s = tidy(secret);
		if (!s) return tOr('tracker.admin_empty', 'Paste your settle voice.');
		if (s.length < ADMIN_MIN) return tOr('tracker.admin_short', 'That looks too short to be a whole voice.');
		return '';
	}

	/// Hold the admin voice, wrapped under the passphrase. Throws the sentence a
	/// person should read: the secret is invalid, or the identity is locked.
	async function adminSet(secret) {
		var why = adminCheck(secret);
		if (why) throw new Error(why);
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			throw new Error(tOr('tracker.admin_locked',
				'Unlock Daimond first: your settle voice is kept encrypted under your passphrase.'));
		}
		var wrapped = await DaimondIdentity.wrap(tidy(secret));
		try { localStorage.setItem(ADMIN_LS, JSON.stringify({ v: ADMIN_V, s: wrapped, at: Date.now() })); }
		catch (e) { throw new Error(tOr('tracker.admin_store', 'That voice could not be stored on this device.')); }
	}

	/// Forget the admin voice, destructively. The record goes, not a flag beside it.
	function adminClear() {
		try { localStorage.removeItem(ADMIN_LS); } catch (e) { /* private mode: nothing stored */ }
	}

	/// The admin secret in the clear, for the length of one settle, or '' when
	/// none is held. `cfg.voice` wins when set — a test or a session that already
	/// holds one to hand. Nothing caches the plaintext; each call unwraps afresh.
	async function adminSecret() {
		if (cfg.voice) return cfg.voice;
		var r = adminRec();
		if (!r || !r.s) return '';
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			throw new Error(tOr('tracker.admin_locked_send',
				'Unlock Daimond to settle: your settle voice is encrypted under your passphrase.'));
		}
		try { return await DaimondIdentity.unwrap(r.s); }
		catch (e) {
			throw new Error(tOr('tracker.admin_unreadable',
				'Your settle voice cannot be read with this passphrase. Set it again.'));
		}
	}

	/// Whether the settle controls are offered: an admin voice held here or one
	/// handed in. Presence only, and nothing about its value.
	function canSettle() { return !!cfg.voice || adminHas(); }

	// ── The settle voice through a passphrase change ───────────────
	//
	// Sealed under the passphrase, so a change to it must read the voice out under
	// the old one and put it back under the new — the same two phases voice.js runs
	// for the pull voice. Without this the admin voice would be left wrapped to a
	// key that no longer exists, and lost. The `at` stamp is kept: this is a
	// re-wrapping, not a fresh paste.

	var heldAdmin = null;		// plaintext, ONLY for the length of one change

	/// Read the admin voice out under the OLD passphrase, before the key changes.
	async function readForRekey() {
		heldAdmin = null;
		if (!adminHas()) return { held: 0, failed: [] };
		var r = adminRec();
		try { heldAdmin = await DaimondIdentity.unwrap(r.s); }
		catch (e) { return { held: 0, failed: [tOr('tracker.the_settle_voice', 'your settle voice')] }; }
		if (!heldAdmin) return { held: 0, failed: [] };
		return { held: 1, failed: [] };
	}

	/// Put it back under the NEW passphrase, and forget it either way. Wrapped
	/// directly rather than through `adminSet`, which re-validates: a voice stored
	/// by an older build must survive a change rather than be dropped by it.
	async function resealForRekey() {
		if (!heldAdmin) return { failed: [] };
		var failed = [];
		try {
			var r = adminRec();
			var when = (r && typeof r.at === 'number') ? r.at : Date.now();
			localStorage.setItem(ADMIN_LS, JSON.stringify({
				v: ADMIN_V, s: await DaimondIdentity.wrap(heldAdmin), at: when,
			}));
		} catch (e) { failed.push(tOr('tracker.the_settle_voice', 'your settle voice')); }
		finally { heldAdmin = null; }		// in the clear; never held past here
		return { failed: failed };
	}

	/// Drop the plaintext unused, for a change that did not happen.
	function forgetRekey() { heldAdmin = null; }

	if (window.DaimondRekey) {
		DaimondRekey.register({
			name:   'settle',
			read:   readForRekey,
			reseal: resealForRekey,
			forget: forgetRekey,
			/// One secret, so the list is not named: there is only ever one settle
			/// voice on a device.
			sentence: function (kind) {
				return kind === 'unread'
					? tOr('changepass.settle_not_unsealed',
						'Your settle voice could not be read under the old passphrase, so it '
						+ 'still needs pasting again from the line the forge printed for you.')
					: tOr('changepass.settle_not_resealed',
						'Your settle voice could not be re-encrypted under the new passphrase. '
						+ 'Paste it again from the line the forge printed for you.');
			},
		});
	}

	// ── THE ONE DOOR ───────────────────────────────────────────
	//
	// Every request goes through here, and this is the single place the path is
	// decided. It mirrors improve.js: the account and repository ride in the
	// QUERY on the same-origin `/api/improve` route; a READ carries no voice — the
	// repository is public; a settle carries the admin voice in `x-daimond-voice`,
	// which the gateway translates to the forge's `x-ore-voice`. A voiced write
	// goes through `DaimondGateway.gwFetch` — the one copy of the session rule —
	// when the gateway module is present; a plain read is a bare `fetch`.

	/// The route, with the repository this view reads. Built here and nowhere
	/// else, and the voice is never in it: a query string is written into every
	/// access log it passes.
	function route(extra) {
		var q = 'account=' + encodeURIComponent(cfg.account) + '&repo=' + encodeURIComponent(cfg.repo);
		return String(cfg.base || '/api/improve') + '?' + q + (extra ? '&' + extra : '');
	}

	/// One exchange, read the way this view needs it: `{ ok, data }` on success,
	/// or `{ ok:false, why, because, status }` where `why` is the forge's stable
	/// token, `gateway` for a refusal with no token, or `offline` for no answer.
	///
	/// `voiceSecret` is the admin voice for a settle, or falsy for a read.
	async function request(path, opts, voiceSecret) {
		var o = Object.assign({}, opts || {});
		o.headers = Object.assign({}, (opts && opts.headers) || {});
		var g = window.DaimondGateway;
		var useGw = false;
		if (voiceSecret) {
			o.headers['x-daimond-voice'] = voiceSecret;
			if (g && g.gwFetch) {
				useGw = true;
				o.headers['x-daimond-api'] = String(g.clientApi ? g.clientApi() : '');
				o.credentials = 'same-origin';
			}
		}
		var r;
		try {
			r = useGw ? await g.gwFetch(path, o) : await fetch(path, o);
		} catch (e) {
			return { ok: false, why: 'offline' };
		}
		var text = '';
		try { text = await r.text(); } catch (e) { text = ''; }
		var data = null;
		try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
		if (data && typeof data === 'object' && typeof data.error === 'string' && TOKENS[data.error]) {
			return {
				ok:      false,
				why:     data.error,
				because: (typeof data.because === 'string' && BECAUSE[data.because]) ? data.because : '',
				status:  r.status,
			};
		}
		if (r.ok && data && typeof data === 'object') return { ok: true, data: data };
		return { ok: false, why: 'gateway', status: r.status };
	}

	var TOKENS = {
		absent: 1, unvoiced: 1, unknown: 1, unpermitted: 1, throttled: 1,
		malformed: 1, no_proposal: 1, unsupported: 1, internal: 1,
	};
	var BECAUSE = { address: 1, voice: 1, failing: 1 };

	/// What a refusal says on screen. `absent` covers "no such repository" and
	/// "this repository is private" alike — true in both, leaks in neither.
	function saying(a) {
		if (!a) return tOr('tracker.err_offline', 'Nothing could be read just now.');
		switch (a.why) {
		case 'absent':      return tOr('tracker.err_absent', 'This repository is not available.');
		case 'unvoiced':    return tOr('tracker.err_unvoiced', 'The forge was given no voice.');
		case 'unknown':     return tOr('tracker.err_unknown', 'The forge does not recognise that voice.');
		case 'unpermitted': return tOr('tracker.err_unpermitted', 'That voice may not settle proposals here.');
		case 'throttled':
			if (a.because === 'address') return tOr('tracker.err_throttled_address', 'Too many requests from this address. Wait, then try again.');
			return tOr('tracker.err_throttled', 'Too many requests just now. Wait, then try again.');
		case 'malformed':   return tOr('tracker.err_malformed', 'The forge could not read that request.');
		case 'no_proposal': return tOr('tracker.err_no_proposal', 'There is no such proposal.');
		case 'unsupported': return tOr('tracker.err_unsupported', 'The forge does not answer that.');
		case 'internal':    return tOr('tracker.err_internal', 'Something went wrong at the forge.');
		case 'gateway':
			if (a.status === 401) return tOr('tracker.err_session', 'Not signed in, so the forge could not be reached.');
			return tOr('tracker.err_gateway', 'The forge could not be reached just now.');
		default:            return tOr('tracker.err_offline', 'Nothing could be read just now.');
		}
	}

	// ── The record ─────────────────────────────────────────────

	var STATES = { open: 1, accepted: 1, declined: 1, done: 1 };

	function whole(v) { return (typeof v === 'number' && isFinite(v)) ? Math.floor(v) : 0; }

	function clean(p) {
		if (!p || typeof p !== 'object') return null;
		var n = whole(p.number);
		if (n < 1) return null;
		var rec = {
			n:        n,
			title:    (typeof p.title === 'string') ? p.title : '',
			state:    STATES[p.state] ? p.state : 'open',
			author:   (typeof p.author === 'string') ? p.author : '',
			comments: Math.max(0, whole(p.comments)),
			opened:   Math.max(0, whole(p.opened)),
			changed:  (typeof p.changed === 'number') ? Math.max(0, whole(p.changed)) : null,
			mark:     (typeof p.mark === 'string') ? p.mark : '',
			build:    (typeof p.build === 'string') ? p.build : '',
			body:     (typeof p.body === 'string') ? p.body : '',
			detail:   false,
			// A TALLY, never a voter. Two counts, and nothing that says who.
			votes:    null,
			revisions:  null,
			discussion: null,
			// Set from the discussion once it is read: the last comment, drawn on a
			// Greenlit card as its latest activity, and the shipped build id parsed
			// out of the ship stamp. Never from the wire — the board derives them.
			latest:   null,
			shipped:  '',
			enriched: false,
		};
		if (p.votes && typeof p.votes === 'object' && !Array.isArray(p.votes)) {
			rec.votes = { for: Math.max(0, whole(p.votes.for)), against: Math.max(0, whole(p.votes.against)) };
		}
		if (typeof p.body === 'string') rec.detail = true;
		if (Array.isArray(p.discussion)) {
			rec.detail = true;
			rec.discussion = p.discussion.map(function (d) {
				return {
					author: (d && typeof d.author === 'string') ? d.author : '',
					said:   (d && typeof d.said === 'string') ? d.said : '',
					when:   Math.max(0, whole(d && d.when)),
				};
			});
		}
		if (Array.isArray(p.revisions)) {
			rec.revisions = p.revisions.map(function (r) {
				return {
					title: (r && typeof r.title === 'string') ? r.title : '',
					body:  (r && typeof r.body === 'string') ? r.body : '',
					when:  Math.max(0, whole(r && r.when)),
				};
			});
		}
		return rec;
	}

	// ── The shipped-build stamp ────────────────────────────────
	//
	// An agent that ships a proposal comments the real deployed build id onto it,
	// in a fixed line (dev/forge.mjs `ship`): "Shipped in build <id>". The board
	// parses that id out of the proposal's comments. It reads the id; it never
	// invents one, so a done proposal that has not been stamped shows no id at all.

	var SHIP_RE = /shipped in build\s+`?([0-9a-f]{8,40})`?/i;

	/// The shipped build id from a discussion, or '' when none is stamped. The
	/// LAST stamp wins, so a re-ship supersedes an earlier one.
	function parseShip(discussion) {
		if (!Array.isArray(discussion)) return '';
		for (var i = discussion.length - 1; i >= 0; i--) {
			var said = discussion[i] && discussion[i].said;
			var m = (typeof said === 'string') ? SHIP_RE.exec(said) : null;
			if (m) return m[1];
		}
		return '';
	}

	/// Derive the latest comment and the shipped id from a record's own discussion,
	/// once it has been read. Marks the record enriched so it is not fetched again.
	function deriveFrom(n) {
		var p = _by[n];
		if (!p || !Array.isArray(p.discussion)) return;
		p.latest   = p.discussion.length ? p.discussion[p.discussion.length - 1] : null;
		p.shipped  = parseShip(p.discussion);
		p.enriched = true;
	}

	// ── The store ──────────────────────────────────────────────

	var PAGE = 50;

	var _by    = {};
	var _order = [];
	var _open  = null;
	var _st    = { total: 0, loading: false, err: null, read: false };
	var _voiceOpen = false;				// the admin-voice paste form is showing
	var _filter    = 'all';				// board filter: 'all', or 'mine' (raised from this device)

	function absorb(rec) {
		if (!rec) return null;
		var cur = _by[rec.n];
		if (cur && !rec.detail) {
			rec.body       = cur.body;
			rec.discussion = cur.discussion;
			rec.revisions  = cur.revisions;
			rec.detail     = cur.detail;
			// Carry the derived board fields forward, so a listing refresh does not
			// blank a card's shipped stamp or latest-activity line.
			rec.latest     = cur.latest;
			rec.shipped    = cur.shipped;
			rec.enriched   = cur.enriched;
		}
		if (!cur) _order.push(rec.n);
		_by[rec.n] = rec;
		return rec;
	}

	// ── Reading ────────────────────────────────────────────────

	/// Read the listing, newest first. From the top only: this board shows recent
	/// development at a glance and opens one proposal in full, rather than paging
	/// the whole history the Social panel walks.
	async function load() {
		if (_st.loading) return false;
		_st.loading = true;
		_st.err     = null;
		draw();
		var a = await request(route('limit=' + PAGE), { method: 'GET' });
		_st.loading = false;
		if (!a.ok) { _st.err = a; draw(); return false; }
		_by = {}; _order = [];
		var raw = Array.isArray(a.data.proposals) ? a.data.proposals : [];
		raw.forEach(function (p) { var rec = clean(p); if (rec) absorb(rec); });
		_st.total = Math.max(0, whole(a.data.total));
		_st.read  = true;
		draw();
		return true;
	}

	/// Read one proposal in full and show it. Deriving its board fields from the
	/// discussion in the same breath, so opening a card is also how it is enriched.
	async function open(n) {
		var a = await request(route('n=' + n), { method: 'GET' });
		if (!a.ok) { _st.err = a; draw(); return false; }
		absorb(clean(a.data));
		deriveFrom(whole(n));
		_open    = whole(n);
		_st.err  = null;
		draw();
		return true;
	}

	/// A Greenlit or Shipped card wants its latest comment and its shipped stamp,
	/// which live in the discussion and not in the listing. Read the proposal in
	/// full, once, and derive them. A read is public and unvoiced, like every read.
	async function enrich(n) {
		var p = _by[n];
		if (!p || p.enriched) return;
		p.enriched = true;			// once; a failed read does not loop
		var a = await request(route('n=' + n), { method: 'GET' });
		if (!a.ok) return;			// leave the listing-only card as it stands
		absorb(clean(a.data));
		deriveFrom(n);
		draw();
	}

	/// Back to the board.
	function back() { _open = null; draw(); }

	/// Load once, when the panel is first shown. Reading on every app boot would
	/// fetch for a panel nobody opened.
	function onOpen() { if (!_st.read && !_st.loading) load(); return true; }

	// ── Settling (admin voice only) ────────────────────────────

	// FOUR TOKENS AND NO MORE: state is open, accepted, declined or done. There is
	// no "reopen" token — a Reopen sends `state=open`. Settle carries ONLY the
	// `state` field: no mark, no reason.
	var DECISIONS = { accept: 'accepted', decline: 'declined', done: 'done', reopen: 'open' };

	/// Post the decide field for proposal `n` under the admin voice. `which` is
	/// one of accept, decline, done, reopen — the last of which sends `state=open`.
	async function settle(n, which) {
		if (!canSettle()) return false;
		var state = DECISIONS[which];
		if (!state) return false;
		var secret;
		try { secret = await adminSecret(); }
		catch (e) { _st.err = { why: 'gateway' }; flash(String((e && e.message) || e)); return false; }
		if (!secret) { flash(tOr('tracker.admin_need', 'Add your settle voice first.')); return false; }
		var f = new URLSearchParams();
		f.set('state', state);
		var a = await request(route('n=' + n), {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    f.toString(),
		}, secret);
		if (!a.ok) { _st.err = a; draw(); return false; }
		absorb(clean(a.data));
		deriveFrom(n);
		_st.err = null;
		draw();
		return true;
	}

	// ── Drawing ────────────────────────────────────────────────

	var _host = null;

	function fmtWhen(secs) {
		if (!secs) return '';
		var loc;
		try { loc = window.DaimondI18n ? DaimondI18n.locale() : undefined; } catch (e) { loc = undefined; }
		try { return new Date(secs * 1000).toLocaleDateString(loc || undefined, { day: 'numeric', month: 'short' }); }
		catch (e) { return ''; }
	}

	function stateWord(s) {
		if (s === 'accepted') return tOr('tracker.state_taken', 'Being done');
		if (s === 'done')     return tOr('tracker.state_done', 'Done');
		if (s === 'declined') return tOr('tracker.state_declined', 'Declined');
		return tOr('tracker.state_open', 'Open');
	}

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	function button(cls, act, text, title) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = cls;
		if (act) b.dataset.act = act;
		b.textContent = text;
		if (title) b.title = title;
		return b;
	}

	/// A comment cut to a card's width. The whole thing is one press away.
	function snippet(s) {
		var x = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
		return x.length > 90 ? x.slice(0, 89) + '…' : x;
	}

	/// The tally, drawn as two counts and never as a name.
	function tallyLine(p) {
		if (!p.votes) return null;
		return el('span', 'trk-tally', tOr('tracker.tally', '{yes} for, {no} against',
			{ yes: p.votes.for, no: p.votes.against }));
	}

	// ── The board ──────────────────────────────────────────────
	//
	// Four columns, the life of a proposal left to right. The order in `_order` is
	// newest-first, so filtering it per column keeps each column newest-first too.

	var COLUMNS = [
		{ state: 'open',     key: 'col_open',  label: 'Awaiting you' },
		{ state: 'accepted', key: 'col_green', label: 'Greenlit' },
		{ state: 'done',     key: 'col_ship',  label: 'Shipped' },
		{ state: 'declined', key: 'col_drop',  label: 'Dropped' },
	];

	// ── All / Mine ─────────────────────────────────────────────
	//
	// "Mine" is the proposals THIS DEVICE raised. The local voice has no name --
	// the secret is the identity and this client never learns its own author (see
	// voice.js) -- so "mine" CANNOT be matched against a card's `author`. It is
	// matched by number instead: js/improve.js records, on each note it holds, the
	// proposals a draft written from it became, and publishes the de-duped set as
	// `DaimondImprove.raisedProposalNumbers()`. This board reads that set and shows
	// only the numbers in it. Purely client-side: no author query rides to the forge.

	/// The numbers this device raised, as a lookup, or null when there is no capture
	/// surface to ask. Never throws: an absent or misbehaving `DaimondImprove` is
	/// read as "nothing raised here" rather than an error on the board.
	function raisedSet() {
		try {
			if (window.DaimondImprove && DaimondImprove.raisedProposalNumbers) {
				var arr = DaimondImprove.raisedProposalNumbers();
				if (!Array.isArray(arr)) return null;
				var set = {};
				arr.forEach(function (n) { var w = whole(n); if (w > 0) set[w] = 1; });
				return set;
			}
		} catch (e) { /* absent or threw: nothing raised from here */ }
		return null;
	}

	function drawBoard() {
		// In Mine, keep only the numbers this device raised. `mine` null means the
		// capture surface is absent -- which shows NOTHING here, not everything: Mine
		// is an allow-list, so a card is drawn only when it is on that list.
		var mine  = (_filter === 'mine') ? raisedSet() : null;
		var board = el('div', 'trk-board');
		var shown = 0;
		COLUMNS.forEach(function (col) {
			var ns = _order.filter(function (n) {
				if (!_by[n] || _by[n].state !== col.state) return false;
				if (_filter === 'mine') return !!(mine && mine[n]);
				return true;
			});
			shown += ns.length;
			board.appendChild(drawColumn(col, ns));
		});
		// Mine with nothing to show -- nothing raised here, no capture surface, or the
		// raised ones sit below the page this board reads -- says so rather than four
		// empty columns.
		if (_filter === 'mine' && shown === 0) {
			return el('div', 'trk-none trk-mine-empty',
				tOr('tracker.mine_empty', 'Nothing raised from this device yet.'));
		}
		return board;
	}

	/// The All / Mine control, above the board. Drawn only where the board is.
	function drawFilter() {
		var bar = el('div', 'trk-filter');
		bar.setAttribute('role', 'group');
		[['all', tOr('tracker.filter_all', 'All')], ['mine', tOr('tracker.filter_mine', 'Mine')]]
			.forEach(function (pair) {
				var b  = button('trk-filter-btn', 'tracker-filter', pair[1]);
				b.dataset.filter = pair[0];
				var on = _filter === pair[0];
				if (on) b.classList.add('on');
				b.setAttribute('aria-pressed', on ? 'true' : 'false');
				bar.appendChild(b);
			});
		return bar;
	}

	function drawColumn(col, ns) {
		var c = el('div', 'trk-col');
		c.dataset.state = col.state;
		var head = el('div', 'trk-col-head');
		head.appendChild(el('span', 'trk-col-label', tOr('tracker.' + col.key, col.label)));
		head.appendChild(el('span', 'trk-col-count', String(ns.length)));
		c.appendChild(head);
		if (!ns.length) {
			c.appendChild(el('div', 'trk-col-empty', tOr('tracker.col_empty', 'Nothing here.')));
		} else {
			ns.forEach(function (n) { c.appendChild(drawCard(_by[n], col.state)); });
		}
		return c;
	}

	function drawCard(p, state) {
		var card = el('div', 'trk-card');
		card.dataset.prop = p.n;

		var top = el('div', 'trk-card-top');
		top.appendChild(el('span', 'trk-num', '#' + p.n));
		var title = el('button', 'trk-title', p.title || ('#' + p.n));
		title.type = 'button';
		title.dataset.act = 'tracker-open';
		title.dataset.prop = p.n;
		top.appendChild(title);
		card.appendChild(top);

		var meta = el('div', 'trk-card-meta');
		meta.appendChild(el('span', 'trk-comments', tOr('tracker.comments', '{n} comments', { n: p.comments })));
		var tl = tallyLine(p);
		if (tl) meta.appendChild(tl);
		card.appendChild(meta);

		// The column's own body. Greenlit shows its latest activity; Shipped shows
		// the build it went out in. Both need the discussion, so both enrich.
		if (state === 'accepted') {
			card.appendChild(drawActivity(p));
			enrich(p.n);
		} else if (state === 'done') {
			card.appendChild(drawShip(p));
			enrich(p.n);
		}

		var acts = drawSettle(p, state);
		if (acts) card.appendChild(acts);
		return card;
	}

	/// A Greenlit card's latest agent activity: the last comment once read, or the
	/// count and when it last moved until then.
	function drawActivity(p) {
		var line = el('div', 'trk-activity');
		if (p.latest && p.latest.said) {
			var who = p.latest.author ? (p.latest.author + ': ') : '';
			line.textContent = who + snippet(p.latest.said);
		} else {
			var parts = [tOr('tracker.comments', '{n} comments', { n: p.comments })];
			if (p.changed) parts.push(tOr('tracker.active', 'active {when}', { when: fmtWhen(p.changed) }));
			line.textContent = parts.join(' · ');
		}
		return line;
	}

	/// A Shipped card's build stamp: the real parsed id, clickable to the
	/// transparency log, or a plain "awaiting build stamp" when none is stamped.
	function drawShip(p) {
		var line = el('div', 'trk-ship');
		if (p.shipped) {
			line.appendChild(el('span', 'trk-ship-say', tOr('tracker.shipped_in', 'Shipped in')));
			var b = button('trk-ship-id', 'tracker-transparency', p.shipped,
				tOr('tracker.ship_help', 'Open the transparency log.'));
			b.dataset.build = p.shipped;
			line.appendChild(b);
		} else {
			line.appendChild(el('span', 'trk-ship-say', tOr('tracker.shipped_await', 'Shipped — awaiting build stamp.')));
		}
		return line;
	}

	/// The settle controls for one card, or nothing when there is no admin voice.
	/// Per column: the three forward decisions on an Awaiting-you card; Mark done
	/// or Reopen on a Greenlit one; Reopen on a Shipped or Dropped one.
	function drawSettle(p, state) {
		if (!canSettle()) return null;
		var acts = el('div', 'trk-settle');
		if (state === 'open') {
			acts.appendChild(settleBtn('accept',  p.n, tOr('tracker.accept', 'Accept')));
			acts.appendChild(settleBtn('decline', p.n, tOr('tracker.decline', 'Decline')));
			acts.appendChild(settleBtn('done',    p.n, tOr('tracker.done', 'Mark done')));
		} else if (state === 'accepted') {
			acts.appendChild(settleBtn('done',   p.n, tOr('tracker.done', 'Mark done')));
			acts.appendChild(settleBtn('reopen', p.n, tOr('tracker.reopen', 'Reopen')));
		} else {
			acts.appendChild(settleBtn('reopen', p.n, tOr('tracker.reopen', 'Reopen')));
		}
		return acts;
	}

	function settleBtn(which, n, text) {
		var b = button('trk-settle-btn', 'tracker-settle', text);
		b.dataset.which = which;
		b.dataset.prop  = n;
		return b;
	}

	function drawDetail(p) {
		var box = el('div', 'trk-detail');
		box.dataset.prop = p.n;

		var head = el('div', 'trk-detail-head');
		head.appendChild(button('trk-back', 'tracker-back', tOr('tracker.back', 'Back')));
		var badge = el('span', 'trk-state', stateWord(p.state));
		badge.dataset.state = p.state;
		head.appendChild(badge);
		head.appendChild(el('span', 'trk-num', '#' + p.n));
		box.appendChild(head);

		box.appendChild(el('h3', 'trk-detail-title', p.title || ('#' + p.n)));

		var meta = el('div', 'trk-detail-meta');
		if (p.author) meta.appendChild(el('span', 'trk-author', p.author));
		if (p.opened) meta.appendChild(el('span', 'trk-when', fmtWhen(p.opened)));
		var tl = tallyLine(p);
		if (tl) meta.appendChild(tl);
		if (p.mark) meta.appendChild(el('span', 'trk-mark', p.mark));
		box.appendChild(meta);

		// The build it shipped in, if it is done and has been stamped.
		if (p.state === 'done') box.appendChild(drawShip(p));

		box.appendChild(el('p', 'trk-body', p.body || ''));

		var settle = drawSettle(p, p.state);
		if (settle) box.appendChild(settle);

		if (p.revisions && p.revisions.length) {
			var revs = el('div', 'trk-revisions');
			revs.appendChild(el('h4', 'trk-sub', tOr('tracker.revisions', 'Revisions')));
			p.revisions.forEach(function (r) {
				var one = el('div', 'trk-rev');
				one.appendChild(el('span', 'trk-when', fmtWhen(r.when)));
				one.appendChild(el('span', 'trk-rev-title', r.title));
				revs.appendChild(one);
			});
			box.appendChild(revs);
		}

		var comments = el('div', 'trk-comments-list');
		comments.appendChild(el('h4', 'trk-sub', tOr('tracker.discussion', 'Comments')));
		var disc = p.discussion || [];
		if (!disc.length) {
			comments.appendChild(el('div', 'trk-none', tOr('tracker.no_comments', 'No comments.')));
		} else {
			disc.forEach(function (d) {
				var c = el('div', 'trk-comment');
				var foot = el('div', 'trk-comment-foot');
				if (d.author) foot.appendChild(el('span', 'trk-author', d.author));
				if (d.when)   foot.appendChild(el('span', 'trk-when', fmtWhen(d.when)));
				c.appendChild(el('div', 'trk-comment-said', d.said));
				c.appendChild(foot);
				comments.appendChild(c);
			});
		}
		box.appendChild(comments);
		return box;
	}

	/// The settle-voice control, drawn under the head. Shown only where an identity
	/// exists to wrap under — in a build without one, `cfg.voice` is the only way a
	/// voice is held, and there is nothing to paste. Presence, replace, forget: the
	/// same three states voice.js draws for the pull voice. When no voice is held
	/// this is the terse "add your settle voice" affordance the owner asked for, so
	/// the board never shows a settle button that would fail.
	function drawAdmin() {
		if (!window.DaimondIdentity) return null;		// nothing to wrap under; tests use cfg.voice
		var host = el('div', 'trk-admin');
		if (_voiceOpen) {
			var input = document.createElement('input');
			input.type = 'password';
			input.className = 'trk-admin-in';
			input.id = 'tracker-admin-in';
			input.autocomplete = 'off';
			input.spellcheck = false;
			input.placeholder = tOr('tracker.admin_ph', 'Paste your settle voice');
			input.setAttribute('aria-label', tOr('tracker.admin_ph', 'Paste your settle voice'));
			host.appendChild(input);
			host.appendChild(button('trk-admin-save', 'tracker-admin-save', tOr('tracker.admin_save', 'Save')));
			host.appendChild(button('trk-admin-cancel', 'tracker-admin-cancel', tOr('common.cancel', 'Cancel')));
			return host;
		}
		if (adminHas()) {
			host.appendChild(el('span', 'trk-admin-say', tOr('tracker.admin_held', 'Settle voice held, encrypted.')));
			host.appendChild(button('trk-admin-btn', 'tracker-admin-forget', tOr('tracker.admin_forget', 'Forget it')));
			return host;
		}
		// NO SETTLE VOICE HELD. Reading and the board are open to everyone; settling
		// is owner-and-operator only and needs a hand-minted admin voice, pasted once.
		// This is the affordance that opens the paste, in place of dead settle buttons.
		host.appendChild(el('span', 'trk-admin-say', tOr('tracker.admin_none',
			'Reading only. Settling needs your admin voice.')));
		host.appendChild(button('trk-admin-btn', 'tracker-admin-open', tOr('tracker.admin_add', 'Add your settle voice')));
		return host;
	}

	function draw() {
		if (!_host) return;
		_host.innerHTML = '';

		var head = el('div', 'trk-head');
		head.appendChild(el('span', 'trk-title-main', tOr('tracker.title', 'Development')));
		if (_st.read) head.appendChild(el('span', 'trk-count', tOr('tracker.count', '{n} proposals', { n: _st.total })));
		_host.appendChild(head);

		var admin = drawAdmin();
		if (admin) _host.appendChild(admin);

		if (_st.err) _host.appendChild(el('div', 'trk-err', saying(_st.err)));

		var say = el('div', 'trk-say');
		say.id = 'tracker-say';
		_host.appendChild(say);

		if (_st.loading && !_order.length) {
			_host.appendChild(el('div', 'trk-loading', tOr('tracker.loading', 'Reading…')));
			return;
		}

		if (_open && _by[_open]) { _host.appendChild(drawDetail(_by[_open])); return; }

		if (!_order.length) {
			if (_st.read) _host.appendChild(el('div', 'trk-none', tOr('tracker.empty', 'No proposals yet.')));
			return;
		}
		_host.appendChild(drawFilter());
		_host.appendChild(drawBoard());
	}

	/// One line for the answers not worth a dialog.
	function flash(text) {
		var n = document.getElementById('tracker-say');
		if (!n) return;
		n.textContent = text;
		clearTimeout(flash._t);
		flash._t = setTimeout(function () { if (n.textContent === text) n.textContent = ''; }, 8000);
	}

	// ── Admin-voice actions ────────────────────────────────────

	async function saveAdmin() {
		var input = document.getElementById('tracker-admin-in');
		if (!input) return false;
		var raw = String(input.value || '');
		input.value = '';
		try { await adminSet(raw); }
		catch (e) { flash(String((e && e.message) || e)); return false; }
		_voiceOpen = false;
		draw();
		flash(tOr('tracker.admin_saved', 'Settle voice held, encrypted.'));
		return true;
	}

	async function forgetAdmin() {
		var ok = true;
		try {
			if (window.DaimondCore && DaimondCore.confirm) {
				ok = await DaimondCore.confirm(
					tOr('tracker.admin_forget_ask', 'Forget your settle voice here? It was shown once.'),
					tOr('tracker.admin_forget', 'Forget it'),
					{ title: tOr('tracker.admin_forget', 'Forget it') });
			}
		} catch (e) { ok = true; }
		if (!ok) return false;
		adminClear();
		draw();
		flash(tOr('tracker.admin_forgotten', 'The copy on this device is gone.'));
		return true;
	}

	// ── The transparency log ───────────────────────────────────

	/// Open the transparency log (the version history), where the shipped build's
	/// own entry lives. The Admin panel already draws it; the stamp only opens it.
	function openTransparency() {
		try {
			if (window.DaimondAdmin && DaimondAdmin.release) { DaimondAdmin.release(); return true; }
		} catch (e) { /* no admin panel in this build */ }
		return false;
	}

	// ── Wiring ─────────────────────────────────────────────────

	function onClick(e) {
		var b = e.target.closest ? e.target.closest('[data-act]') : null;
		if (!b || !_host || !_host.contains(b)) return;
		var act = b.dataset.act;
		// `dataset` values are strings; `whole()` rejects a non-number, so parse here.
		var n   = parseInt(b.dataset.prop, 10) || 0;
		if (act === 'tracker-open' && n) { open(n); return; }
		if (act === 'tracker-back') { back(); return; }
		if (act === 'tracker-filter') {
			var f = (b.dataset.filter === 'mine') ? 'mine' : 'all';
			if (f !== _filter) { _filter = f; draw(); }
			return;
		}
		if (act === 'tracker-settle' && n) { settle(n, b.dataset.which); return; }
		if (act === 'tracker-transparency') { openTransparency(); return; }
		if (act === 'tracker-admin-open') { _voiceOpen = true; draw(); return; }
		if (act === 'tracker-admin-cancel') { _voiceOpen = false; draw(); return; }
		if (act === 'tracker-admin-save') { saveAdmin(); return; }
		if (act === 'tracker-admin-forget') { forgetAdmin(); return; }
	}

	/// Draw the view into `host`. Does NOT read: `onOpen()` does, once the panel
	/// is shown, so a panel nobody opened costs no request.
	function mount(host) {
		if (_host) { try { _host.removeEventListener('click', onClick); } catch (e) { /* gone */ } }
		_host = host || null;
		if (!_host) return;
		_host.addEventListener('click', onClick);
		draw();
	}

	// ── Self-mount into the app's panel, and read on first reveal ──
	//
	// The panel's markup is `#tracker-view`, an empty mount point in index.html.
	// This finds it, draws the shell, and reads the listing the first time the
	// panel becomes visible — so nothing is fetched until a person opens it, and
	// no hand-wired `onOpen` hook in daimond.js is needed.

	function init() {
		var el = document.getElementById('tracker-view');
		if (!el) return;
		mount(el);
		try {
			if (typeof IntersectionObserver === 'function') {
				var io = new IntersectionObserver(function (entries) {
					for (var i = 0; i < entries.length; i++) {
						if (entries[i].isIntersecting) { onOpen(); io.disconnect(); return; }
					}
				});
				io.observe(el);
			} else {
				onOpen();
			}
		} catch (e) { onOpen(); }
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

	window.DaimondTracker = {
		configure: configure,
		mount:     mount,
		onOpen:    onOpen,
		load:      load,
		open:      open,
		back:      back,
		settle:    settle,
		canSettle: canSettle,
		/// The shipped-build stamp parser, published so a test drives the same
		/// parse the board does rather than a second copy of the rule.
		parseShip: parseShip,
		/// The admin voice, published so a settings surface or a test can drive the
		/// same store the paste field writes.
		adminHas:  adminHas,
		adminSet:  adminSet,
		adminClear: adminClear,
		state:     function () {
			return {
				total:   _st.total,
				read:    _st.read,
				loading: _st.loading,
				err:     _st.err ? _st.err.why : '',
				open:    _open,
				settle:  canSettle(),
				filter:  _filter,
				shown:   _order.slice(),
			};
		},
		proposal:  function (n) { return _by[n] ? JSON.parse(JSON.stringify(_by[n])) : null; },
		reset:     function () { _by = {}; _order = []; _open = null; _voiceOpen = false; _filter = 'all'; _st = { total: 0, loading: false, err: null, read: false }; draw(); },
	};
})();
