// Generates the small, original TUFA fixture used in this directory.
// Run from the repository root: node examples/fixtures/generate-sample.mjs
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { OP_FLAGS, NONE } from 'slrr-jvm-decompiler';

const u16 = n => [n & 255, (n >>> 8) & 255];
const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const ascii = value => [...Buffer.from(value, 'latin1')];
const chunk = (tag, bytes) => [...ascii(tag), ...u32(bytes.length), ...bytes];
const string = value => [...u32(0), ...u32(value.length), ...ascii(value), 0];
const classRef = index => [...u32(4), ...u32(index)];
const node = (op, immediate) => [op, ...u16(10), ...((OP_FLAGS[op] >>> 12) ? u32(immediate ?? 0) : [])];
const tree = (...nodes) => [...u32(nodes.length), ...nodes.flat()];

const pool = [
  string('example.Sample'), classRef(0), string('java.lang.Object'), classRef(2),
  string('value'), string('I'), string('run'), string('()I'), string('choose'), string('(Z)I'),
];
const cons = [...u32(pool.length), ...pool.flat()];
const fild = [...u32(0), ...u32(1), ...u32(1), ...u32(4), ...u32(5), ...u32(0)];
const mthd = [...u32(0), ...u32(2),
  ...u32(1), ...u32(6), ...u32(7), ...u32(1), ...u32(1),
  ...u32(1), ...u32(8), ...u32(9), ...u32(2), ...u32(2)];
const clss = [...u32(NONE), ...u32(0), ...u32(1), ...u32(3), ...u32(0)];
const trees = [
  tree(node(7, 28), node(11, 7), node(16)),
  tree(node(7, 28), node(11, 1), node(40), node(3, 0), node(43), node(3, 0)),
  tree(node(1, 1), node(21, 6), node(7, 28), node(11, 2), node(40), node(3, 0), node(43), node(7, 28), node(11, 3), node(40), node(3, 0), node(43)),
];

const bytes = Uint8Array.from([
  ...chunk('TUFA', u32(0x24f9d)), ...chunk('CONS', cons), ...chunk('FILD', fild),
  ...chunk('MTHD', mthd), ...chunk('CLSS', clss), ...chunk('TREE', [...u32(trees.length), ...trees.flat()]),
]);
const output = fileURLToPath(new URL('./Sample.class', import.meta.url));
await writeFile(output, bytes);
console.log(`Wrote ${output} (${bytes.length} bytes)`);
