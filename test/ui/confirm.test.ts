import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { ConfirmModal } from "../../src/ui/confirm";

const opts = {
  title: "Disconnect?",
  body: "This unlinks the folder.",
  cta: "Disconnect",
  danger: true,
};

describe("ConfirmModal", () => {
  it("resolves true when the confirm action fires", async () => {
    const modal = new ConfirmModal(new App(), opts);
    const p = modal.ask(); // open() → onOpen() builds the buttons without error
    modal.confirm();
    expect(await p).toBe(true);
  });

  it("resolves false when cancelled", async () => {
    const modal = new ConfirmModal(new App(), opts);
    const p = modal.ask();
    modal.cancel();
    expect(await p).toBe(false);
  });

  it("resolves false when the modal is closed without a choice", async () => {
    const modal = new ConfirmModal(new App(), opts);
    const p = modal.ask();
    modal.close(); // dismissed (Esc / click-away) → defaults to false
    expect(await p).toBe(false);
  });

  it("resolves only once even if closed again after confirming", async () => {
    const modal = new ConfirmModal(new App(), opts);
    const p = modal.ask();
    modal.confirm();
    modal.close(); // a second close must not re-resolve
    expect(await p).toBe(true);
  });
});
