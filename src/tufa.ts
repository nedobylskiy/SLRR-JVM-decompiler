/** TUFA is SLRR's own class format, not JVM bytecode. */
export const NONE = 0xffffffff;

export type Constant =
  | { kind: 'utf8'; text: string }
  | { kind: 'resource'; pack: number; id: number }
  | { kind: 'class'; name: number }
  | { kind: 'reference'; owner: number; nameAndType: number }
  | { kind: 'nameAndType'; name: number; descriptor: number };

export interface Member { flags: number; name: number; descriptor: number; tree: number; locals?: number; }
export interface TreeNode { index: number; offset: number; op: number; line: number; immediate?: number; }
export interface TufaClass {
  build: number;
  constants: Constant[];
  staticFields: Member[];
  instanceFields: Member[];
  staticMethods: Member[];
  instanceMethods: Member[];
  nameIndex: number;
  superIndex: number;
  interfaceIndices: number[];
  isInterface: boolean;
  trees: TreeNode[][];
  utf8(index: number): string;
  className(index: number): string;
  reference(index: number): { owner: string; name: string; descriptor: string };
  resource(index: number): { pack: string; id: number };
  readonly name: string;
  readonly superName: string | undefined;
}

// Exact width table from the Build 940 VM's 48-entry TREE opcode table.
export const OP_FLAGS = [
  0x0000, 0x1001, 0x1002, 0x1003, 0x0004, 0x0005, 0x1006, 0x1007,
  0x1008, 0x4009, 0x200a, 0x100b, 0x000c, 0x100d, 0x100e, 0x100f,
  0x0010, 0x1011, 0x4012, 0x0013, 0x1014, 0x1015, 0x1016, 0x1017,
  0x0018, 0x1019, 0x101a, 0x101b, 0x401c, 0x001d, 0x101e, 0x101f,
  0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x4025, 0x4026, 0x1027,
  0x0028, 0x0029, 0x002a, 0x002b, 0x002c, 0x002d, 0x402e, 0x0000,
] as const;

class Reader {
  readonly view: DataView;
  offset = 0;
  constructor(readonly bytes: Uint8Array, readonly label: string) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get left(): number { return this.bytes.length - this.offset; }
  need(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.left) throw new Error(`${this.label}: truncated at 0x${this.offset.toString(16)}`);
  }
  u8(): number { this.need(1); return this.view.getUint8(this.offset++); }
  u16(): number { this.need(2); const n = this.view.getUint16(this.offset, true); this.offset += 2; return n; }
  u32(): number { this.need(4); const n = this.view.getUint32(this.offset, true); this.offset += 4; return n; }
  take(n: number): Uint8Array { this.need(n); const value = this.bytes.subarray(this.offset, this.offset + n); this.offset += n; return value; }
  tag(): string { return String.fromCharCode(...this.take(4)); }
  done(): void { if (this.left) throw new Error(`${this.label}: ${this.left} trailing bytes`); }
}

function count(r: Reader, size: number): number {
  const n = r.u32();
  if (n > Math.floor(r.left / size)) throw new Error(`${r.label}: invalid count ${n}`);
  return n;
}

function parseConstants(bytes: Uint8Array): Constant[] {
  const r = new Reader(bytes, 'CONS');
  const n = count(r, 4);
  const values: Constant[] = [];
  for (let i = 0; i < n; i++) {
    switch (r.u32()) {
      case 0: {
        const len = r.u32();
        const text = new TextDecoder('latin1').decode(r.take(len));
        if (r.u8() !== 0) throw new Error(`CONS[${i}]: missing NUL`);
        values.push({ kind: 'utf8', text }); break;
      }
      case 3: values.push({ kind: 'resource', pack: r.u32(), id: r.u32() }); break;
      case 4: values.push({ kind: 'class', name: r.u32() }); break;
      case 5: values.push({ kind: 'reference', owner: r.u32(), nameAndType: r.u32() }); break;
      case 7: values.push({ kind: 'nameAndType', name: r.u32(), descriptor: r.u32() }); break;
      default: throw new Error(`CONS[${i}]: unknown constant kind`);
    }
  }
  r.done();
  return values;
}

function parseMembers(bytes: Uint8Array | undefined, method: boolean): [Member[], Member[]] {
  if (!bytes) return [[], []];
  const r = new Reader(bytes, method ? 'MTHD' : 'FILD');
  const readPartition = (): Member[] => {
    const n = count(r, method ? 20 : 16);
    const members: Member[] = [];
    for (let i = 0; i < n; i++) members.push({
      flags: r.u32(), name: r.u32(), descriptor: r.u32(), tree: r.u32(),
      ...(method ? { locals: r.u32() } : {}),
    });
    return members;
  };
  const statics = readPartition();
  const instances = readPartition();
  r.done();
  return [statics, instances];
}

function parseTrees(bytes: Uint8Array): TreeNode[][] {
  const r = new Reader(bytes, 'TREE');
  const n = count(r, 4);
  const trees: TreeNode[][] = [];
  for (let i = 0; i < n; i++) {
    const len = count(r, 3);
    const nodes: TreeNode[] = [];
    for (let j = 0; j < len; j++) {
      const offset = r.offset;
      const op = r.u8();
      if (op >= OP_FLAGS.length || op === 0 || op === 47) throw new Error(`TREE ${i}:${j}: invalid opcode ${op}`);
      const line = r.u16();
      const wide = (OP_FLAGS[op] >>> 12) !== 0;
      nodes.push({ index: j, offset, op, line, ...(wide ? { immediate: r.u32() } : {}) });
    }
    trees.push(nodes);
  }
  r.done();
  return trees;
}

export function parseTufa(input: Uint8Array): TufaClass[] {
  const r = new Reader(input, 'TUFA');
  const result: TufaClass[] = [];
  while (r.left) {
    if (r.tag() !== 'TUFA' || r.u32() !== 4) throw new Error('Expected TUFA header');
    const build = r.u32();
    const chunks = new Map<string, Uint8Array>();
    // TREE closes a blob. Chunk payloads may contain the byte sequence TUFA.
    while (!chunks.has('TREE')) {
      const tag = r.tag();
      const data = r.take(r.u32());
      if (!['CONS', 'FILD', 'MTHD', 'CLSS', 'TREE'].includes(tag) || chunks.has(tag)) throw new Error(`Unexpected chunk ${tag}`);
      chunks.set(tag, data);
    }
    const cons = chunks.get('CONS'), clss = chunks.get('CLSS'), tree = chunks.get('TREE');
    if (!cons || !clss || !tree) throw new Error('TUFA blob missing a required chunk');
    const constants = parseConstants(cons);
    const [staticFields, instanceFields] = parseMembers(chunks.get('FILD'), false);
    const [staticMethods, instanceMethods] = parseMembers(chunks.get('MTHD'), true);
    const c = new Reader(clss, 'CLSS');
    if (c.u32() !== NONE) throw new Error('Invalid CLSS marker');
    const isInterface = c.u32() !== 0;
    const nameIndex = c.u32(), superIndex = c.u32();
    const interfaceIndices = Array.from({ length: count(c, 4) }, () => c.u32());
    c.done();
    const blob: TufaClass = {
      build, constants, staticFields, instanceFields, staticMethods, instanceMethods,
      nameIndex, superIndex, interfaceIndices, isInterface, trees: parseTrees(tree),
      utf8(index) {
        const entry = constants[index];
        if (entry?.kind !== 'utf8') throw new Error(`${this.nameIndex}: expected UTF8 constant ${index}`);
        return entry.text;
      },
      className(index) {
        const entry = constants[index];
        if (entry?.kind !== 'class') throw new Error(`Expected class constant ${index}`);
        return this.utf8(entry.name);
      },
      reference(index) {
        const entry = constants[index];
        if (entry?.kind !== 'reference') throw new Error(`Expected reference constant ${index}`);
        const nat = constants[entry.nameAndType];
        if (nat?.kind !== 'nameAndType') throw new Error(`Expected name/type constant ${entry.nameAndType}`);
        return { owner: this.className(entry.owner), name: this.utf8(nat.name), descriptor: this.utf8(nat.descriptor) };
      },
      resource(index) {
        const entry = constants[index];
        if (entry?.kind !== 'resource') throw new Error(`Expected resource constant ${index}`);
        return { pack: this.utf8(entry.pack), id: entry.id };
      },
      get name() { return this.className(nameIndex); },
      get superName() { return superIndex === NONE ? undefined : this.className(superIndex); },
    };
    // Resolve links and tree references while file offsets are still available.
    void blob.name;
    for (const index of interfaceIndices) blob.className(index);
    for (const m of [...staticFields, ...instanceFields, ...staticMethods, ...instanceMethods]) {
      blob.utf8(m.name); blob.utf8(m.descriptor);
      if (m.tree !== NONE && m.tree >= blob.trees.length) throw new Error(`${blob.name}: tree ${m.tree} is missing`);
    }
    result.push(blob);
  }
  return result;
}
