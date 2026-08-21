'use strict';

/**
 * Renderer half of the addon: a "Live Link" tab on every site.
 *
 * Written with React.createElement rather than JSX so the addon needs no build
 * step. Local registers process-wide module aliases for react and
 * react-router-dom, so these resolve at runtime from a plain folder on disk.
 *
 * All colour lives in styles.js, keyed off Local's own theme class, so the panel
 * stays legible in both light and dark mode.
 */

const React = require('react');
const { NavLink, Route } = require('react-router-dom');
const { ipcAsync } = require('@getflywheel/local/renderer');

const stylesheet = require('./styles');

const { useCallback, useEffect, useState } = React;

const h = React.createElement;

const IPC = {
	GET_STATE: 'linky-live:get-state',
	SAVE_SETTINGS: 'linky-live:save-settings',
	ENABLE: 'linky-live:enable',
	DISABLE: 'linky-live:disable',
	RELEASE: 'linky-live:release',
	UPDATE_AUTH: 'linky-live:update-auth',
	UPDATE_PATHS: 'linky-live:update-paths',
};

function LiveLinkPanel({ site }) {
	const [state, setState] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [copied, setCopied] = useState('');

	const [editingKey, setEditingKey] = useState(false);
	const [keyDraft, setKeyDraft] = useState('');
	const [hostDraft, setHostDraft] = useState('');
	const [userDraft, setUserDraft] = useState('');
	const [passDraft, setPassDraft] = useState('');
	const [pathDraft, setPathDraft] = useState('');

	const refresh = useCallback(async () => {
		const next = await ipcAsync(IPC.GET_STATE, site.id);

		setState(next);

		// Seed credential fields from the server without clobbering typing.
		if (next.site) {
			setUserDraft((prev) => (prev === '' ? next.site.authUser : prev));
			setPassDraft((prev) => (prev === '' ? next.site.authPass : prev));
		}
	}, [site.id]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const act = useCallback(
		async (fn) => {
			setBusy(true);
			setError('');

			try {
				await fn();
				await refresh();
			} catch (err) {
				setError(err && err.message ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[refresh],
	);

	/**
	 * Why a credential is unusable, or '' when it is fine. Mirrors the worker.
	 */
	const credentialProblem = (value, field) => {
		const v = String(value || '').trim();

		if (v.length < 3 || v.length > 64) {
			return `${field} must be 3–64 characters.`;
		}

		if (/\s/.test(v)) {
			return `${field} cannot contain spaces.`;
		}

		if (field === 'Username' && v.includes(':')) {
			return 'Username cannot contain a colon.';
		}

		return '';
	};

	/**
	 * Save a credential as soon as the field is left, rather than behind a button.
	 *
	 * There is nothing to batch here — each field is independent and the change
	 * takes effect at the edge immediately — so an explicit save step was only ever
	 * one more thing to forget.
	 */
	const commitCredential = (field, value) => {
		const saved = state.site ? state.site[field === 'Username' ? 'authUser' : 'authPass'] : '';
		const next = String(value || '').trim();

		// Nothing typed, unchanged, or invalid: leave it alone and let the inline
		// message explain why.
		if (next === '' || next === saved || credentialProblem(next, field)) {
			return;
		}

		act(() => ipcAsync(IPC.UPDATE_AUTH, {
			siteId: site.id,
			[field === 'Username' ? 'authUser' : 'authPass']: next,
		}));
	};

	const addPath = () =>
		act(async () => {
			await ipcAsync(IPC.UPDATE_PATHS, {
				siteId: site.id,
				bypassPaths: [...((state && state.site && state.site.bypassPaths) || []), pathDraft.trim()],
			});

			setPathDraft('');
		});

	const copy = (text, which) => {
		navigator.clipboard.writeText(text);
		setCopied(which);
		setTimeout(() => setCopied(''), 1500);
	};

	if (!state) {
		return h('div', { className: 'll' }, 'Loading…');
	}

	/**
	 * Why the draft bypass path is unusable, or '' when it is fine.
	 *
	 * Mirrors the worker's validation so a mistake is caught while typing. The
	 * worker still enforces all of it; this is only for feedback.
	 */
	const trimmedPath = pathDraft.trim();

	let pathProblem = '';

	if (trimmedPath !== '') {
		const queryAt = trimmedPath.indexOf('?');

		if (!trimmedPath.startsWith('/')) {
			pathProblem = 'Must start with a slash.';
		} else if (trimmedPath === '/') {
			pathProblem = 'A bare slash would make the whole site public. Pin a parameter, e.g. /?action=mepr';
		} else if (queryAt !== -1 && trimmedPath.slice(queryAt + 1) === '') {
			pathProblem = 'Add at least one parameter after the "?".';
		} else if (trimmedPath.includes('*')) {
			pathProblem = 'No wildcards — a path already covers everything beneath it.';
		} else if (/\s/.test(trimmedPath)) {
			pathProblem = 'No spaces.';
		}
	}

	const pathIsValid = trimmedPath !== '' && pathProblem === '';

	// Everything below renders inside .ll > .ll-inner: .ll scrolls, .ll-inner
	// keeps the text column readable.
	const panel = (...children) => h('div', { className: 'll' }, h('div', { className: 'll-inner' }, ...children));

	const { site: link, running, allocated, enabled, configured, keyHint, controlHostname } = state;

	// A hostname is enough of a URL to be worth sanity-checking before saving.
	const setupReady = keyDraft.trim() !== '' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(
		hostDraft.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
	);

	const saveSetup = () =>
		act(async () => {
			await ipcAsync(IPC.SAVE_SETTINGS, {
				apiKey: keyDraft.trim(),
				controlHostname: hostDraft.trim(),
			});

			setKeyDraft('');
			setHostDraft('');
			setEditingKey(false);
		});

	const saveKey = () =>
		act(async () => {
			await ipcAsync(IPC.SAVE_SETTINGS, { apiKey: keyDraft.trim() });
			setKeyDraft('');
			setEditingKey(false);
		});

	/* ---- First run: the key is entered once, for every site ---- */

	if (!configured) {
		return panel(
			h('div', { className: 'll-section' },
				h('h3', null, 'Connect to your Linky Live service'),
				h('p', { className: 'll-sub' },
					'One-time setup for this computer — every Local site then uses the same details. ' +
					'Ask whoever runs your Linky Live Worker for these.'),

				error ? h('div', { className: 'll-err' }, error) : null,

				h('div', { className: 'll-row' },
					h('span', { className: 'll-label' }, 'Service'),
					h('input', {
						className: 'll-wide ll-mono',
						placeholder: 'linky-live.example.com',
						value: hostDraft,
						onChange: (e) => setHostDraft(e.target.value),
					}),
				),
				h('div', { className: 'll-row' },
					h('span', { className: 'll-label' }, 'API key'),
					h('input', {
						type: 'password',
						className: 'll-wide ll-mono',
						placeholder: 'linky_…',
						value: keyDraft,
						onChange: (e) => setKeyDraft(e.target.value),
						onKeyDown: (e) => {
							if (e.key === 'Enter' && setupReady) {
								saveSetup();
							}
						},
					}),
				),

				h('div', { className: 'll-row' },
					h('button', {
						className: 'll-primary',
						disabled: busy || !setupReady,
						onClick: saveSetup,
					}, busy ? 'Saving…' : 'Connect'),
				),

				h('p', { className: 'll-sub' },
					'Running the service yourself? See the Linky Live Worker project — it deploys to a ' +
					'Cloudflare account you control.'),
			),
		);
	}

	// The saved choice, not the process state — they differ while a site is stopped.
	let statusPill;

	if (running) {
		statusPill = h('span', { className: 'll-pill ll-pill--live' }, 'Live');
	} else if (enabled) {
		statusPill = h('span', { className: 'll-pill ll-pill--warn' }, 'On — site not running');
	} else {
		statusPill = h('span', { className: 'll-pill' }, allocated ? 'Off' : 'Not set up');
	}

	/* ---- The quiet account row, shown once a key exists ---- */

	const accountRow = h('div', { className: 'll-account' },
		editingKey
			? h(React.Fragment, null,
				h('input', {
					type: 'password',
					className: 'll-wide ll-mono',
					placeholder: 'New team API key',
					value: keyDraft,
					onChange: (e) => setKeyDraft(e.target.value),
				}),
				h('button', {
					className: 'll-primary',
					disabled: busy || keyDraft.trim() === '',
					onClick: saveKey,
				}, 'Save'),
				h('button', {
					onClick: () => {
						setEditingKey(false);
						setKeyDraft('');
					},
				}, 'Cancel'),
			)
			: h(React.Fragment, null,
				h('span', {
					// There is no field for the service address after setup, so say where
					// to change it rather than leaving someone hunting for one.
					title: 'To point at a different Linky Live service, edit settings.json '
						+ 'in Local\'s user data folder and restart Local.',
				}, `${controlHostname} · key ${keyHint} — shared by all your sites.`),
				h('button', {
					className: 'll-link',
					onClick: () => setEditingKey(true),
				}, 'Change key'),
			),
	);

	/* ---- Main panel ---- */

	return panel(

		error ? h('div', { className: 'll-err' }, error) : null,

		// The most common cause of a 502 on a working link.
		enabled && !state.siteRunning
			? h('div', { className: 'll-warnbar' },
				h('strong', null, `${site.name} is not running. `),
				'The link is on, but requests will return 502 until you start the site in Local.')
			: null,

		h('div', { className: 'll-section' },
			h('div', { className: 'll-row ll-row--split' },
				h('div', null, h('h3', null, 'Live Link'), statusPill),
				h('button', {
					className: enabled ? '' : 'll-primary',
					disabled: busy,
					onClick: () => act(() => ipcAsync(enabled ? IPC.DISABLE : IPC.ENABLE, site.id)),
				}, busy ? 'Working…' : enabled ? 'Turn off' : 'Turn on'),
			),

			allocated
				? h('p', { className: 'll-sub' },
					'Turning the link off only stops the tunnel on this machine. The address stays reserved, ' +
					'so turning it back on gives you the same URL and any webhook you registered keeps ' +
					'working. While it is on, the link also returns automatically whenever the site restarts.')
				: h('p', { className: 'll-sub' },
					'Turn this on to get a permanent public HTTPS address for this site. Nothing on the site ' +
					'is changed until you do.'),
		),

		link
			? h('div', { className: 'll-section' },
				h('h3', null, 'Public address'),
				h('code', { className: 'll-url' }, link.url),
				h('div', { className: 'll-row' },
					h('button', { onClick: () => copy(link.url, 'url') },
						copied === 'url' ? 'Copied' : 'Copy URL'),
					h('button', { onClick: () => copy(`${link.url}/wp-admin/`, 'admin') },
						copied === 'admin' ? 'Copied' : 'Copy wp-admin URL'),
					h('button', {
						className: 'll-danger',
						disabled: busy,
						onClick: () => {
							/* eslint-disable-next-line no-alert */
							if (window.confirm(`Permanently release ${link.hostname}?\n\nThe address is freed for good and any webhook pointing at it will stop working.`)) {
								act(() => ipcAsync(IPC.RELEASE, site.id));
							}
						},
					}, 'Release address'),
				),
			)
			: null,

		link ? h('hr', { className: 'll-hr' }) : null,

		link
			? h('div', { className: 'll-section' },
				h('h3', null, 'Password protection'),
				h('p', { className: 'll-sub' },
					'The whole site sits behind this username and password. Edit either one and it saves ' +
					'as soon as you leave the field — changes take effect immediately.'),

				h('div', { className: 'll-row' },
					h('span', { className: 'll-label' }, 'Username'),
					h('input', {
						className: 'll-mono',
						value: userDraft,
						disabled: busy,
						onChange: (e) => setUserDraft(e.target.value),
						onBlur: (e) => commitCredential('Username', e.target.value),
						onKeyDown: (e) => {
							if (e.key === 'Enter') {
								e.target.blur();
							}
						},
					}),
					h('button', { onClick: () => copy(userDraft, 'user') },
						copied === 'user' ? 'Copied' : 'Copy'),

					credentialProblem(userDraft, 'Username')
						? h('span', { className: 'll-sub', style: { margin: 0 } },
							credentialProblem(userDraft, 'Username'))
						: null,
				),
				h('div', { className: 'll-row' },
					h('span', { className: 'll-label' }, 'Password'),
					h('input', {
						className: 'll-mono',
						value: passDraft,
						disabled: busy,
						onChange: (e) => setPassDraft(e.target.value),
						onBlur: (e) => commitCredential('Password', e.target.value),
						onKeyDown: (e) => {
							if (e.key === 'Enter') {
								e.target.blur();
							}
						},
					}),
					h('button', { onClick: () => copy(passDraft, 'pass') },
						copied === 'pass' ? 'Copied' : 'Copy'),
					h('button', { onClick: () => copy(`${userDraft}:${passDraft}`, 'creds') },
						copied === 'creds' ? 'Copied' : 'Copy both'),

					credentialProblem(passDraft, 'Password')
						? h('span', { className: 'll-sub', style: { margin: 0 } },
							credentialProblem(passDraft, 'Password'))
						: null,
				),

				h('div', { className: 'll-row' },
					h('button', {
						disabled: busy,
						onClick: () => act(async () => {
							await ipcAsync(IPC.UPDATE_AUTH, { siteId: site.id, regenerate: true });

							// Cleared so the freshly generated pair is picked up on refresh.
							setUserDraft('');
							setPassDraft('');
						}),
					}, busy ? 'Working…' : 'Generate new pair'),
				),
			)
			: null,

		link ? h('hr', { className: 'll-hr' }) : null,

		link
			? h('div', { className: 'll-section' },
				h('h3', null, 'Paths that skip the password'),
				h('p', { className: 'll-sub' },
					'For webhook and IPN listeners that cannot send a password — Stripe, PayPal, ' +
					'MemberPress. Each entry matches everything beneath it, so ',
					h('code', null, '/mepr'),
					' also covers ',
					h('code', null, '/mepr/notify'),
					'. Keep them as specific as the listener allows: anything that matches is public. ',
					'Images, CSS and fonts are already public, so pages load normally.'),

				h('p', { className: 'll-sub' },
					'You can pin query parameters to be stricter, which is also the only way to allow ',
					'a listener that lives at the site root: ',
					h('code', null, '/?action=mepr'),
					' matches ',
					h('code', null, '/?action=mepr&foo=bar'),
					' but not ',
					h('code', null, '/'),
					' on its own. Extra parameters the sender adds are ignored, and every parameter you ',
					'pin must be present.'),

				h('p', { className: 'll-sub' },
					'If a listed path returns a 404 in the browser, you will still be asked for the ' +
					'password — the 404 page names your WordPress version and plugins, so it is not ' +
					'left public. Webhooks are unaffected: they get the real response either way.'),

				h('div', { className: 'll-row' },
					(link.bypassPaths || []).length === 0
						? h('span', { className: 'll-sub' }, 'None — every request needs the password.')
						: (link.bypassPaths || []).map((p) =>
							h('span', { className: 'll-tag', key: p },
								p,
								h('button', {
									title: `Remove ${p}`,
									disabled: busy,
									onClick: () => act(() => ipcAsync(IPC.UPDATE_PATHS, {
										siteId: site.id,
										bypassPaths: link.bypassPaths.filter((x) => x !== p),
									})),
								}, '×'),
							)),
				),

				h('div', { className: 'll-row' },
					h('input', {
						className: 'll-mono',
						placeholder: '/mepr',
						value: pathDraft,
						onChange: (e) => setPathDraft(e.target.value),
						onKeyDown: (e) => {
							if (e.key === 'Enter' && pathIsValid) {
								addPath();
							}
						},
					}),
					h('button', {
						// Blocked here as well as in the worker, so a typo gives immediate
						// feedback instead of a round trip and an error banner.
						disabled: busy || !pathIsValid,
						onClick: addPath,
					}, 'Add path'),

					trimmedPath !== '' && pathProblem
						? h('span', { className: 'll-sub', style: { margin: 0 } }, pathProblem)
						: null,
				),
			)
			: null,

		accountRow,
	);
}

module.exports = function renderer(context) {
	const { hooks } = context;

	hooks.addContent('stylesheets', () =>
		h('style', { key: 'linky-live-styles', dangerouslySetInnerHTML: { __html: stylesheet } }));

	hooks.addContent('SiteInfo_TabNav_Items', (site) =>
		h(NavLink, {
			key: 'linky-live-tab',
			to: `/main/site-info/${site.id}/live-link`,
			activeClassName: 'active',
		}, 'Live Link'));

	hooks.addContent('routes[site-info]', ({ routeChildrenProps }) =>
		h(Route, {
			key: 'linky-live-route',
			path: '/main/site-info/:siteID/live-link',
			render: () => h(LiveLinkPanel, { site: routeChildrenProps.site }),
		}));
};
