import { expect, test } from "bun:test";
import { join } from "node:path";
import { REPO_ROOT } from "../../m1-living-world/src/sidecar";
import { defaultOutDir, episodeSettings, loadGodIdentities } from "./episodes";

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

const SENTINEL = "sk-sentinel-DO-NOT-LEAK-0123456789";
const run = {
  ranAt: "2026-10-02T00:00:00.000Z",
  ticks: 12,
  hardware: "Apple M1 Pro",
};
const base = {
  binary: "/b",
  durationMs: 60_000,
  ollama: "http://127.0.0.1:11434",
  model: "gpt-x",
  episodes: 1,
  outDir: "/tmp/out",
};

test("a hosted run's settings say hosted and carry no host, key, key reference, path, or credentials", () => {
  const settings = episodeSettings(
    {
      ...base,
      baseUrl: "https://private-host.example:8443/v1",
      keyRef: "private-key-ref",
      keys: { "private-key-ref": SENTINEL },
    },
    run,
  );
  expect(settings.endpoint).toBe("hosted");
  const text = JSON.stringify(settings);
  for (const secret of [
    SENTINEL,
    "private-host.example",
    "private-key-ref",
    "/v1",
  ]) {
    expect(text).not.toContain(secret);
  }
  // Controls: the default path says nothing; an explicit local base URL says local, with no host or port.
  expect(episodeSettings(base, run).endpoint).toBeUndefined();
  const local = episodeSettings(
    { ...base, baseUrl: "http://192.168.1.20:8080/v1" },
    run,
  );
  expect(local.endpoint).toBe("local");
  expect(JSON.stringify(local)).not.toContain("192.168.1.20");
  expect(JSON.stringify(local)).not.toContain("8080");
});
