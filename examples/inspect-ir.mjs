// Run after `npm run build`: node examples/inspect-ir.mjs path/to/Trigger.class methodName
import { readFile } from 'node:fs/promises';
import { formatIr, lowerTree, NONE, parseTufa } from 'slrr-jvm-decompiler';

const [input, requestedName] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node examples/inspect-ir.mjs FILE.class [METHOD_NAME]');
  process.exit(2);
}

try {
  const classes = parseTufa(await readFile(input));
  let found = false;
  for (const cls of classes) {
    for (const member of [...cls.staticMethods, ...cls.instanceMethods]) {
      if (member.tree === NONE) continue;
      const name = cls.utf8(member.name);
      if (requestedName && name !== requestedName) continue;
      const descriptor = cls.utf8(member.descriptor);
      const ir = lowerTree(cls, member.tree, name, descriptor);
      console.log(formatIr(ir));
      console.log();
      found = true;
    }
  }
  if (!found) {
    console.error(requestedName ? `No method named ${requestedName} has a TREE body in ${input}` : `No method has a TREE body in ${input}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
