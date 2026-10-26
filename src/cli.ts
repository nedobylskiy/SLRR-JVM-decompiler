#!/usr/bin/env node
import { readFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { decompileClass } from './decompile.js';
import { formatIr, lowerTree } from './ir.js';
import { parseTufa, recoverMissingClassName } from './tufa.js';

function usage(): never {
  console.error('Usage: slrr-decompile [--out DIR] [--ir] [--strict] FILE.class|GAME_DIRECTORY [...]');
  process.exit(2);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.class')) yield path;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputs: string[] = [];
  let out: string | undefined, ir = false, strict = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i] ?? usage();
    else if (args[i] === '--ir') ir = true;
    else if (args[i] === '--strict') strict = true;
    else if (args[i].startsWith('-')) usage();
    else inputs.push(args[i]);
  }
  if (!inputs.length) usage();
  let failures = 0;
  const files: { input: string; root?: string }[] = [];
  for (const input of inputs) {
    if ((await stat(input)).isDirectory()) {
      if (!out) usage();
      for await (const path of walk(input)) files.push({ input: path, root: input });
    } else files.push({ input });
  }
  for (const { input, root } of files) {
    try {
      const classes = parseTufa(await readFile(input));
      for (const cls of classes) {
        if (recoverMissingClassName(cls, basename(input, '.class'))) {
          console.error(`${input}: TUFA has no class name; using filename ${cls.name} (package cannot be recovered)`);
        }
        const result = decompileClass(cls);
        const intermediate = cls.trees.map((_, i) => formatIr(lowerTree(cls, i))).join('\n\n');
        for (const diagnostic of result.diagnostics) console.error(`${input}: ${diagnostic}`);
        if (strict && result.diagnostics.length) failures++;
        if (out) {
          // Each source class file gets its own directory: class names reused
          // by mods, and secondary blobs within a file, cannot overwrite one another.
          const filename = root
            ? join(out, relative(root, dirname(input)), basename(input, '.class'), cls.name.split('.').at(-1)!)
            : join(out, ...cls.name.split('.'));
          await mkdir(dirname(filename), { recursive: true });
          await writeFile(`${filename}.java`, result.source);
          if (ir) await writeFile(`${filename}.ir`, intermediate + '\n');
          console.error(`Wrote ${filename}.java`);
        } else {
          if (inputs.length > 1 || classes.length > 1) console.log(`// ${input}: ${cls.name}`);
          console.log(result.source);
          if (ir) console.log(`\n/* TUFA IR\n${intermediate}\n*/`);
        }
      }
    } catch (error) {
      console.error(`${input}: ${error instanceof Error ? error.message : String(error)}`);
      failures++;
    }
  }
  if (failures) process.exitCode = 1;
}

await main();
