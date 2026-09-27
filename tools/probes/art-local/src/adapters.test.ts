import { describe, expect, it } from "bun:test";
import { DrawThingsError, txt2img as drawThingsTxt2img } from "./drawthings";
import { generateImage, getJob, SdCppError, submitImgGen } from "./sdcpp";

// A 1x1 transparent PNG, base64-encoded — enough to exercise decode paths
// without a real generation.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("sdcpp adapter (sd-server native sdcpp API)", () => {
  it("submits a job and polls it to a decoded completed image (happy path)", async () => {
    let jobRequested = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/sdcpp/v1/img_gen" && req.method === "POST") {
          return Response.json(
            {
              id: "job_test1",
              kind: "img_gen",
              status: "queued",
              created: 1_000,
              poll_url: "/sdcpp/v1/jobs/job_test1",
            },
            { status: 202 },
          );
        }
        if (
          url.pathname === "/sdcpp/v1/jobs/job_test1" &&
          req.method === "GET"
        ) {
          jobRequested += 1;
          const status = jobRequested < 2 ? "generating" : "completed";
          return Response.json({
            id: "job_test1",
            kind: "img_gen",
            status,
            created: 1_000,
            started: 1_001,
            completed: status === "completed" ? 1_002 : null,
            queue_position: 0,
            result:
              status === "completed"
                ? {
                    output_format: "png",
                    images: [{ index: 0, b64_json: TINY_PNG_BASE64 }],
                  }
                : null,
            error: null,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const result = await generateImage(
        { baseUrl: `http://127.0.0.1:${server.port}` },
        { prompt: "a cat, pixel art" },
        { pollIntervalMs: 5, timeoutMs: 5_000 },
      );
      expect(result.job.status).toBe("completed");
      expect(result.images).toHaveLength(1);
      const [firstImage] = result.images;
      if (!firstImage) {
        throw new Error("expected a decoded image");
      }
      expect(firstImage.bytes.length).toBeGreaterThan(0);
      // PNG signature.
      expect(Buffer.from(firstImage.bytes.subarray(0, 8)).toString("hex")).toBe(
        "89504e470d0a1a0a",
      );
    } finally {
      server.stop(true);
    }
  });

  it("fails clearly within the timeout when the server is absent (no hang)", async () => {
    const config = { baseUrl: "http://127.0.0.1:1" }; // nothing listens on port 1
    const start = Date.now();
    await expect(
      submitImgGen(config, { prompt: "x", timeoutMs: 1_000 }),
    ).rejects.toThrow(SdCppError);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("reports a malformed job-submission body with a field path", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/sdcpp/v1/img_gen" && req.method === "POST") {
          // Missing required `poll_url`.
          return Response.json(
            { id: "job_bad", kind: "img_gen", status: "queued", created: 1 },
            { status: 202 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await expect(
        submitImgGen(
          { baseUrl: `http://127.0.0.1:${server.port}` },
          { prompt: "x" },
        ),
      ).rejects.toMatchObject({
        path: "$.poll_url",
      });
    } finally {
      server.stop(true);
    }
  });

  it("reports a malformed job-status body with a field path", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (
          url.pathname === "/sdcpp/v1/jobs/job_bad2" &&
          req.method === "GET"
        ) {
          // Completed with no result object at all.
          return Response.json({
            id: "job_bad2",
            kind: "img_gen",
            status: "completed",
            created: 1,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await expect(
        getJob({ baseUrl: `http://127.0.0.1:${server.port}` }, "job_bad2"),
      ).rejects.toMatchObject({ path: "$.result" });
    } finally {
      server.stop(true);
    }
  });
});

describe("drawthings adapter (A1111-shaped txt2img)", () => {
  it("decodes a successful txt2img response (happy path)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/sdapi/v1/txt2img" && req.method === "POST") {
          return Response.json({
            images: [TINY_PNG_BASE64],
            parameters: { width: 512, height: 512 },
            info: "",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await drawThingsTxt2img(
        { baseUrl: `http://127.0.0.1:${server.port}` },
        { prompt: "a cat, pixel art" },
      );
      expect(result.images).toHaveLength(1);
      const [firstImage] = result.images;
      if (!firstImage) {
        throw new Error("expected a decoded image");
      }
      expect(Buffer.from(firstImage.subarray(0, 8)).toString("hex")).toBe(
        "89504e470d0a1a0a",
      );
    } finally {
      server.stop(true);
    }
  });

  it("fails clearly within the timeout when Draw Things is absent (no hang)", async () => {
    const config = { baseUrl: "http://127.0.0.1:1" };
    const start = Date.now();
    await expect(
      drawThingsTxt2img(config, { prompt: "x", timeoutMs: 1_000 }),
    ).rejects.toThrow(DrawThingsError);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("reports a malformed txt2img body with a field path", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/sdapi/v1/txt2img" && req.method === "POST") {
          // `images` is a string instead of an array.
          return Response.json({
            images: "not-an-array",
            parameters: {},
            info: "",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await expect(
        drawThingsTxt2img(
          { baseUrl: `http://127.0.0.1:${server.port}` },
          { prompt: "x" },
        ),
      ).rejects.toMatchObject({ path: "$.images" });
    } finally {
      server.stop(true);
    }
  });
});
