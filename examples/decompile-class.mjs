// Run after `npm run build`: node examples/decompile-class.mjs path/to/Trigger.class
import { readFile } from 'node:fs/promises';
import { decompileClass, parseTufa } from 'slrr-jvm-decompiler';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node examples/decompile-class.mjs FILE.class');
  process.exit(2);
}

try {
  const classes = parseTufa(await readFile(input));
  for (const cls of classes) {
    const { source, diagnostics } = decompileClass(cls);
    console.log(`// ${cls.name} from ${input}`);
    console.log(source);
    for (const diagnostic of diagnostics) console.error(`${cls.name}: ${diagnostic}`);
    if (diagnostics.length) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
