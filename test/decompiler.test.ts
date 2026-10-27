import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decompileClass, decodeMethod } from '../src/decompile.js';
import { formatIr, lowerTree } from '../src/ir.js';
import { NONE, OP_FLAGS, parseTufa, recoverMissingClassName } from '../src/tufa.js';

const u16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const ascii = (s: string): number[] => [...Buffer.from(s, 'latin1')];
const chunk = (tag: string, bytes: number[]): number[] => [...ascii(tag), ...u32(bytes.length), ...bytes];
const string = (value: string): number[] => [...u32(0), ...u32(value.length), ...ascii(value), 0];
const classRef = (index: number): number[] => [...u32(4), ...u32(index)];
const node = (op: number, immediate?: number): number[] => [op, ...u16(10), ...((OP_FLAGS[op] >>> 12) ? u32(immediate ?? 0) : [])];
const tree = (...nodes: number[][]): number[] => [...u32(nodes.length), ...nodes.flat()];

function sample(): Uint8Array {
  const pool = [
    string('example.Sample'), classRef(0), string('java.lang.Object'), classRef(2),
    string('value'), string('I'), string('run'), string('()I'), string('branch'),
    string('TUFA inside the pool is not a class boundary'),
  ];
  const cons = [...u32(pool.length), ...pool.flat()];
  const fild = [...u32(0), ...u32(1), ...u32(1), ...u32(4), ...u32(5), ...u32(0)];
  const mthd = [...u32(0), ...u32(2),
    ...u32(1), ...u32(6), ...u32(7), ...u32(1), ...u32(1),
    ...u32(1), ...u32(8), ...u32(7), ...u32(2), ...u32(1)];
  const clss = [...u32(NONE), ...u32(0), ...u32(1), ...u32(3), ...u32(0)];
  const trees = [
    tree(node(7, 28), node(11, 7), node(16)),
    tree(node(7, 28), node(11, 1), node(40), node(3, 0), node(43), node(3, 0)),
    tree(node(7, 28), node(11, 1), node(21, 6), node(7, 28), node(11, 2), node(40), node(3, 0), node(43), node(7, 28), node(11, 3), node(40), node(3, 0), node(43)),
  ];
  return Uint8Array.from([
    ...chunk('TUFA', u32(0x24f9d)), ...chunk('CONS', cons), ...chunk('FILD', fild),
    ...chunk('MTHD', mthd), ...chunk('CLSS', clss), ...chunk('TREE', [...u32(trees.length), ...trees.flat()]),
  ]);
}

test('TUFA parser respects chunk boundaries and decodes references', () => {
  const bytes = sample();
  const classes = parseTufa(Uint8Array.from([...bytes, ...bytes]));
  assert.equal(classes.length, 2);
  assert.equal(classes[0].name, 'example.Sample');
  assert.equal(classes[0].superName, 'java.lang.Object');
  assert.equal(classes[0].trees.length, 3);
  assert.equal(classes[0].utf8(9), 'TUFA inside the pool is not a class boundary');
});

test('bad jump targets are rejected during lowering', () => {
  const cls = parseTufa(sample())[0];
  cls.trees[1][2].op = 20;
  cls.trees[1][2].immediate = 0x7fffffff;
  assert.throws(() => lowerTree(cls, 1), /leaves tree/);
});

test('missing mod class names can be recovered from the class filename', () => {
  const cls = parseTufa(sample())[0];
  const ownName = cls.constants[0];
  assert.equal(ownName.kind, 'utf8');
  ownName.text = '';
  assert.equal(recoverMissingClassName(cls, 'Sample'), true);
  assert.equal(cls.name, 'Sample');
  assert.match(decompileClass(cls).source, /public class Sample/);
  assert.equal(recoverMissingClassName(cls, 'Other'), false);
});

test('constructor descriptors omit return types in TUFA', () => {
  assert.deepEqual(decodeMethod('(IF)'), { parameters: ['int', 'float'], returns: 'void' });
  assert.deepEqual(decodeMethod('()Ljava.lang.String;'), { parameters: [], returns: 'java.lang.String' });
});

test('IR contains CFG edges and Java output structures a branch', () => {
  const cls = parseTufa(sample())[0];
  const ir = lowerTree(cls, 2, 'branch', '()I');
  assert.match(formatIr(ir), /B0: L0\.\.L3 -> B2, B1/);
  const result = decompileClass(cls);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.source, /int value = 7;/);
  assert.match(result.source, /if \(1\) \{/);
  assert.match(result.source, /return 2;/);
  assert.match(result.source, /return 3;/);
});

test('truncated files fail explicitly', () => {
  const bytes = sample();
  assert.throws(() => parseTufa(bytes.subarray(0, bytes.length - 1)), /truncated/);
});

test('switch dispatch becomes case groups', () => {
  const cls = parseTufa(sample())[0];
  const ops: [number, number?][] = [
    [7, 28], [11, 1], [7, 28], [11, 0], [23, 3], [24], [20, 6],
    [7, 28], [11, 2], [40], [3, 0], [43],
    [7, 28], [11, 3], [40], [3, 0], [43],
  ];
  const treeIndex = cls.trees.push(ops.map(([op, immediate], index) => ({ index, offset: index * 7, op, line: 10, ...(immediate === undefined ? {} : { immediate }) }))) - 1;
  cls.instanceMethods.push({ flags: 1, name: 8, descriptor: 7, tree: treeIndex, locals: 1 });
  const result = decompileClass(cls);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.source, /switch \(1\) \{/);
  assert.match(result.source, /case 0:/);
  assert.match(result.source, /return 2;/);
});

test('backward conditional becomes do-while', () => {
  const cls = parseTufa(sample())[0];
  cls.constants.push({ kind: 'utf8', text: '()V' });
  const ops: [number, number?][] = [
    [8, 28], [11, 7], [7, 28], [11, 0], [22, 0xfffffffc],
    [41], [3, 0], [43], [3, 0],
  ];
  const treeIndex = cls.trees.push(ops.map(([op, immediate], index) => ({ index, offset: index * 7, op, line: 10, ...(immediate === undefined ? {} : { immediate }) }))) - 1;
  cls.instanceMethods.push({ flags: 1, name: 8, descriptor: 10, tree: treeIndex, locals: 1 });
  const result = decompileClass(cls);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.source, /do \{/);
  assert.match(result.source, /\} while \(0\);/);
});

test('a return branch does not release a reused local in the following code', () => {
  const cls = parseTufa(sample())[0];
  const ops: [number, number?][] = [
    [2, 1], [6, 5], [44], [7, 28], [11, 2], [45], [3, 1],
    [2, 1], [6, 5], [44], [7, 28], [11, 3], [45],
    [7, 28], [11, 1], [21, 6],
    [1, 1], [40], [3, 1], [3, 0], [43],
    [1, 1], [8, 24], [1, 1], [40], [3, 1], [3, 0], [43],
  ];
  const treeIndex = cls.trees.push(ops.map(([op, immediate], index) => ({
    index, offset: index * 7, op, line: 10, ...(immediate === undefined ? {} : { immediate }),
  }))) - 1;
  cls.instanceMethods[1].tree = treeIndex;
  const result = decompileClass(cls);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.source, /local1_2--;/);
});

test('all increment and decrement tags preserve direction and prefix position', () => {
  const cls = parseTufa(sample())[0];
  const descriptor = cls.constants.push({ kind: 'utf8', text: '(I)I' }) - 1;
  const ops: [number, number?][] = [
    [1, 1], [8, 24], [1, 1], [8, 26],
    [1, 1], [8, 23], [1, 1], [8, 25],
    [1, 1], [40], [3, 1], [3, 0], [43],
  ];
  const treeIndex = cls.trees.push(ops.map(([op, immediate], index) => ({ index, offset: index * 7, op, line: 10, ...(immediate === undefined ? {} : { immediate }) }))) - 1;
  cls.instanceMethods.push({ flags: 1, name: 8, descriptor, tree: treeIndex, locals: 2 });
  const result = decompileClass(cls);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.source, /arg0--;/);
  assert.match(result.source, /--arg0;/);
  assert.match(result.source, /arg0\+\+;/);
  assert.match(result.source, /\+\+arg0;/);
});
