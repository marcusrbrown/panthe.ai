import { expect, test } from "bun:test";
import { createServer, VERSION } from "./index";

test("GET /health returns ok and version on an OS-assigned port", async () => {
  const server = createServer();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: VERSION });
  } finally {
    server.stop(true);
  }
});

test("unknown routes return 404", async () => {
  const server = createServer();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(response.status).toBe(404);
  } finally {
    server.stop(true);
  }
});
