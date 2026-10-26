# Examples

Run these from the repository root after `npm install` and `npm run build`. Supply your own SLRR `.class` file; this repository contains no game assets. A stock installation normally has scripts under `sl/Scripts`.

## Decompile a class through the API

```bash
node examples/decompile-class.mjs "path/to/Trigger.class"
```

The program reads every TUFA class blob in the file, writes Java-like source to stdout and reports any methods that needed a raw-IR fallback on stderr. To save the source, redirect stdout to a file:

```bash
node examples/decompile-class.mjs "path/to/Trigger.class" > Trigger.java
```

To run the CLI on just one `.class` and save both the reconstructed source and its intermediate listing:

```bash
node dist/src/cli.js --strict --ir --out output "path/to/Trigger.class"
```

This creates `output/java/game/Trigger.java` and `output/java/game/Trigger.ir` for a class named `java.game.Trigger`. Omit `--out` to print the source to stdout.

For a whole game or mod tree, use the CLI instead. It preserves source file paths and keeps duplicate class names separate:

```bash
node dist/src/cli.js --strict --ir --out output "path/to/game"
```

`--ir` also writes an intermediate listing alongside each `.java` file. `--strict` exits with an error when a method cannot be structured.

## Inspect the intermediate representation

```bash
node examples/inspect-ir.mjs "path/to/Trigger.class"
node examples/inspect-ir.mjs "path/to/Trigger.class" finalize
```

The listing shows decoded TREE operations, jump targets and basic blocks with successor edges. Without a method name, it prints every method body in the file. This is useful for examining a control-flow pattern before adding a source-level reconstruction rule.

## Scan a whole installation for unsupported patterns

```bash
npm run report -- "path/to/game"
```

The report counts parsed files and method bodies, and lists methods that still require a raw-IR fallback. Run it on additional game versions and mods to find patterns absent from the stock corpus.
