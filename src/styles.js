'use strict';

/**
 * Theme-aware stylesheet for the Linky Live tab.
 *
 * Local puts a `Theme__Dark` or `Theme__Light` class on an ancestor element and
 * switches it when the user changes the appearance setting. Hardcoded colours are
 * therefore unreadable in one of the two themes, so everything here is driven by
 * custom properties that get redefined under the dark class.
 *
 * The palette values are taken from Local's own stylesheet so the panel matches
 * the screens either side of it.
 */

module.exports = `
.ll {
	--ll-fg: #262727;
	--ll-fg-strong: #1a1a1a;
	--ll-muted: #5d5e5e;
	--ll-border: #e7e7e7;
	--ll-input-border: #c7c4c4;
	--ll-panel: #f7f6f6;
	--ll-accent: #267048;
	--ll-accent-solid: #51bb7b;
	--ll-on-accent: #ffffff;
	--ll-btn-bg: #ffffff;
	--ll-err-bg: #fdf0ef;
	--ll-err-border: #f2c4c0;
	--ll-err-fg: #9c332b;
	--ll-note-bg: #f6f8fb;
	--ll-note-border: #dde5ef;
	--ll-note-fg: #4a5a70;
	--ll-ok-bg: #e6f5ec;
	--ll-ok-fg: #2f6b42;
	--ll-warn-bg: #fdf6e3;
	--ll-warn-fg: #8a6d1f;
	--ll-idle-bg: #f0f0f0;
	--ll-idle-fg: #7a7a7a;

	padding: 20px 24px 40px;
	font-size: 13px;
	color: var(--ll-fg);

	/* Local's tab body does not scroll addon content for us, so the panel bounds
	   itself against the viewport. Sized off vh rather than the parent because the
	   parent is height:auto, which makes max-height:100% unbounded and unscrollable.
	   The offset covers Local's title bar and the tab strip above this panel. */
	box-sizing: border-box;
	max-height: calc(100vh - 132px);
	overflow-y: auto;
	overscroll-behavior: contain;
}

.ll-inner { max-width: 760px; }

/* Warn when the link is on but the site it points at is not running: the tunnel
   connects and every request then 502s, which reads as a broken link. */
.ll-warnbar {
	margin-bottom: 14px;
	padding: 9px 12px;
	font-size: 12px;
	line-height: 1.55;
	border-radius: 3px;
	background: var(--ll-warn-bg);
	color: var(--ll-warn-fg);
	border: 1px solid var(--ll-border);
}

/* Local toggles this class on an ancestor when dark mode is selected. */
.Theme__Dark .ll {
	--ll-fg: #c7c4c4;
	--ll-fg-strong: #f2f2f2;
	--ll-muted: #9f9c9c;
	--ll-border: #434344;
	--ll-input-border: #5d5e5e;
	--ll-panel: #303031;
	--ll-accent: #51bb7b;
	--ll-accent-solid: #51bb7b;
	--ll-on-accent: #1a1a1a;
	--ll-btn-bg: #363637;
	--ll-err-bg: #3a2422;
	--ll-err-border: #6b3a35;
	--ll-err-fg: #f0a9a2;
	--ll-note-bg: #2b3138;
	--ll-note-border: #3d4650;
	--ll-note-fg: #aebccb;
	--ll-ok-bg: #24382c;
	--ll-ok-fg: #86d8a4;
	--ll-warn-bg: #3a3423;
	--ll-warn-fg: #ddc37a;
	--ll-idle-bg: #3a3a3b;
	--ll-idle-fg: #9f9c9c;
}

.ll h3 {
	margin: 0 0 4px;
	font-size: 13px;
	font-weight: 600;
	color: var(--ll-fg-strong);
}

.ll p.ll-sub {
	margin: 0 0 12px;
	font-size: 12px;
	line-height: 1.55;
	color: var(--ll-muted);
}

.ll-section { margin-bottom: 26px; }
.ll-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.ll-row--split { justify-content: space-between; }
.ll-hr { border: 0; border-top: 1px solid var(--ll-border); margin: 22px 0; }

.ll-label {
	width: 78px;
	font-size: 11px;
	font-weight: 600;
	letter-spacing: .04em;
	text-transform: uppercase;
	color: var(--ll-muted);
}

.ll-mono, .ll code { font-family: Menlo, Consolas, monospace; }

.ll input {
	min-width: 190px;
	padding: 6px 8px;
	font-size: 13px;
	color: var(--ll-fg-strong);
	background: var(--ll-btn-bg);
	border: 1px solid var(--ll-input-border);
	border-radius: 3px;
}
.ll input::placeholder { color: var(--ll-idle-fg); }
.ll input.ll-wide { min-width: 330px; }

.ll button {
	padding: 6px 14px;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	color: var(--ll-fg);
	background: var(--ll-btn-bg);
	border: 1px solid var(--ll-input-border);
	border-radius: 3px;
}
.ll button:disabled { opacity: .55; cursor: default; }

.ll button.ll-primary {
	padding: 7px 18px;
	color: var(--ll-on-accent);
	background: var(--ll-accent-solid);
	border-color: var(--ll-accent-solid);
}
.ll button.ll-danger { color: #d2665c; }
.ll button.ll-link {
	padding: 0;
	border: 0;
	background: none;
	color: var(--ll-accent);
	text-decoration: underline;
	font-weight: 500;
}

.ll-url {
	display: block;
	margin-bottom: 8px;
	padding: 10px 12px;
	font-family: Menlo, Consolas, monospace;
	font-size: 13px;
	word-break: break-all;
	color: var(--ll-fg-strong);
	background: var(--ll-panel);
	border: 1px solid var(--ll-border);
	border-radius: 3px;
}

.ll-urlrow {
	display: flex;
	align-items: stretch;
	gap: 8px;
	margin-bottom: 8px;
}
/* The address takes the space; its Copy button stays beside it at any width. */
.ll-urlrow .ll-url { flex: 1; margin-bottom: 0; }
.ll button.ll-copy { white-space: nowrap; }

.ll-pill {
	display: inline-block;
	padding: 2px 9px;
	font-size: 11px;
	font-weight: 600;
	border-radius: 10px;
	background: var(--ll-idle-bg);
	color: var(--ll-idle-fg);
}
.ll-pill--live { background: var(--ll-ok-bg); color: var(--ll-ok-fg); }
.ll-pill--warn { background: var(--ll-warn-bg); color: var(--ll-warn-fg); }

.ll-err, .ll-note {
	margin-bottom: 14px;
	padding: 9px 12px;
	font-size: 12px;
	line-height: 1.55;
	border-radius: 3px;
}
.ll-err {
	background: var(--ll-err-bg);
	border: 1px solid var(--ll-err-border);
	color: var(--ll-err-fg);
}
.ll-note {
	background: var(--ll-note-bg);
	border: 1px solid var(--ll-note-border);
	color: var(--ll-note-fg);
}

.ll-tag {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 3px 6px 3px 9px;
	font-family: Menlo, Consolas, monospace;
	font-size: 12px;
	border-radius: 3px;
	background: var(--ll-ok-bg);
	color: var(--ll-ok-fg);
	border: 1px solid var(--ll-border);
}
.ll-tag button {
	padding: 0;
	border: 0;
	background: none;
	color: inherit;
	font-size: 14px;
	line-height: 1;
}

/* The account row is deliberately quiet: it is set once and then ignored. */
.ll-account {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-top: 6px;
	padding-top: 14px;
	font-size: 12px;
	color: var(--ll-muted);
	border-top: 1px solid var(--ll-border);
}
`;
