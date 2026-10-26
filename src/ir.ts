import type { TufaClass, TreeNode } from './tufa.js';

export const OPCODES = [
  'invalid', 'local', 'declare', 'release', 'and_test', 'or_test', 'type', 'expr',
  'stmt', 'str', 'float', 'int', 'null', 'bool', 'rid', 'unused', 'end', 'path',
  'name', 'invalid', 'jump', 'jump_false', 'jump_true', 'case', 'pop', 'class',
  'method', 'field', 'getfield', 'unused', 'array_init', 'push_zeros', 'index',
  'new_init', 'this_init', 'super_init', 'call', 'call_on', 'call_super', 'push_int',
  'value', 'push_void', 'ret', 'ret_value', 'init', 'store', 'unused', 'invalid',
] as const;

export const TAGS = [
  'cond', 'lor', 'land', 'bor', 'bxor', 'band', 'ne', 'eq', 'ge', 'le', 'gt', 'lt',
  'unused', 'shr', 'shl', 'sub', 'add', 'mod', 'div', 'mul', 'bnot', 'lnot', 'neg',
  'postinc', 'postdec', 'preinc', 'predec', 'call', 'literal', 'unused', 'new',
  'newarray', 'instanceof', 'cast', 'ctor', 'assign', 'mul_assign', 'div_assign',
  'mod_assign', 'add_assign', 'sub_assign', 'unused', 'unused', 'unused',
  'and_assign', 'xor_assign', 'or_assign',
] as const;

export type IrOperand = string | number | { owner: string; name: string; descriptor: string } | { pack: string; id: number };
export interface IrInstruction {
  index: number;
  line: number;
  op: number;
  name: string;
  raw?: number;
  operand?: IrOperand;
  target?: number;
}
export interface BasicBlock {
  id: number;
  start: number;
  end: number;
  instructions: IrInstruction[];
  successors: number[];
  predecessors: number[];
}
export interface IrMethod { className: string; methodName: string; descriptor: string; treeIndex: number; instructions: IrInstruction[]; blocks: BasicBlock[]; }

function signed(n: number): number { return n | 0; }
function floatBits(n: number): number {
  const b = new ArrayBuffer(4);
  new DataView(b).setUint32(0, n, true);
  return new DataView(b).getFloat32(0, true);
}

export function lowerTree(cls: TufaClass, treeIndex: number, methodName = `tree${treeIndex}`, descriptor = ''): IrMethod {
  const tree = cls.trees[treeIndex];
  if (!tree) throw new Error(`${cls.name}: missing tree ${treeIndex}`);
  const instructions = tree.map((node: TreeNode): IrInstruction => {
    const { op, immediate } = node;
    const base: IrInstruction = { index: node.index, line: node.line, op, name: OPCODES[op] ?? `op${op}` };
    if (immediate === undefined) return base;
    base.raw = immediate;
    if (op === 7 || op === 8) base.name += ` ${TAGS[immediate] ?? `tag${immediate}`}`;
    if (op === 20 || op === 21 || op === 22 || op === 23) {
      base.target = node.index + signed(immediate);
      if (base.target < 0 || base.target > tree.length) throw new Error(`${cls.name}.${methodName}: jump ${node.index} leaves tree`);
      base.operand = signed(immediate);
    } else if (op === 6 || op === 9 || op === 18 || op === 28 || op === 37 || op === 38 || op === 46) base.operand = cls.utf8(immediate);
    else if (op === 14) base.operand = cls.resource(immediate);
    else if (op === 25) base.operand = cls.className(immediate);
    else if (op === 26 || op === 27) base.operand = cls.reference(immediate);
    else if (op === 10) base.operand = floatBits(immediate);
    else if (op === 11 || op === 39) base.operand = signed(immediate);
    else base.operand = immediate;
    return base;
  });
  return { className: cls.name, methodName, descriptor, treeIndex, instructions, blocks: buildBlocks(instructions) };
}

export function buildBlocks(instructions: IrInstruction[]): BasicBlock[] {
  if (!instructions.length) return [];
  const ends = new Set([0, instructions.length]);
  for (const ins of instructions) {
    if (ins.target !== undefined) { ends.add(ins.target); ends.add(ins.index + 1); }
    if ([16, 42, 43].includes(ins.op)) ends.add(ins.index + 1);
  }
  const sorted = [...ends].sort((a, b) => a - b);
  const blocks: BasicBlock[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i], end = sorted[i + 1];
    if (start < end) blocks.push({ id: blocks.length, start, end, instructions: instructions.slice(start, end), successors: [], predecessors: [] });
  }
  const byStart = new Map(blocks.map(b => [b.start, b]));
  for (const block of blocks) {
    const last = block.instructions.at(-1)!;
    const target = last.target === undefined ? undefined : byStart.get(last.target);
    const next = byStart.get(block.end);
    if (target) block.successors.push(target.id);
    if (![20, 16, 42, 43].includes(last.op) && next && !block.successors.includes(next.id)) block.successors.push(next.id);
  }
  for (const block of blocks) for (const id of block.successors) blocks[id].predecessors.push(block.id);
  return blocks;
}

export function formatIr(ir: IrMethod): string {
  const labels = new Set(ir.blocks.map(b => b.start));
  const out = [`${ir.className}.${ir.methodName}${ir.descriptor} / TREE ${ir.treeIndex}`];
  out.push(...ir.blocks.map(block =>
    `  B${block.id}: L${block.start}..L${block.end} -> ${block.successors.map(id => `B${id}`).join(', ') || 'exit'}`));
  for (const ins of ir.instructions) {
    if (labels.has(ins.index)) out.push(`L${ins.index}:`);
    const operand = ins.operand === undefined ? '' : ` ${typeof ins.operand === 'object' ? JSON.stringify(ins.operand) : String(ins.operand)}`;
    const target = ins.target === undefined ? '' : ` -> L${ins.target}`;
    out.push(`  ${String(ins.index).padStart(4)}  src:${String(ins.line).padStart(4)}  ${ins.name}${operand}${target}`);
  }
  if (labels.has(ir.instructions.length)) out.push(`L${ir.instructions.length}:`);
  return out.join('\n');
}
