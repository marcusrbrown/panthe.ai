import { expect, test } from "bun:test";
import { join } from "node:path";
import { REPO_ROOT } from "../../m1-living-world/src/sidecar";
import { defaultOutDir, loadGodIdentities } from "./episodes";

test("the god identities come from the authored profiles: drives, powers, and domains", () => {
  const gods = loadGodIdentities(join(REPO_ROOT, "content/greek/gods"), [
    "zeus",
    "hera",
  ]);
  const zeus = gods.get("zeus");
  expect(zeus?.name).toBe("Zeus");
  expect(zeus?.drives.sovereignty).toBe(0.9);
  expect(zeus?.abilities.map((a) => a.action)).toEqual(["strike", "legend"]);
  expect(gods.get("hera")?.abilities.map((a) => a.action)).toContain("legend");
  expect(zeus?.domains.length).toBeGreaterThan(0);
});

test("a god with no profile file is an error naming it, not an empty identity", () => {
  expect(() =>
    loadGodIdentities(join(REPO_ROOT, "content/greek/gods"), ["hades"]),
  ).toThrow(/hades/);
});

test("the default output directory is a timestamped folder under the scenario, safe as a file name", () => {
  const dir = defaultOutDir(new Date("2026-09-30T12:34:56.789Z"));
  expect(dir).toMatch(/m2-greek-cast\/episodes\/2026-09-30T12-34-56/);
  expect(dir).not.toContain(":");
});
