// graphlink.test.mjs — the Graph's removal of a link, proved without a browser.
//
//	node --test www/js/graphlink.test.mjs
//
// A hand-written sidecar row has no id, and `remove_link(owner, "")` named every such row at once
// (D1k4/5 second check, defect 1).  The Graph keys such a row by what it says (`bareKey`) and
// removes it by that content (`removeCall`), never by the blank id.  Both are lifted out of
// `www/js/graph.js` by name and run against a stand-in store, so what is proved is the code the
// page runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = fs.readFileSync(path.join(HERE, 'graph.js'), 'utf8');

function lift(name) {
	const at = SRC.indexOf('\tfunction ' + name + '(');
	assert.ok(at >= 0, 'graph.js has no ' + name);
	const end = SRC.indexOf('\n\t}\n', at);
	return SRC.slice(at, end + 3);
}
// eslint-disable-next-line no-new-func
const G = new Function(lift('bareKey') + lift('removeCall') + 'return { bareKey, removeCall };')();

function store() {
	const calls = [];
	return {
		calls,
		remove_link:      (...a) => { calls.push(['remove_link', ...a]); return true; },
		remove_bare_link: (...a) => { calls.push(['remove_bare_link', ...a]); return true; },
	};
}

test('a link with an id is removed by its id', () => {
	const l = G.bareKey({ owner: 'd1', id: 'k1', from: 'diamond:a', to: 'diamond:b', rel: 'cites' });
	assert.equal(l.id, 'k1');
	assert.ok(!l.bare);
	const a = store();
	G.removeCall(a, l);
	assert.deepEqual(a.calls, [['remove_link', 'd1', 'k1']]);
});

test('a hand-written link is removed by its content, never by a blank id', () => {
	const l = G.bareKey({ owner: 'd1', id: '', from: 'diamond:a', to: 'diamond:b', rel: 'informs' });
	assert.ok(l.bare);
	assert.ok(l.id, 'the row is keyed, so it can be picked');
	// What `linkById` hands the menu, the editor and the Delete key.
	const picked = { id: l.id, owner: l.owner, rel: l.rel, bare: l.bare, fromRef: l.from, toRef: l.to,
		from: 'a', to: 'b' };
	const a = store();
	G.removeCall(a, picked);
	assert.deepEqual(a.calls, [['remove_bare_link', 'd1', 'diamond:a', 'diamond:b', 'informs']]);
	assert.ok(!a.calls.some((c) => c[0] === 'remove_link'));
});

test('two hand-written rows between other ends get other keys', () => {
	const x = G.bareKey({ owner: 'd1', from: 'diamond:a', to: 'diamond:b', rel: 'informs' });
	const y = G.bareKey({ owner: 'd1', from: 'diamond:b', to: 'diamond:c', rel: 'informs' });
	assert.notEqual(x.id, y.id);
});

test('linkById carries what the content removal needs', () => {
	const body = lift('linkById');
	assert.match(body, /bare:\s*!!hit\.bare/);
	assert.match(body, /fromRef:\s*hit\.from/);
	assert.match(body, /toRef:\s*hit\.to/);
});

test('every Graph removal goes through removeCall', () => {
	for (const name of ['dropLink', 'reverseLink']) {
		const body = lift(name);
		assert.match(body, /removeCall\(a, l\)/, name + ' removes through removeCall');
		assert.doesNotMatch(body, /remove_link\(/, name + ' calls remove_link directly');
	}
});

// Review (graph.js ~2654): an id-less row cannot be revised, so the editor offers no Save for it
// and never needs to say so in hard-coded English inside a translated frame.
test('the editor offers Save for a new or id-bearing link, never for a hand-written one', () => {
	// eslint-disable-next-line no-new-func
	const canRevise = new Function(lift('canRevise') + 'return canRevise;')();
	assert.equal(canRevise(true, null), true);
	assert.equal(canRevise(false, { id: 'k1' }), true);
	assert.equal(canRevise(false, G.bareKey({ owner: 'd1', from: 'diamond:a', to: 'diamond:b' })), false);
});

test('no hard-coded English is passed into graph.write_failed', () => {
	assert.ok(!/write_failed',\s*\{\s*err:\s*'/.test(SRC), 'a literal err string in write_failed');
});
