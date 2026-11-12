import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8');
const functionSource = source.match(/function waitForExamForm\([\s\S]*?\n\}/)[0];
const shortUrl = 'https://forms.gle/UdJaLxDVyhiYuW738';
const formUrl = 'https://docs.google.com/forms/d/e/1FAIpQLScz5oELPRBV4PkBsB6GYwkk6k4cp69xvw8F3mGDn1SA1p-e6g/viewform';

async function waitForForm(expected, initial, { updated, fallback } = {}) {
  const listeners = new Set();
  let reads = 0;
  const chrome = {
    tabs: {
      get: async () => ++reads === 1 ? initial : fallback ?? initial,
      onUpdated: {
        addListener: listener => {
          listeners.add(listener);
          if (updated) queueMicrotask(() => listener(7, { status: 'complete' }, updated));
        },
        removeListener: listener => listeners.delete(listener),
      },
    },
  };
  const wait = runInNewContext(`${functionSource}\nwaitForExamForm`, { chrome, URL, setTimeout, clearTimeout });
  const result = await wait(7, expected, 10);
  assert.equal(listeners.size, 0);
  return result;
}

test('accepts an already-loaded shortlink redirect', async () => {
  assert.equal(await waitForForm(shortUrl, { url: formUrl, status: 'complete' }), true);
});

test('accepts an already-loaded canonical Google Form', async () => {
  assert.equal(await waitForForm(formUrl, { url: formUrl, status: 'complete' }), true);
});

test('accepts a Google Forms redirect in the completion event', async () => {
  assert.equal(await waitForForm(shortUrl, { url: shortUrl, status: 'loading' }, {
    updated: { url: formUrl, status: 'complete' },
  }), true);
});

test('accepts a completed redirect at the timeout fallback', async () => {
  assert.equal(await waitForForm(shortUrl, { url: shortUrl, status: 'loading' }, {
    fallback: { url: formUrl, status: 'complete' },
  }), true);
});

test('rejects a redirect outside the allowed Google hosts', async () => {
  assert.equal(await waitForForm(shortUrl, { url: 'https://example.com/', status: 'complete' }), false);
});

test('does not treat Google hosts as equivalent to an unrelated expected host', async () => {
  assert.equal(await waitForForm('https://example.com/', { url: formUrl, status: 'complete' }), false);
});

test('does not accept an incomplete form', async () => {
  assert.equal(await waitForForm(shortUrl, { url: formUrl, status: 'loading' }), false);
});

test('rejects an invalid expected URL', async () => {
  assert.equal(await waitForForm('invalid', { url: formUrl, status: 'complete' }), false);
});
