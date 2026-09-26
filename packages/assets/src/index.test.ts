import { expect, test } from "bun:test";
import { status } from "./index";

test("exports a placeholder status", () => {
  expect(status).toEqual({ package: "assets", ready: false });
});
