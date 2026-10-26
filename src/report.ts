#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decompileClass } from './decompile.js';
import { parseTufa } from './tufa.js';

async function* classes(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* classes(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.class')) yield path;
  }
}

const root = process.argv[2];
if (!root) {
  console.error('Usage: node dist/src/report.js GAME_DIRECTORY');
  process.exit(2);
}
let files = 0, blobs = 0, methods = 0, incomplete = 0, parseFailures = 0;
const causes = new Map<string, number>();
const examples = new Map<string, string>();
for await (const file of classes(root)) {
  files++;
  try {
    for (const cls of parseTufa(await readFile(file))) {
      blobs++;
      const result = decompileClass(cls);
      methods += result.intermediate.length;
      incomplete += result.diagnostics.length;
      for (const diagnostic of result.diagnostics) {
        const cause = diagnostic.replace(/^.*TREE \d+:\d+: /, '');
        causes.set(cause, (causes.get(cause) ?? 0) + 1);
        if (!examples.has(cause)) examples.set(cause, `${file}: ${diagnostic}`);
      }
    }
  } catch (error) {
    parseFailures++;
    const cause = `PARSE: ${error instanceof Error ? error.message : String(error)}`;
    causes.set(cause, (causes.get(cause) ?? 0) + 1);
    if (!examples.has(cause)) examples.set(cause, file);
  }
}
console.log(JSON.stringify({ files, blobs, methods, incomplete, parseFailures, causes: [...causes].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([cause, count]) => ({ cause, count, example: examples.get(cause) })) }, null, 2));
