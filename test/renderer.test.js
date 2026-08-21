'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

/**
 * The renderer relies on Local's aliases for react and react-router-dom. Stub
 * them so the module can be loaded and its hook registrations inspected without
 * needing Electron.
 */
const stubs = new Map();

stubs.set('react', {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
	useState: (initial) => [initial, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
});

stubs.set('react-router-dom', { NavLink: 'NavLink', Route: 'Route' });
let ipcResponse = {};

stubs.set('@getflywheel/local/renderer', { ipcAsync: async () => ipcResponse });

// The renderer sets a polling interval and subscribes to an ipc event; neither
// should keep the test runner alive.
stubs.set('electron', { ipcRenderer: { on: () => {} } });

const originalLoad = Module._load;

Module._load = function (request, ...rest) {
	if (stubs.has(request)) {
		return stubs.get(request);
	}

	return originalLoad.call(this, request, ...rest);
};

test('renderer registers a Live Link tab and its route', () => {
	const renderer = require('../src/renderer.js');

	assert.equal(typeof renderer, 'function');

	const content = new Map();

	renderer({ hooks: { addContent: (name, fn) => content.set(name, fn), addFilter: () => {} } });

	// These are the exact hook names Local calls; a typo here means no UI at all.
	assert.ok(content.has('SiteInfo_TabNav_Items'), 'must add a tab');
	assert.ok(content.has('routes[site-info]'), 'must add a route');
	assert.ok(content.has('stylesheets'), 'must inject its stylesheet');

	const site = { id: 'site-1', name: 'my-site' };

	const tab = content.get('SiteInfo_TabNav_Items')(site);

	assert.equal(tab.type, 'NavLink');
	assert.equal(tab.props.to, '/main/site-info/site-1/live-link');
	assert.ok(tab.props.key, 'needs a key since it renders in a list');

	const route = content.get('routes[site-info]')({ routeChildrenProps: { site } });

	assert.equal(route.type, 'Route');
	assert.equal(route.props.path, '/main/site-info/:siteID/live-link');

	// react-router 5 style; `render` keeps us off the v6-only APIs.
	assert.equal(typeof route.props.render, 'function');

	const panel = route.props.render();

	assert.equal(typeof panel.type, 'function', 'route must render the panel component');
});

test('the stylesheet adapts to Local dark mode', () => {
	const renderer = require('../src/renderer.js');

	const content = new Map();
	renderer({ hooks: { addContent: (name, fn) => content.set(name, fn), addFilter: () => {} } });

	const styleEl = content.get('stylesheets')();
	const css = styleEl.props.dangerouslySetInnerHTML.__html;

	assert.equal(styleEl.type, 'style');

	// Local switches this class on an ancestor; without a matching block the panel
	// renders dark text on a dark background.
	assert.match(css, /\.Theme__Dark \.ll\s*\{/, 'must define a dark theme block');

	// Every colour must come from a custom property that the dark block can
	// override, so a hardcoded hex outside the two palettes is a bug.
	const paletteEnd = css.indexOf('.ll h3');
	const body = css.slice(paletteEnd);
	const strayHex = body.match(/:\s*#[0-9a-fA-F]{3,6}\s*;/g) || [];

	assert.deepEqual(
		strayHex.filter((m) => !/#d2665c/.test(m)),
		[],
		`colours must use var(--ll-*), found: ${strayHex.join(', ')}`,
	);

	// The two palettes must define the same set of variables, or a token silently
	// falls back to its light value in dark mode.
	const names = (block) => new Set((block.match(/--ll-[a-z-]+(?=:)/g) || []));
	const light = css.slice(css.indexOf('.ll {'), css.indexOf('.Theme__Dark'));
	const dark = css.slice(css.indexOf('.Theme__Dark'), paletteEnd);

	for (const token of names(light)) {
		assert.ok(names(dark).has(token), `${token} has no dark-mode value`);
	}
});


test('the paths section rejects input that does not start with a slash', () => {
	const source = require('node:fs').readFileSync(
		require('node:path').join(__dirname, '..', 'src', 'renderer.js'),
		'utf8',
	);

	// Enforced in the UI as well as the worker, so a typo is caught while typing
	// rather than after a round trip.
	assert.match(source, /startsWith\('\/'\)/, 'must require a leading slash');
	assert.match(source, /Must start with a slash/, 'must say why');

	// The Add button and Enter key both have to respect it.
	assert.match(source, /disabled: busy \|\| !pathIsValid/, 'Add must be disabled while invalid');
	assert.match(source, /e\.key === 'Enter' && pathIsValid/, 'Enter must respect validation');
});

test('the paths description explains the 404 auth behaviour', () => {
	const source = require('node:fs').readFileSync(
		require('node:path').join(__dirname, '..', 'src', 'renderer.js'),
		'utf8',
	);

	// Otherwise being asked for a password on a path you just whitelisted looks
	// like the bypass is broken.
	assert.match(source, /returns a 404/, 'must mention the 404 case');
	assert.match(source, /Webhooks are unaffected/, 'must reassure that webhooks still work');
});

test('the removed sections and callout are really gone', () => {
	const source = require('node:fs').readFileSync(
		require('node:path').join(__dirname, '..', 'src', 'renderer.js'),
		'utf8',
	);

	assert.doesNotMatch(source, /Give up this address/, 'the standalone release section was removed');
	assert.doesNotMatch(source, /linky-note/, 'the callout was folded into the description');

	// Release still exists, just relocated next to the copy buttons.
	assert.match(source, /Release address/, 'the release action must still be available');
	assert.match(source, /window\.confirm/, 'and must still confirm, since it is irreversible');
});

test('credentials save themselves instead of behind a button', () => {
	const source = require('node:fs').readFileSync(
		require('node:path').join(__dirname, '..', 'src', 'renderer.js'),
		'utf8',
	);

	// The explicit save was one more thing to forget: each field is independent
	// and takes effect at the edge immediately, so there was nothing to batch.
	assert.doesNotMatch(source, /Save credentials/, 'the save button must be gone');

	assert.match(source, /onBlur: \(e\) => commitCredential\('Username'/, 'username saves on blur');
	assert.match(source, /onBlur: \(e\) => commitCredential\('Password'/, 'password saves on blur');
	assert.match(source, /Generate new pair/, 'regenerating must still be possible');
});

test('auto-save refuses to persist an invalid or unchanged credential', () => {
	const source = require('node:fs').readFileSync(
		require('node:path').join(__dirname, '..', 'src', 'renderer.js'),
		'utf8',
	);

	// Saving on blur means a half-typed value could otherwise lock the site out,
	// so the same rules the worker enforces are checked before sending.
	assert.match(source, /credentialProblem/, 'must validate before saving');
	assert.match(source, /next === '' \|\| next === saved \|\| credentialProblem/, 'must skip no-ops and invalid input');
	assert.match(source, /must be 3–64 characters/, 'must explain the length rule');
	assert.match(source, /cannot contain a colon/, 'must explain the colon rule');
});

test('the paths field accepts a query-pinned root but not a bare one', () => {
	const source = require('node:fs').readFileSync(
		require('node:path').join(__dirname, '..', 'src', 'renderer.js'),
		'utf8',
	);

	// Pinning a parameter is the only safe way to allow a listener at '/', so the
	// UI must not reject it along with the bare slash.
	assert.match(source, /Pin a parameter, e\.g\. \/\?action=mepr/, 'must suggest pinning');
	assert.match(source, /Add at least one parameter after/, 'must reject a dangling "?"');
	assert.match(source, /action=mepr&foo=bar/, 'must document that extra parameters are ignored');
});

test('first run asks for both the service address and the key', () => {
	const source = require('node:fs').readFileSync(
		require('node:path').join(__dirname, '..', 'src', 'renderer.js'),
		'utf8',
	);

	// The add-on ships with no service configured, since every organisation runs
	// its own Worker.
	assert.match(source, /if \(!configured\)/, 'must gate on both halves being present');
	assert.match(source, /linky-live\.example\.com/, 'must show a neutral example, not a real host');
	assert.match(source, /setupReady/, 'must not let Connect run with half the details');

	// No real deployment may be referenced anywhere in the shipped UI.
	assert.doesNotMatch(source, /\.co\b(?!m)/, 'must not hardcode a real service host');
});

test('the footer says where to change the service address', () => {
	const source = require('node:fs').readFileSync(
		require('node:path').join(__dirname, '..', 'src', 'renderer.js'),
		'utf8',
	);

	// There is no field for it after setup, so someone will go looking for one.
	assert.match(source, /edit settings\.json/, 'must point at the file');
	assert.match(source, /Change key/, 'the key itself is still changeable in the UI');
});
