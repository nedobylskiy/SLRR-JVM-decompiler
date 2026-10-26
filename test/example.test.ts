import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decompileClass, formatIr, lowerTree, parseTufa } from '../src/index.js';

test('committed class example matches its decompiled source and IR', async () => {
  const fixture = (name: string): URL => new URL(`../../examples/fixtures/${name}`, import.meta.url);
  const classes = parseTufa(await readFile(fixture('Sample.class')));
  assert.equal(classes.length, 1);
  const cls = classes[0];
  const result = decompileClass(cls);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.source, await readFile(fixture('Sample.java'), 'utf8'));
  const ir = cls.trees.map((_, index) => formatIr(lowerTree(cls, index))).join('\n\n') + '\n';
  assert.equal(ir, await readFile(fixture('Sample.ir'), 'utf8'));
});
