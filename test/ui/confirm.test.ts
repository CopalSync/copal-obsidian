// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmModal, confirmModal } from "../../src/ui/confirm";
import { stubApp } from "../stubs/obsidian";

/**
 * Driven by CLICKING THE REAL BUTTONS.
 *
 * These used to call the public `confirm()`/`cancel()` methods instead, because the old double's
 * `Setting.addButton` constructed a `ButtonComponent`, invoked the callback and discarded it — so no test
 * could reach a button. That made the wiring between a button and its action untestable: the dialog could
 * have rendered a Cancel that did nothing and every test would still have passed.
 */
const opts = {
	title: "Disconnect?",
	body: "This unlinks the folder.",
	cta: "Disconnect",
	danger: true,
};

/** Click the rendered button with this label, failing loudly if the dialog never drew it. */
function press(label: string): void {
	const button = [...document.body.querySelectorAll("button")].find((b) => b.textContent === label);
	if (button === undefined) {
		throw new Error(
			`the dialog drew no ${JSON.stringify(label)} button; found ${JSON.stringify(
				[...document.body.querySelectorAll("button")].map((b) => b.textContent),
			)}`,
		);
	}
	button.click();
}

afterEach(() => document.body.empty());

describe("what the dialog renders", () => {
	it("shows the title, the body, and both actions", async () => {
		const modal = new ConfirmModal(stubApp(), opts);
		const answer = modal.ask();
		expect(document.body.textContent).toMatch(/Disconnect\?/);
		expect(document.body.textContent).toMatch(/This unlinks the folder\./);
		const labels = [...document.body.querySelectorAll("button")].map((b) => b.textContent);
		expect(labels).toEqual(["Cancel", "Disconnect"]);
		press("Cancel");
		await answer;
	});

	it("styles a dangerous confirm as a warning, not a primary CTA", async () => {
		const modal = new ConfirmModal(stubApp(), { ...opts, danger: true });
		const answer = modal.ask();
		const cta = [...document.body.querySelectorAll("button")].find(
			(b) => b.textContent === "Disconnect",
		);
		expect(cta?.classList.contains("mod-warning")).toBe(true);
		expect(cta?.classList.contains("mod-cta")).toBe(false);
		press("Cancel");
		await answer;
	});

	it("styles a non-dangerous confirm as a primary CTA", async () => {
		const modal = new ConfirmModal(stubApp(), { ...opts, cta: "Adopt", danger: false });
		const answer = modal.ask();
		const cta = [...document.body.querySelectorAll("button")].find(
			(b) => b.textContent === "Adopt",
		);
		expect(cta?.classList.contains("mod-cta")).toBe(true);
		expect(cta?.classList.contains("mod-warning")).toBe(false);
		press("Cancel");
		await answer;
	});
});

describe("ConfirmModal", () => {
	it("resolves true when the confirm BUTTON is clicked", async () => {
		const modal = new ConfirmModal(stubApp(), opts);
		const answer = modal.ask();
		press("Disconnect");
		expect(await answer).toBe(true);
	});

	it("resolves false when the cancel BUTTON is clicked", async () => {
		const modal = new ConfirmModal(stubApp(), opts);
		const answer = modal.ask();
		press("Cancel");
		expect(await answer).toBe(false);
	});

	it("resolves false when the modal is closed without a choice", async () => {
		const modal = new ConfirmModal(stubApp(), opts);
		const answer = modal.ask();
		modal.close(); // dismissed (Esc / click-away) → defaults to false
		expect(await answer).toBe(false);
	});

	it("resolves only once even if closed again after confirming", async () => {
		const modal = new ConfirmModal(stubApp(), opts);
		const answer = modal.ask();
		press("Disconnect");
		modal.close(); // a second close must not re-resolve
		expect(await answer).toBe(true);
	});

	it("tears its content down on close, so a reopened dialog does not stack", async () => {
		const modal = new ConfirmModal(stubApp(), opts);
		const answer = modal.ask();
		press("Cancel");
		await answer;
		expect(document.body.querySelectorAll("button").length).toBe(0);
	});
});

describe("confirmModal", () => {
	it("is the one-call form used by the destructive paths", async () => {
		const answer = confirmModal(stubApp(), { ...opts, cta: "Adopt" });
		press("Adopt");
		expect(await answer).toBe(true);
	});
});
