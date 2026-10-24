// ownereye_pools.mjs -- the three credit pools of the approved shots, stood in on a page: this world has
// no gateway or provider to report a balance, so the gateway state and the providers are stood in for, and
// today's spend on each is put in the ledger under its own provider id. Shared by verify_ownereye.mjs's
// worlds and probe_dialcentre.mjs.

export const standInPools = (p) => p.evaluate(async () => {
	const now = Date.now(), gs = DaimondGateway.state.bind(DaimondGateway);
	DaimondGateway.state = () => Object.assign({}, gs(), { authed: true, credits: 1876, currency: 'AUD' });
	DaimondModels.providers = () => [
		{ id: 'openrouter', name: 'OpenRouter', hasKey: true, paid: false, credit: { mode: 'auto', usd: 18.4, binds: 'limit' } },
		{ id: 'fireworks', name: 'Fireworks AI', hasKey: true, paid: false, credit: { mode: 'manual', usd: 41.25 } },
	];
	try { DaimondModels.noteTopups([{ key: 'credits', mark: { full: 25, at: now - 864e5, last: 25 } },
		{ key: 'openrouter', mark: { full: 50, at: now - 864e5, last: 50 } }, { key: 'fireworks', mark: { full: 50, at: now - 864e5, last: 50 } }]); } catch (e) { /* no marks */ }
	const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
	const span = Math.max(120e3, now - d0.getTime() - 60e3);
	[['credits', 0.18], ['openrouter', 0.74], ['fireworks', 0.2]].forEach(([pv, usd], k) => {
		for (let i = 0; i < 3; i++) DaimondLedger.record({ ts: now - 60e3 - ((k * 3 + i) * 7919e3 % span), model: 'mock/fast', promptTokens: 100, completionTokens: 100, costUsd: usd / 3, provider: pv });
	});
	for (let i = 0; i < 6; i++) DaimondLedger.record({ ts: now - i * 90e3, model: 'mock/fast', promptTokens: 100, completionTokens: 100, costUsd: 0.05, provider: 'openrouter' });
	DaimondI18n.setCurrency('AUD');
});
