import { describe, expect, it } from "vitest";
import { diffToDelta } from "../../src/crdt/diff-delta";

describe("diffToDelta", () => {
  it("returns null for identical text", () => {
    expect(diffToDelta("abc", "abc")).toBeNull();
  });
  it("append", () => {
    expect(diffToDelta("abc", "abcdef")).toEqual({ index: 3, delete: 0, insert: "def" });
  });
  it("prepend", () => {
    expect(diffToDelta("abc", "xyabc")).toEqual({ index: 0, delete: 0, insert: "xy" });
  });
  it("replace middle", () => {
    expect(diffToDelta("a1c", "a234c")).toEqual({ index: 1, delete: 1, insert: "234" });
  });
  it("delete middle", () => {
    expect(diffToDelta("abXYcd", "abcd")).toEqual({ index: 2, delete: 2, insert: "" });
  });
  it("full replace", () => {
    expect(diffToDelta("abc", "xyz")).toEqual({ index: 0, delete: 3, insert: "xyz" });
  });
});
