import { describe, expect, it } from "vitest";
import { InMemoryVault } from "./fake-vault";

describe("InMemoryVault", () => {
  it("supports exists / read / write / remove", async () => {
    const v = new InMemoryVault({ "a.md": "alpha" });
    expect(await v.exists("a.md")).toBe(true);
    expect(await v.exists("b.md")).toBe(false);
    expect(await v.read("a.md")).toBe("alpha");
    await v.write("b.md", "bravo");
    expect(v.snapshot()).toEqual({ "a.md": "alpha", "b.md": "bravo" });
    await v.remove("a.md");
    expect(await v.exists("a.md")).toBe(false);
  });
});
