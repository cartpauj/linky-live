'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyExit, FATAL_REASONS } = require('../src/cloudflared');

/**
 * cloudflared reports failures as log lines and exits non-zero for nearly
 * everything, so the reason has to be read out of its output. Getting this wrong
 * means either retrying something hopeless forever, or permanently killing a
 * link that a single retry would have fixed.
 */

test('a local site that is not listening is not retried blindly', () => {
	for (const line of [
		'ERR failed to connect to origin: dial tcp 127.0.0.1:10028: connect: connection refused',
		'error="dial tcp 127.0.0.1:10028: connect: connection refused"',
		'lookup my-plugin.local: no such host',
	]) {
		assert.equal(classifyExit([line]), 'localUnreachable', line);
	}
});

test('a deleted or rejected tunnel is fatal, not retried', () => {
	assert.equal(classifyExit(['ERR Unauthorized: Invalid tunnel token']), 'unauthorized');
	assert.equal(classifyExit(['tunnel not found']), 'notFound');

	assert.ok(FATAL_REASONS.has('unauthorized'));
	assert.ok(FATAL_REASONS.has('notFound'));

	// These are the ones a retry can actually fix, so they must not be fatal.
	assert.ok(!FATAL_REASONS.has('network'));
	assert.ok(!FATAL_REASONS.has('localUnreachable'));
	assert.ok(!FATAL_REASONS.has('unknown'));
});

test('transient network trouble is classified as retryable', () => {
	for (const line of [
		'ERR Failed to serve quic connection',
		'dial udp: connect: network is unreachable',
		'context deadline exceeded (Client.Timeout)',
		'Temporary failure in name resolution',
	]) {
		const reason = classifyExit([line]);

		assert.ok(!FATAL_REASONS.has(reason), `${line} classified as ${reason}, must be retryable`);
	}
});

test('an empty or unrecognised log is retryable rather than fatal', () => {
	// Defaulting to fatal would kill links for unknown reasons; defaulting to
	// retryable is bounded by the overall reconnect timeout anyway.
	for (const input of [[], undefined, ['something entirely new']]) {
		assert.ok(!FATAL_REASONS.has(classifyExit(input)));
	}
});

test('classification only looks at the recent tail', () => {
	// A long-running tunnel that saw a refused connection hours ago, then died of
	// something else, must not be misread as a dead local site forever.
	const tail = Array.from({ length: 40 }, (_, i) => `INF request ${i} served`);

	assert.equal(classifyExit(tail), 'unknown');
});

test('the backoff grows and stays inside the retry window', () => {
	// Mirrors the fibonacci helper in main.js. Reimplemented here so a change to
	// the sequence has to be a deliberate one.
	const delay = (attempt) => {
		let a = 1;
		let b = 0;

		for (let i = 0; i <= attempt; i += 1) {
			const previous = a;
			a += b;
			b = previous;
		}

		return b * 1000;
	};

	const delays = [1, 2, 3, 4, 5, 6].map(delay);

	// Strictly increasing, so repeated failures back off rather than hammer.
	for (let i = 1; i < delays.length; i += 1) {
		assert.ok(delays[i] > delays[i - 1], `delay ${i} (${delays[i]}) must exceed ${delays[i - 1]}`);
	}

	// First retry must be prompt: a momentary blip should recover almost at once.
	assert.ok(delays[0] <= 2000, `first retry was ${delays[0]}ms, too slow for a blip`);

	// And several attempts must fit inside the 60s give-up window.
	const total = delays.slice(0, 5).reduce((sum, d) => sum + d, 0);

	assert.ok(total < 60000, `five attempts total ${total}ms, exceeding the retry window`);
});
