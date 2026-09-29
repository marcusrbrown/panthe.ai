import { expect, test } from "bun:test";
import { canonicalJson } from "./canonical";

test("objects that differ only in key order, at any depth, canonicalize to the same text", () => {
  const a = { id: "e1", payload: { b: 1, a: [{ y: 2, x: 1 }] } };
  const b = { payload: { a: [{ x: 1, y: 2 }], b: 1 }, id: "e1" };
  expect(canonicalJson(a)).toBe(canonicalJson(b));
});

test("different values, including array order, canonicalize differently", () => {
  expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
});

test("an absent key and an undefined value canonicalize alike", () => {
  expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
});
