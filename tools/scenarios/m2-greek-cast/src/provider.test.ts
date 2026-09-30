import { afterEach, expect, test } from "bun:test";
import { type ScriptedProvider, startProvider, WAIT } from "./provider";

const started: ScriptedProvider[] = [];
afterEach(() => {
  for (const provider of started.splice(0)) provider.stop();
});

function ask(provider: ScriptedProvider, who: string) {
  return fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "scripted",
      messages: [
        { role: "system", content: `You are ${who}, a Greek god of x.` },
        { role: "user", content: "What do you do?" },
      ],
    }),
  }).then(async (response) => {
    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    return body.choices[0]?.message.content;
  });
}

const boot = () => {
  const provider = startProvider();
  started.push(provider);
  return provider;
};

test("an unscripted god waits; each request is recorded with which god asked, its prompt, and when", async () => {
  const provider = boot();
  expect(await ask(provider, "Zeus")).toBe('{"action":"wait"}');
  expect(await ask(provider, "Hera")).toBe('{"action":"wait"}');
  expect(provider.requests.map((r) => r.god)).toEqual(["zeus", "hera"]);
  expect(provider.requests[0]?.prompt).toContain("You are Zeus");
  expect(provider.requests[0]?.at).toBeGreaterThan(0);
});

test("scripted replies go to the god they were queued for, in order, then the god waits again", async () => {
  const provider = boot();
  provider.enqueue(
    "zeus",
    '{"action":"legend","assertion":"a"}',
    () => '{"action":"legend","assertion":"b"}',
  );
  expect(await ask(provider, "Hera")).toBe('{"action":"wait"}');
  expect(await ask(provider, "Zeus")).toContain('"a"');
  expect(await ask(provider, "Zeus")).toContain('"b"');
  expect(await ask(provider, "Zeus")).toBe('{"action":"wait"}');
});

test("a held reply arrives only when released, and a reply function sees the request it answers", async () => {
  const provider = boot();
  const held = provider.hold("zeus", '{"action":"legend","assertion":"held"}');
  let answered = false;
  const pending = ask(provider, "Zeus").then((reply) => {
    answered = true;
    return reply;
  });
  const arrived = await held.arrived;
  expect(arrived.god).toBe("zeus");
  await Bun.sleep(50);
  expect(answered).toBe(false);
  held.release();
  expect(await pending).toContain("held");

  provider.enqueue("hera", (seen) =>
    JSON.stringify({ action: "legend", assertion: seen.prompt.slice(0, 12) }),
  );
  expect(await ask(provider, "Hera")).toContain("You are Hera");
});

test("a policy answers whenever the queue is empty, from the prompt alone, and each request records the reply it got", async () => {
  const provider = boot();
  provider.policy("hera", (seen) =>
    seen.prompt.includes("You are Hera")
      ? '{"action":"legend","assertion":"policy"}'
      : WAIT,
  );
  provider.enqueue("hera", '{"action":"legend","assertion":"queued"}');
  expect(await ask(provider, "Hera")).toContain("queued");
  expect(await ask(provider, "Hera")).toContain("policy");
  expect(await ask(provider, "Zeus")).toBe(WAIT);
  expect(provider.requests.map((r) => r.reply)).toEqual([
    '{"action":"legend","assertion":"queued"}',
    '{"action":"legend","assertion":"policy"}',
    WAIT,
  ]);
  provider.policy("hera", undefined);
  expect(await ask(provider, "Hera")).toBe(WAIT);
});
