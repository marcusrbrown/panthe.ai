// Run under `bun --cpu-prof`: one hour of the real `runCatchUp` on the world
// stored in the directory it is given, nothing instrumented, so the profile is
// of the code as production runs it. Prints the hour's total as JSON.

import { runBare } from "./measure";
import { reopenWorld } from "./world";

const [dir, mortals] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: profile-child <dir> [mortals]");
const world = reopenWorld(
  dir,
  mortals === undefined ? undefined : Number(mortals),
);
const totalMs = await runBare(world);
world.close();
console.log(JSON.stringify({ totalMs }));
