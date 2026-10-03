// Writes the immutable benchmark fixture: the merged, parsed Greek content
// pack (7 gods, 20 mortals) as it stood at main d566975, the commit that
// carries the Unit 7 world. It is run once to produce
// `fixtures/unit7-pack.json` and is not part of a benchmark run: the fixture
// is the input, so later content changes (new gods, new rules) cannot move
// the benchmark's numbers. The hash of the file is checked on every load.
//
//   bun run src/snapshot-pack.ts      # only on a checkout of d566975

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEmbeddedGreekWorldPack } from "../../../../apps/simulation/src/greek-world-pack";

const loaded = loadEmbeddedGreekWorldPack({});
if (!loaded.ok) {
  throw new Error(`${loaded.path}: ${loaded.message}`);
}
const text = `${JSON.stringify(loaded.value, null, 2)}\n`;
writeFileSync(join(import.meta.dir, "../fixtures/unit7-pack.json"), text);
console.log(
  `unit7-pack.json: ${text.length} bytes, sha256 ${createHash("sha256").update(text).digest("hex")}`,
);
