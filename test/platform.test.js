'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { assetForPlatform } = require('../src/cloudflared');

/**
 * Every asset named here must actually exist in Cloudflare's releases. Asking for
 * one that does not gives a teammate a 404 and a dead end on first use, on a
 * machine the author probably does not own.
 *
 * Verified against cloudflared 2026.8.2: there is no windows-arm64 build.
 */
const PUBLISHED = new Set([
	'cloudflared-windows-amd64.exe',
	'cloudflared-windows-386.exe',
	'cloudflared-darwin-amd64.tgz',
	'cloudflared-darwin-arm64.tgz',
	'cloudflared-linux-amd64',
	'cloudflared-linux-arm64',
	'cloudflared-linux-386',
	'cloudflared-linux-arm',
]);

function withPlatform(platform, arch, fn) {
	const origPlatform = process.platform;
	const origArch = process.arch;

	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	Object.defineProperty(process, 'arch', { value: arch, configurable: true });

	try {
		return fn();
	} finally {
		Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
		Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
	}
}

test('every platform maps to an asset that actually exists', () => {
	const combos = [
		['win32', 'x64'],
		['win32', 'arm64'],
		['darwin', 'x64'],
		['darwin', 'arm64'],
		['linux', 'x64'],
		['linux', 'arm64'],
	];

	for (const [platform, arch] of combos) {
		const target = withPlatform(platform, arch, assetForPlatform);

		assert.ok(target, `${platform}/${arch} must resolve to a target`);
		assert.ok(
			PUBLISHED.has(target.asset),
			`${platform}/${arch} asks for ${target.asset}, which Cloudflare does not publish`,
		);
	}
});

test('Windows ARM falls back to the x64 build', () => {
	// Cloudflare ships no windows-arm64 binary. Windows runs amd64 under emulation,
	// so the fallback is correct; requesting arm64 would 404.
	const target = withPlatform('win32', 'arm64', assetForPlatform);

	assert.equal(target.asset, 'cloudflared-windows-amd64.exe');
	assert.equal(target.binary, 'cloudflared.exe');
	assert.equal(target.archive, false);
});

test('macOS is the only platform needing extraction', () => {
	for (const [platform, arch, archive] of [
		['darwin', 'x64', true],
		['darwin', 'arm64', true],
		['win32', 'x64', false],
		['linux', 'x64', false],
		['linux', 'arm64', false],
	]) {
		assert.equal(
			withPlatform(platform, arch, assetForPlatform).archive,
			archive,
			`${platform}/${arch} archive flag`,
		);
	}
});

test('the Windows binary keeps its .exe extension', () => {
	// Without it the spawn fails on Windows.
	assert.equal(withPlatform('win32', 'x64', assetForPlatform).binary, 'cloudflared.exe');
	assert.equal(withPlatform('darwin', 'arm64', assetForPlatform).binary, 'cloudflared');
	assert.equal(withPlatform('linux', 'x64', assetForPlatform).binary, 'cloudflared');
});

test('an unsupported platform reports itself instead of guessing', () => {
	// Returning a wrong asset would fail confusingly at download time; null lets
	// ensureBinary raise a clear error naming the platform.
	assert.equal(withPlatform('aix', 'ppc64', assetForPlatform), null);
	assert.equal(withPlatform('freebsd', 'x64', assetForPlatform), null);
});
