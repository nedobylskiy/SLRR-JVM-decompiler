# SLRR JVM Decompiler

Decompile Street Legal Racing: Redline script `.class` files into the game's Java-like source syntax. These files use the game's **TUFA** format and `TREE` opcodes; they are not standard JVM bytecode.

The pipeline is deliberately split into two stages:

1. Parse TUFA chunks and lower each method's postfix `TREE` nodes into a typed intermediate listing with resolved pool references, jump targets and basic blocks.
2. Rebuild expressions and control flow (`if`/`else`, short-circuit booleans, `while`, `do…while`, infinite loops and `switch`) and print Java-like source.

It reads the original game files directly. The game install is never modified. No game files or decompiled game sources are distributed in this repository.

## Install and use

Requires Node.js 20 or newer.

```bash
npm install
npm run build
node dist/src/cli.js --ir --out output path/to/Trigger.class
```

This writes `output/java/game/Trigger.java` and `Trigger.ir`. `--ir` is optional. Without `--out`, the source is printed to standard output. `--strict` returns a nonzero exit code if a method cannot be structured, while still emitting its raw intermediate listing as comments.

To decompile a whole installation or mod tree, pass its directory:

```bash
node dist/src/cli.js --out output "C:\Program Files (x86)\Steam\steamapps\common\Street Legal Racing Redline"
```

Directory mode preserves each input `.class` path under `output` and gives each input file its own directory. This avoids overwriting classes with the same name from different mods or game versions. Each TUFA blob in a file gets a separate `.java` output.

Use the reusable API without any file system dependency:

```ts
import { parseTufa, lowerTree, formatIr, decompileClass } from 'slrr-jvm-decompiler';

const [cls] = parseTufa(bytes);
const ir = lowerTree(cls, cls.instanceMethods[0].tree);
console.log(formatIr(ir));
console.log(decompileClass(cls).source);
```

`parseTufa` accepts a `Uint8Array` and returns every class blob in the file. `lowerTree` exposes the operation list and control-flow blocks to other tooling. The package does not require a game installation for parsing or unit tests.

See [examples](examples/README.md) for runnable API scripts, CLI usage and a full-installation scan.

## Verification

- `npm test` runs synthetic TUFA tests for chunk boundaries, malformed jumps, method descriptors, control-flow blocks, `if`, `switch` and `do…while`.
- `node dist/src/report.js GAME_DIRECTORY` reports parser failures and methods requiring raw IR fallback.
- On the Steam Build 940 installation used during development: **2,921 files, 2,993 class blobs, 6,237 method bodies** were processed with zero parser failures and zero raw-IR fallbacks. The generated 2,993 source files also had **zero syntax errors** under the independent SLRR source parser in [TrentonCh/slrr-reverse](https://github.com/TrentonCh/slrr-reverse/tree/dev/tools/slrrc). These checks establish format and syntax coverage; they do not prove behavior or byte-identical recompilation.

## Fidelity and limits

- Local and parameter names are absent from TUFA and become `localN` and `argN`.
- Comments, formatting and original `for` spelling are not recoverable from the class file. A `for` loop can appear as an equivalent `while` with its update in the body.
- Fully qualified types are shortened with wildcard imports when their simple names are unambiguous.
- Rare malformed stock descriptors such as `L;` are rendered as `Object`.
- Decompilation is not yet a recompilation round trip. Source equivalence, method behavior and output against other game builds still need broader validation.

The TUFA layout, opcode widths and control-flow patterns were cross-checked against the reverse-engineering work in [TrentonCh/slrr-reverse](https://github.com/TrentonCh/slrr-reverse/tree/dev/tools/slrrc), itself a fork of [EliasFD3S/slrr-reverse](https://github.com/EliasFD3S/slrr-reverse). That research is MIT-licensed; its authors retain credit for those findings. This package implements its own TypeScript parser and decompiler.
