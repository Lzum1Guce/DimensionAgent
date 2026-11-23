import assert from 'node:assert/strict';
import test from 'node:test';
import { readLocalSeal, writeLocalSeal } from '../ui/paper-seal.js';

test('local seals follow external edits and only expose persisted writes', (t) => {
  let value = JSON.stringify({ first: { pinned: true } });
  let rejectWrites = false;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => value,
    setItem(key, text) {
      if (rejectWrites) throw new Error('quota');
      value = text;
    },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });

  assert.equal(readLocalSeal('first').pinned, true);
  value = JSON.stringify({ first: { pinned: false } });
  assert.equal(readLocalSeal('first').pinned, false);
  rejectWrites = true;
  writeLocalSeal('second', { pinned: true });
  assert.equal(readLocalSeal('second'), null);
  rejectWrites = false;
  writeLocalSeal('second', { pinned: true });
  assert.equal(readLocalSeal('second').pinned, true);
  assert.equal(readLocalSeal('first').pinned, false);
  value = '{';
  assert.equal(readLocalSeal('second'), null);
  value = null;
  assert.equal(readLocalSeal('first'), null);
});
