import { formatIr, lowerTree, type IrInstruction, type IrMethod } from './ir.js';
import { NONE, type Member, type TufaClass } from './tufa.js';

export interface DecompileResult { source: string; diagnostics: string[]; intermediate: IrMethod[]; }

const symbols: Record<number, string> = {
  1: '||', 2: '&&', 3: '|', 4: '^', 5: '&', 6: '!=', 7: '==', 8: '>=', 9: '<=',
  10: '>', 11: '<', 13: '>>', 14: '<<', 15: '-', 16: '+', 17: '%', 18: '/', 19: '*',
  35: '=', 36: '*=', 37: '/=', 38: '%=', 39: '+=', 40: '-=', 44: '&=', 45: '^=', 46: '|=',
};

function typeAt(descriptor: string, offset: number): [string, number] {
  const c = descriptor[offset];
  if (c === '[') {
    const [type, end] = typeAt(descriptor, offset + 1);
    return [`${type}[]`, end];
  }
  if (c === 'L') {
    const end = descriptor.indexOf(';', offset);
    if (end < 0) throw new Error(`Invalid type descriptor ${descriptor}`);
    if (end === offset + 1) return ['java.lang.Object', end + 1]; // Some shipped system classes have the incomplete descriptor L;.
    return [descriptor.slice(offset + 1, end).replaceAll('/', '.'), end + 1];
  }
  const type = ({ V: 'void', I: 'int', F: 'float', D: 'double', Z: 'boolean', B: 'byte', C: 'char', S: 'short', J: 'long' } as Record<string, string>)[c];
  if (!type) throw new Error(`Invalid type descriptor ${descriptor}`);
  return [type, offset + 1];
}

export function decodeType(descriptor: string): string {
  const [type, end] = typeAt(descriptor, 0);
  if (end !== descriptor.length) throw new Error(`Invalid type descriptor ${descriptor}`);
  return type;
}

export function decodeMethod(descriptor: string): { parameters: string[]; returns: string } {
  if (!descriptor.startsWith('(')) throw new Error(`Invalid method descriptor ${descriptor}`);
  let i = 1;
  const parameters: string[] = [];
  while (descriptor[i] !== ')') {
    if (i >= descriptor.length) throw new Error(`Invalid method descriptor ${descriptor}`);
    const [param, next] = typeAt(descriptor, i);
    parameters.push(param); i = next;
  }
  if (i + 1 === descriptor.length) return { parameters, returns: 'void' }; // TUFA constructors omit the return descriptor.
  const [returns, end] = typeAt(descriptor, i + 1);
  if (end !== descriptor.length) throw new Error(`Invalid method descriptor ${descriptor}`);
  return { parameters, returns };
}

function flags(bits: number): string {
  const fields: [number, string][] = [[1, 'public'], [2, 'protected'], [4, 'private'], [8, 'static'], [16, 'abstract'], [32, 'final'], [64, 'native'], [128, 'synchronized']];
  return fields.filter(([bit]) => (bits & bit) !== 0).map(([, name]) => name).join(' ');
}

function simple(name: string): string { return name.split('.').at(-1)!; }
function indent(depth: number): string { return '    '.repeat(depth); }
function defaultValue(type: string): string { return type === 'boolean' ? 'false' : type === 'float' ? '0.0' : type === 'void' ? '' : ['int', 'byte', 'short', 'long', 'double', 'char'].includes(type) ? '0' : 'null'; }

class TypeNames {
  readonly imports = new Set<string>();
  private readonly bySimple = new Map<string, Set<string>>();
  constructor(cls: TufaClass) {
    const add = (name: string): void => {
      if (!name.includes('.') || name.startsWith('[')) return;
      const short = simple(name), set = this.bySimple.get(short) ?? new Set<string>();
      set.add(name); this.bySimple.set(short, set);
    };
    add(cls.name);
    if (cls.superName) add(cls.superName);
    for (const index of cls.interfaceIndices) add(cls.className(index));
    for (let i = 0; i < cls.constants.length; i++) {
      const entry = cls.constants[i];
      if (entry.kind === 'class') add(cls.className(i));
      if (entry.kind === 'reference') add(cls.reference(i).owner);
      if (entry.kind === 'utf8') for (const match of entry.text.matchAll(/L([^;]+);/g)) add(match[1]);
    }
    const ownPackage = cls.name.split('.').slice(0, -1).join('.');
    for (const set of this.bySimple.values()) if (set.size === 1) {
      const name = [...set][0], pkg = name.split('.').slice(0, -1).join('.');
      if (pkg !== ownPackage && pkg !== 'java.lang') this.imports.add(`${pkg}.*`);
    }
  }
  name(fqn: string): string {
    return this.bySimple.get(simple(fqn))?.size === 1 ? simple(fqn) : fqn;
  }
  type(type: string): string {
    return type.replace(/\b(?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*\b/g, name => this.name(name));
  }
}

class BodyWriter {
  readonly ins: IrInstruction[];
  readonly stack: string[] = [];
  readonly locals = new Map<number, string>();
  readonly lines: string[] = [];
  private pending?: { slot: number; type: string; name: string };
  private temporary = 0;
  private readonly declarations = new Map<number, number>();
  constructor(readonly cls: TufaClass, readonly member: Member, readonly ir: IrMethod, readonly types: TypeNames, fieldMode = false) {
    this.ins = ir.instructions;
    if (fieldMode) return;
    const params = decodeMethod(cls.utf8(member.descriptor)).parameters;
    const isStatic = (member.flags & 8) !== 0;
    if (!isStatic) this.locals.set(0, 'this');
    for (let i = 0; i < params.length; i++) this.locals.set((isStatic ? 0 : 1) + params.length - 1 - i, `arg${i}`);
  }
  private fail(pc: number, detail: string): never { throw new Error(`${this.cls.name}.${this.ir.methodName} TREE ${this.ir.treeIndex}:${pc}: ${detail}`); }
  private pop(pc: number): string { const v = this.stack.pop(); if (v === undefined) this.fail(pc, 'operand stack underflow'); return v; }
  private push(v: string): void { this.stack.push(v); }
  private emit(depth: number, value: string): void { this.lines.push(`${indent(depth)}${value}`); }
  private local(slot: number): string { return this.locals.get(slot) ?? `local${slot}`; }
  private raw(pc: number): number { return this.ins[pc]?.raw ?? this.fail(pc, 'missing immediate'); }
  private text(pc: number): string { return String(this.ins[pc]?.operand ?? this.fail(pc, 'missing operand')); }

  private literal(pc: number): string {
    const node = this.ins[pc];
    switch (node?.op) {
      case 9: return JSON.stringify(node.operand);
      case 10: { const n = Number(node.operand); return Number.isInteger(n) ? `${n}.0` : String(n); }
      case 11: return String(node.operand);
      case 12: return 'null';
      case 13: return node.raw ? 'true' : 'false';
      case 14: {
        const value = node.operand as { pack: string; id: number };
        return `${value.pack.replace(/\.rpk$/i, '').replaceAll(/[\\/]/g, '.')}:0x${value.id.toString(16)}r`;
      }
      default: return this.fail(pc, 'expected literal carrier');
    }
  }

  private path(start: number): { value: string; next: number } {
    let p = start, count = 1;
    if (this.ins[p]?.op === 17) { count = this.raw(p); p++; }
    if (count <= 0 || count > 128) this.fail(start, `invalid path count ${count}`);
    const parts: string[] = [];
    for (let i = 0; i < count; i++, p++) {
      const node = this.ins[p];
      if (!node) this.fail(p, 'incomplete path');
      if (node.op === 1) parts.push(this.local(this.raw(p)));
      else if (node.op === 18) parts.push(this.text(p));
      else if (node.op === 25) parts.push(this.types.name(this.text(p)));
      else if (node.op === 26 || node.op === 27) parts.push((node.operand as { name: string }).name);
      else this.fail(p, `unexpected path node ${node.name}`);
    }
    // One unqualified method name is an implicit call on this (or its class).
    return { value: parts.join('.'), next: p };
  }

  private args(pc: number): string[] {
    const count = Number(this.pop(pc));
    if (!Number.isSafeInteger(count) || count < 0 || count > 128) this.fail(pc, `invalid argument count ${count}`);
    const args: string[] = [];
    for (let i = 0; i < count; i++) args.unshift(this.pop(pc));
    return args;
  }

  private expression(pc: number, depth: number): number {
    const node = this.ins[pc];
    if (!node) this.fail(pc, 'missing instruction');
    switch (node.op) {
      case 1: this.push(this.local(this.raw(pc))); return pc + 1;
      case 2: {
        const typeNode = this.ins[pc + 1];
        if (typeNode?.op !== 6) this.fail(pc, 'declaration missing type carrier');
        const slot = this.raw(pc), type = this.types.type(decodeType(String(typeNode.operand)));
        const ordinal = (this.declarations.get(slot) ?? 0) + 1;
        this.declarations.set(slot, ordinal);
        const name = `local${slot}${ordinal > 1 ? `_${ordinal}` : ''}`;
        this.locals.set(slot, name);
        if (this.ins[pc + 2]?.op === 44) {
          this.pending = { slot, type, name };
          this.push(name);
          return pc + 3;
        }
        this.emit(depth, `${type} ${name};`);
        return pc + 2;
      }
      case 3: {
        if (this.locals.get(this.raw(pc))?.startsWith('local')) this.locals.delete(this.raw(pc));
        return pc + 1; // Scope release is represented by the structured block.
      }
      case 6: case 9: case 10: case 11: case 12: case 13: case 14: case 18: case 25: case 26: case 44:
        this.fail(pc, `orphan carrier ${node.name}`);
      case 7: case 8: {
        const tag = this.raw(pc), statement = node.op === 8;
        if (tag === 28) {
          const value = this.literal(pc + 1);
          if (!statement) this.push(value);
          return pc + 2;
        }
        if (tag === 30) {
          if (this.ins[pc + 1]?.op !== 6) this.fail(pc, 'new missing type');
          this.push(`new ${this.types.type(decodeType(this.text(pc + 1)))}`);
          return pc + 2;
        }
        if (tag === 31) {
          if (this.ins[pc + 1]?.op !== 6) this.fail(pc, 'new array missing type');
          const size = this.pop(pc), type = this.types.type(decodeType(this.text(pc + 1))).replace(/\[\]$/, '');
          this.push(`new ${type}[${size}]`); return pc + 2;
        }
        if (tag === 32 || tag === 33) {
          const typeNode = this.ins[pc + 1];
          if (!typeNode || ![6, 25].includes(typeNode.op)) this.fail(pc, 'type operation missing carrier');
          const type = this.types.type(typeNode.op === 6 ? decodeType(this.text(pc + 1)) : this.text(pc + 1));
          const value = this.pop(pc);
          this.push(tag === 32 ? `(${value} instanceof ${type})` : `((${type}) ${value})`);
          return pc + 2;
        }
        if (tag === 34) return pc + 1; // Constructor call marker.
        if (tag === 27) {
          const value = this.pop(pc);
          if (statement) this.emit(depth, `${value};`);
          else this.push(value);
          return pc + 1;
        }
        if ([23, 24, 25, 26].includes(tag)) {
          const value = this.pop(pc), operator = tag === 23 || tag === 25 ? '++' : '--';
          const expression = tag >= 25 ? `${operator}${value}` : `${value}${operator}`;
          if (statement) this.emit(depth, `${expression};`); else this.push(expression);
          return pc + 1;
        }
        if ([20, 21, 22].includes(tag)) {
          const value = this.pop(pc), expression = `${tag === 20 ? '~' : tag === 21 ? '!' : '-'}(${value})`;
          if (statement) this.emit(depth, `${expression};`); else this.push(`(${expression})`);
          return pc + 1;
        }
        if (tag === 0) {
          const no = this.pop(pc), yes = this.pop(pc), condition = this.pop(pc);
          const expression = `(${condition} ? ${yes} : ${no})`;
          if (statement) this.emit(depth, `${expression};`); else this.push(expression);
          return pc + 1;
        }
        const symbol = symbols[tag];
        if (symbol) {
          const right = this.pop(pc), left = this.pop(pc);
          const assignment = tag >= 35;
          const expression = assignment ? `${right} ${symbol} ${left}` : `(${left} ${symbol} ${right})`;
          if (assignment && this.pending?.name === right) {
            this.emit(depth, `${this.pending.type} ${right} ${symbol} ${left};`);
            this.pending = undefined;
          } else if (statement) this.emit(depth, `${expression};`);
          else this.push(assignment ? `(${expression})` : expression);
          return pc + 1;
        }
        this.fail(pc, `unsupported expression tag ${tag}`);
      }
      case 17: { const path = this.path(pc); this.push(path.value); return path.next; }
      case 27: {
        const ref = node.operand as { owner: string; name: string };
        const ownStatic = ref.owner === this.cls.name && this.cls.staticFields.some(f => this.cls.utf8(f.name) === ref.name);
        this.push(ref.owner === this.cls.name ? (ownStatic ? `${simple(this.cls.name)}.${ref.name}` : `this.${ref.name}`) : `${this.types.name(ref.owner)}.${ref.name}`);
        return pc + 1;
      }
      case 28: this.push(`${this.pop(pc)}.${this.text(pc)}`); return pc + 1;
      case 32: {
        const array = this.pop(pc), index = this.pop(pc); this.push(`${array}[${index}]`); return pc + 1;
      }
      case 33: {
        const args = this.args(pc), object = this.pop(pc);
        this.push(`${object}(${args.join(', ')})`);
        return pc + 1;
      }
      case 34: case 35: {
        const args = this.args(pc);
        this.emit(depth, `${node.op === 34 ? 'this' : 'super'}(${args.join(', ')});`);
        return pc + 1;
      }
      case 36: {
        const args = this.args(pc), path = this.path(pc + 1);
        this.push(`${path.value}(${args.join(', ')})`);
        return path.next;
      }
      case 37: {
        const receiver = this.pop(pc), args = this.args(pc);
        this.push(`${receiver}.${this.text(pc)}(${args.join(', ')})`);
        return pc + 1;
      }
      case 38: {
        const args = this.args(pc); this.push(`super.${this.text(pc)}(${args.join(', ')})`); return pc + 1;
      }
      case 39: this.push(String(node.operand)); return pc + 1;
      case 40: return pc + 1; // Detach return value from local variable.
      case 41: this.push('/*void*/'); return pc + 1;
      case 45: {
        const value = this.pop(pc), dest = this.pop(pc);
        if (!this.pending || this.pending.name !== dest) this.fail(pc, 'unexpected initializer store');
        this.emit(depth, `${this.pending.type} ${dest} = ${value};`);
        this.pending = undefined;
        return pc + 1;
      }
      default: return this.fail(pc, `unsupported opcode ${node.name}`);
    }
  }

  private shortCircuit(pc: number, depth: number): number {
    const test = this.ins[pc], jump = this.ins[pc + 1];
    if (jump?.op !== 20 || jump.target === undefined || jump.target <= pc + 2 || jump.target > this.ins.length)
      this.fail(pc, 'invalid short-circuit jump');
    const last = this.ins[jump.target - 1];
    if (last?.op !== 7 || last.raw !== (test.op === 4 ? 2 : 1)) this.fail(pc, 'short-circuit expression missing final operator');
    let rhs = pc + 2;
    while (rhs < jump.target - 1) {
      if (this.ins[rhs].op === 4 || this.ins[rhs].op === 5) rhs = this.shortCircuit(rhs, depth);
      else rhs = this.expression(rhs, depth);
    }
    if (rhs !== jump.target - 1) this.fail(pc, 'short-circuit RHS crosses final operator');
    this.expression(rhs, depth); // Pops both operands and creates the && or || expression.
    return jump.target;
  }

  private switchAt(pc: number, depth: number, loop?: { header: number; exit: number }): number {
    const labels: { value: string; target: number }[] = [];
    let p = pc;
    while (p < this.ins.length) {
      const node = this.ins[p];
      if (node.op === 23) {
        labels.push({ value: this.pop(p), target: node.target! });
        p++; continue;
      }
      if (node.op === 24) break;
      if (node.op === 4 || node.op === 5) p = this.shortCircuit(p, depth);
      else p = this.expression(p, depth);
    }
    if (this.ins[p]?.op !== 24 || this.ins[p + 1]?.op !== 20 || !labels.length) this.fail(pc, 'malformed switch dispatch');
    const subject = this.pop(p);
    const defaultTarget = this.ins[p + 1].target!;
    const bodyStart = p + 2;
    if (labels.some(label => label.target < bodyStart)) this.fail(pc, 'switch case points into dispatch');
    // A no-default switch dispatches straight to its exit. With a default
    // group, the earlier case groups have forward break jumps past that group.
    const beyondDefault = this.ins.slice(bodyStart, defaultTarget)
      .filter(node => node.op === 20 && node.target !== undefined && node.target > defaultTarget)
      .map(node => node.target!);
    const exit = beyondDefault.length ? Math.max(...beyondDefault) : defaultTarget;
    if (exit > this.ins.length || labels.some(label => label.target >= exit)) this.fail(pc, 'cannot delimit switch groups');
    const starts = [...new Set([...labels.map(label => label.target), ...(defaultTarget < exit ? [defaultTarget] : [])])].sort((a, b) => a - b);
    if (starts[0] !== bodyStart) this.fail(pc, 'switch first group is not adjacent to dispatch');
    this.emit(depth, `switch (${subject}) {`);
    for (let i = 0; i < starts.length; i++) {
      const first = starts[i], last = starts[i + 1] ?? exit;
      for (const label of labels.filter(label => label.target === first)) this.emit(depth + 1, `case ${label.value}:`);
      if (first === defaultTarget && defaultTarget < exit) this.emit(depth + 1, 'default:');
      const tail = this.ins[last - 1];
      const breaks = tail?.op === 20 && tail.target === exit;
      this.region(first, breaks ? last - 1 : last, depth + 2, loop, exit);
      if (breaks) this.emit(depth + 2, 'break;');
    }
    this.emit(depth, '}');
    return exit;
  }

  private region(start: number, end: number, depth: number, loop?: { header: number; exit: number }, switchExit?: number, insideDo = false): void {
    let pc = start;
    while (pc < end) {
      if (!insideDo) {
        const bottom = this.ins.findIndex((candidate, index) => index > pc && index < end &&
          (candidate.op === 21 || candidate.op === 22) && candidate.target === pc);
        if (bottom >= 0) {
          this.emit(depth, 'do {');
          this.region(pc, bottom, depth + 1, { header: pc, exit: bottom + 1 }, switchExit, true);
          const condition = this.pop(bottom);
          this.emit(depth, `} while (${this.ins[bottom].op === 21 ? `!(${condition})` : condition});`);
          pc = bottom + 1;
          continue;
        }
      }
      const node = this.ins[pc];
      if (!node) this.fail(pc, 'region beyond tree');
      if (node.op === 21 || node.op === 22) {
        const condition = this.pop(pc), target = node.target!;
        if (target > end || target < start) this.fail(pc, `branch target ${target} crosses region`);
        if (target > pc) {
          const tail = this.ins[target - 1];
          const positive = node.op === 22;
          const test = positive ? `!(${condition})` : condition;
          if (tail?.op === 20 && tail.target !== undefined && tail.target <= pc && tail.target >= start) {
            this.emit(depth, `while (${test}) {`);
            this.region(pc + 1, target - 1, depth + 1, { header: tail.target, exit: target }, switchExit);
            this.emit(depth, '}');
            pc = target; continue;
          }
          if (tail?.op === 20 && tail.target !== undefined && tail.target > target && tail.target <= end) {
            this.emit(depth, `if (${test}) {`);
            this.region(pc + 1, target - 1, depth + 1, loop, switchExit);
            this.emit(depth, '} else {');
            this.region(target, tail.target, depth + 1, loop, switchExit);
            this.emit(depth, '}');
            pc = tail.target; continue;
          }
          this.emit(depth, `if (${test}) {`);
          this.region(pc + 1, target, depth + 1, loop, switchExit);
          this.emit(depth, '}');
          pc = target; continue;
        }
        this.fail(pc, `unstructured backward conditional jump to ${target}`);
      }
      if (node.op === 20) {
        if (node.target === pc + 1) { pc++; continue; } // Empty branch or jump to the next node.
        if (switchExit !== undefined && node.target === switchExit) { this.emit(depth, 'break;'); pc++; continue; }
        if (loop && node.target === loop.exit) { this.emit(depth, 'break;'); pc++; continue; }
        if (loop && node.target === loop.header) { this.emit(depth, 'continue;'); pc++; continue; }
        this.fail(pc, `unstructured unconditional jump to ${node.target}`);
      }
      if (node.op === 23) { pc = this.switchAt(pc, depth, loop); continue; }
      if (node.op === 4 || node.op === 5) { pc = this.shortCircuit(pc, depth); continue; }
      if (node.op === 42) {
        if (!this.ins.slice(pc + 1).every(tail => tail.op === 3)) this.emit(depth, 'return;');
        pc++; continue;
      }
      if (node.op === 43) {
        const value = this.pop(pc);
        const implicitVoidReturn = value === '/*void*/' && this.ins.slice(pc + 1).every(tail => tail.op === 3);
        if (!implicitVoidReturn) this.emit(depth, value === '/*void*/' ? 'return;' : `return ${value};`);
        pc++; continue;
      }
      if (node.op === 16) { pc++; continue; }
      if (node.op === 24) { this.pop(pc); pc++; continue; }
      pc = this.expression(pc, depth);
    }
  }

  run(): string[] {
    // The compiler emits for(;;) as a body followed by a jump back to its
    // first node. Code after that jump is the method's unreachable return tail.
    const back = this.ins.findIndex((node, i) => i > 0 && node.op === 20 && node.target === 0);
    const escape = back >= 0 && this.ins.slice(0, back).some(node =>
      (node.op === 21 || node.op === 22) && node.target === back + 1);
    if (back >= 0 && !escape) {
      this.emit(2, 'while (true) {');
      this.region(0, back, 3, { header: 0, exit: back + 1 });
      this.emit(2, '}');
      this.region(back + 1, this.ins.length, 2);
    } else this.region(0, this.ins.length, 2);
    return this.lines;
  }

  fieldValue(): string {
    if (this.ins.at(-1)?.op !== 16) this.fail(this.ins.length - 1, 'field initializer missing end marker');
    let pc = 0;
    while (pc < this.ins.length - 1) {
      if (this.ins[pc].op === 4 || this.ins[pc].op === 5) pc = this.shortCircuit(pc, 0);
      else pc = this.expression(pc, 0);
    }
    if (this.stack.length !== 1 || this.lines.length) this.fail(pc, 'field initializer is not a single expression');
    return this.pop(pc);
  }
}

function fieldSource(cls: TufaClass, member: Member, types: TypeNames): string {
  const type = types.type(decodeType(cls.utf8(member.descriptor))), name = cls.utf8(member.name);
  let init = '';
  if (member.tree !== NONE) {
    const ir = lowerTree(cls, member.tree, name, cls.utf8(member.descriptor));
    init = ` = ${new BodyWriter(cls, member, ir, types, true).fieldValue()}`;
  }
  return `${indent(1)}${flags(member.flags)}${flags(member.flags) ? ' ' : ''}${type} ${name}${init};`;
}

export function decompileClass(cls: TufaClass): DecompileResult {
  const diagnostics: string[] = [], intermediate: IrMethod[] = [];
  const types = new TypeNames(cls);
  const packageName = cls.name.split('.').slice(0, -1).join('.');
  const out: string[] = [];
  if (packageName) out.push(`package ${packageName};`, '');
  for (const value of [...types.imports].sort()) out.push(`import ${value};`);
  if (types.imports.size) out.push('');
  const own = simple(cls.name);
  const inherited = cls.superName && cls.superName !== 'java.lang.Object' ? ` extends ${types.name(cls.superName)}` : '';
  const interfaces = cls.interfaceIndices.map(index => types.name(cls.className(index)));
  const implementsClause = interfaces.length ? ` ${cls.isInterface ? 'extends' : 'implements'} ${interfaces.join(', ')}` : '';
  out.push(`public ${cls.isInterface ? 'interface' : 'class'} ${own}${inherited}${implementsClause} {`);
  for (const member of [...cls.staticFields, ...cls.instanceFields]) out.push(fieldSource(cls, member, types));
  if (cls.staticFields.length + cls.instanceFields.length) out.push('');
  for (const member of [...cls.staticMethods, ...cls.instanceMethods]) {
    const name = cls.utf8(member.name), descriptor = cls.utf8(member.descriptor);
    const signature = decodeMethod(descriptor);
    const params = signature.parameters.map((type, i) => `${types.type(type)} arg${i}`).join(', ');
    const prefix = flags(member.flags);
    const header = `${indent(1)}${prefix}${prefix ? ' ' : ''}${name === '<init>' ? own : `${types.type(signature.returns)} ${name}`}(${params})`;
    if (member.tree === NONE || (member.flags & (16 | 64)) !== 0) { out.push(`${header};`, ''); continue; }
    const ir = lowerTree(cls, member.tree, name, descriptor);
    intermediate.push(ir);
    out.push(`${header} {`);
    try {
      out.push(...new BodyWriter(cls, member, ir, types).run());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(message);
      out.push(`${indent(2)}/* Decompilation incomplete: ${message.replaceAll('*/', '* /')} */`);
      out.push(...formatIr(ir).split('\n').map(line => `${indent(2)}// ${line}`));
      if (signature.returns !== 'void' && name !== '<init>') out.push(`${indent(2)}return ${defaultValue(signature.returns)};`);
    }
    out.push(`${indent(1)}}`, '');
  }
  out.push('}', '');
  return { source: out.join('\n'), diagnostics, intermediate };
}
