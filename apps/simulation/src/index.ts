// Panthea simulation service: the headless, authoritative world service the
// desktop shell talks to over HTTP/IPC. At M0 this is only a health-checked
// process skeleton — world state, commands, and events land in M1.

export const VERSION = "0.1.0";

export interface HealthResponse {
  ok: true;
  version: string;
}

/**
 * Starts the simulation HTTP server bound to loopback only. Passing `port`
 * lets tests bind an OS-assigned port (0) instead of the real service port.
 */
export function createServer(port = 0) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        const body: HealthResponse = { ok: true, version: VERSION };
        return Response.json(body);
      }
      return new Response("Not Found", { status: 404 });
    },
  });
}

function main() {
  const server = createServer();
  // Printed for the parent process (the Tauri shell, or a developer) to
  // discover the OS-assigned port; do not remove or reformat this line.
  console.log(`PANTHEA_PORT=${server.port}`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`panthea-simulation: received ${signal}, shutting down`);
    server.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.main) {
  main();
}
