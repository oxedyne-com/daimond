// verify_dispatchindex.mjs — the dispatched-placeholder index gives the SAME
// placeholders the old all-chats × all-messages scan did.
//
// The three scans in daimond.js (peerCollectOnReturn, dropDispatchedPlaceholder,
// markPlaceholderParked) were rewritten to resolve a turn through an iturn -> chatId
// cache instead of walking every chat and every message. This mirrors both the OLD
// scan and the NEW index-driven resolution over a randomised corpus with the awkward
// cases -- several dispatched turns in one chat, a dispatched placeholder in a daimon
// chat, an answer sharing an iturn, a non-empty placeholder, and a STALE index entry
// pointing at a deleted chat -- and asserts the candidate sets are identical.
//
//   node dev/verify_dispatchindex.mjs

const DISPATCHED = 'dispatched';
let fails = 0;
const ok = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) fails++; };

// A deterministic stand-in for recoverDecision: exercises the same m the real one
// sees, applied identically on both sides so only the CANDIDATE enumeration is under
// test.
function recoverDecision(m) { return m.why === DISPATCHED && !!m.iturn && !(m.content && m.content.trim()); }

// ── The index, exactly as rebuildDispatchedIndex builds it ──
function buildIndex(chats) {
	const ix = Object.create(null);
	for (const c of chats) {
		if (!c || !c.id || !c.messages) continue;
		for (const m of c.messages) if (m && m.why === DISPATCHED && m.iturn) ix[String(m.iturn)] = c.id;
	}
	return ix;
}

// ── peerCollectOnReturn ──
function oldPeerScan(chats) {
	const jobs = [];
	for (const chat of chats) {
		if (!chat || chat.diamondId || !chat.messages) continue;
		for (const m of chat.messages) {
			if (!m || m.why !== DISPATCHED || !m.iturn) continue;
			if (recoverDecision(m)) jobs.push(chat.id + '#' + m.iturn + '#' + m.mid);
		}
	}
	return jobs.sort();
}
function newPeerScan(chats, ix) {
	const byId = {};
	for (const c of chats) if (c && c.id) byId[c.id] = c;
	const jobs = [];
	for (const iturn of Object.keys(ix)) {
		const chat = byId[ix[iturn]];
		if (!chat || chat.diamondId || !chat.messages) continue;
		for (const m of chat.messages) {
			if (!m || m.why !== DISPATCHED || String(m.iturn) !== iturn) continue;
			if (recoverDecision(m)) jobs.push(chat.id + '#' + m.iturn + '#' + m.mid);
		}
	}
	return jobs.sort();
}

// ── dropDispatchedPlaceholder: which mids get tombstoned, and which answer is tagged ──
function oldDrop(chats, turnId) {
	const dropped = []; let answer = null;
	for (const c of chats) {
		if (!c.messages) continue;
		for (const m of c.messages) {
			if (m.why === DISPATCHED && m.iturn === turnId && !(m.content && m.content.trim())) dropped.push(m.mid);
			else if (m.role === 'assistant' && String(m.iturn) === String(turnId) && m.content && m.content.trim()) answer = c.id + '/' + m.mid;
		}
	}
	return { dropped: dropped.sort(), answer };
}
function newDrop(chats, ix, turnId) {
	const dropped = []; let answer = null;
	const byId = {}; for (const c of chats) if (c && c.id) byId[c.id] = c;
	const cid = ix[String(turnId)];
	const only = cid != null ? byId[cid] : null;
	const scan = only ? [only] : [];
	for (const c of scan) {
		if (!c.messages) continue;
		for (const m of c.messages) {
			if (m.why === DISPATCHED && m.iturn === turnId && !(m.content && m.content.trim())) dropped.push(m.mid);
			else if (m.role === 'assistant' && String(m.iturn) === String(turnId) && m.content && m.content.trim()) answer = c.id + '/' + m.mid;
		}
	}
	return { dropped: dropped.sort(), answer };
}

// ── markPlaceholderParked: which mids get their parkCount moved ──
function oldMark(chats, turnId) {
	const moved = [];
	for (const c of chats) {
		if (!c || !c.messages) continue;
		for (const m of c.messages) if (m.why === DISPATCHED && String(m.iturn) === String(turnId)) moved.push(m.mid);
	}
	return moved.sort();
}
function newMark(chats, ix, turnId) {
	const moved = [];
	const byId = {}; for (const c of chats) if (c && c.id) byId[c.id] = c;
	const c = ix[String(turnId)] != null ? byId[ix[String(turnId)]] : null;
	if (c && c.messages) for (const m of c.messages) if (m.why === DISPATCHED && String(m.iturn) === String(turnId)) moved.push(m.mid);
	return moved.sort();
}

// ── A randomised corpus with the awkward cases baked in ──
function makeCorpus(seed) {
	let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const chats = []; const turns = [];
	const nChats = 3 + Math.floor(rnd() * 6);
	for (let ci = 0; ci < nChats; ci++) {
		const c = { id: 'c' + ci, diamondId: rnd() < 0.2 ? 'd' + ci : null, messages: [] };
		const nMsg = Math.floor(rnd() * 8);
		for (let mi = 0; mi < nMsg; mi++) {
			const r = rnd();
			if (r < 0.4) {
				const it = 't' + ci + '_' + mi;
				const empty = rnd() < 0.7;
				c.messages.push({ role: 'assistant', why: DISPATCHED, iturn: it, mid: 'm' + ci + '_' + mi, content: empty ? '' : 'partial', parkCount: 0 });
				turns.push(it);
				// Some dispatched turns also have a real answer with the same iturn.
				if (rnd() < 0.5) c.messages.push({ role: 'assistant', iturn: it, mid: 'ans' + ci + '_' + mi, content: 'the answer' });
			} else {
				c.messages.push({ role: rnd() < 0.5 ? 'user' : 'assistant', mid: 'm' + ci + '_' + mi, content: 'hello', iturn: 'x' + ci + '_' + mi });
			}
		}
		chats.push(c);
	}
	return { chats, turns };
}

let peerOk = true, dropOk = true, markOk = true;
for (let seed = 1; seed <= 200; seed++) {
	const { chats, turns } = makeCorpus(seed);
	const ix = buildIndex(chats);
	if (JSON.stringify(oldPeerScan(chats)) !== JSON.stringify(newPeerScan(chats, ix))) peerOk = false;
	for (const it of turns) {
		if (JSON.stringify(oldDrop(chats, it)) !== JSON.stringify(newDrop(chats, ix, it))) dropOk = false;
		if (JSON.stringify(oldMark(chats, it)) !== JSON.stringify(newMark(chats, ix, it))) markOk = false;
	}
}
ok('peerCollectOnReturn candidates identical (200 corpora)', peerOk);
ok('dropDispatchedPlaceholder result identical (all turns)', dropOk);
ok('markPlaceholderParked result identical (all turns)',    markOk);

// ── A STALE index entry (chat deleted since) must not produce a phantom ──
{
	const chats = [{ id: 'c0', diamondId: null, messages: [
		{ role: 'assistant', why: DISPATCHED, iturn: 't-live', mid: 'm0', content: '' },
	] }];
	const ix = buildIndex(chats);
	ix['t-ghost'] = 'c-deleted';        // points at a chat no longer in the array
	ok('stale index entry yields no phantom candidate', JSON.stringify(oldPeerScan(chats)) === JSON.stringify(newPeerScan(chats, ix)));
	ok('stale entry: drop is a safe no-op', newDrop(chats, ix, 't-ghost').dropped.length === 0);
	ok('stale entry: mark is a safe no-op', newMark(chats, ix, 't-ghost').length === 0);
}

// ── Several dispatched turns in ONE chat, each resolved to its own placeholder ──
{
	const chats = [{ id: 'cM', diamondId: null, messages: [
		{ role: 'assistant', why: DISPATCHED, iturn: 'A', mid: 'mA', content: '' },
		{ role: 'assistant', why: DISPATCHED, iturn: 'B', mid: 'mB', content: '' },
		{ role: 'assistant', why: DISPATCHED, iturn: 'C', mid: 'mC', content: 'partial' },
	] }];
	const ix = buildIndex(chats);
	ok('multi-turn chat: peer scan identical', JSON.stringify(oldPeerScan(chats)) === JSON.stringify(newPeerScan(chats, ix)));
	ok('multi-turn chat: drop targets only turn B', JSON.stringify(newDrop(chats, ix, 'B').dropped) === JSON.stringify(['mB']));
}

console.log(fails === 0 ? '\nPASS — the index reproduces the scan exactly.' : `\nFAIL — ${fails} check(s) failed.`);
process.exit(fails === 0 ? 0 : 1);
