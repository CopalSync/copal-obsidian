import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CrdtNote, type YTransport } from "../../src/crdt/crdt-note";

/**
 * Two in-memory transports that deliver each other's sends asynchronously (a fake network). `close()` sets
 * a `closed` flag and `send()` drops once closed — mirroring the real `WsTransport`, so a "clear presence
 * on disconnect" test genuinely verifies the clear is sent BEFORE the transport closes (a clear sent after
 * close is silently dropped, exactly as in production).
 */
function pairedTransports(): { a: YTransport; b: YTransport } {
  let aRecv: ((d: ArrayBuffer) => void) | undefined;
  let bRecv: ((d: ArrayBuffer) => void) | undefined;
  let aClosed = false;
  let bClosed = false;
  const a: YTransport = {
    send: (d) => {
      if (aClosed) return;
      queueMicrotask(() => bRecv?.(d));
    },
    onMessage: (cb) => {
      aRecv = cb as (d: ArrayBuffer) => void;
    },
    onOpen: (cb) => cb(),
    close: () => {
      aClosed = true;
    },
  };
  const b: YTransport = {
    send: (d) => {
      if (bClosed) return;
      queueMicrotask(() => aRecv?.(d));
    },
    onMessage: (cb) => {
      bRecv = cb as (d: ArrayBuffer) => void;
    },
    onOpen: (cb) => cb(),
    close: () => {
      bClosed = true;
    },
  };
  return { a, b };
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("CrdtNote", () => {
  it("syncs a local edit from one replica to the other", async () => {
    const { a, b } = pairedTransports();
    const na = new CrdtNote(a);
    const nb = new CrdtNote(b);
    na.edit((t) => t.insert(0, "hello world"));
    await waitFor(() => nb.text() === "hello world");
    expect(nb.text()).toBe("hello world");
  });

  it("converges concurrent divergent edits (CRDT, no conflict)", async () => {
    const { a, b } = pairedTransports();
    const na = new CrdtNote(a);
    const nb = new CrdtNote(b);
    na.edit((t) => t.insert(0, "MID\n"));
    await waitFor(() => nb.text() === "MID\n");
    na.edit((t) => t.insert(0, "TOP\n"));
    nb.edit((t) => t.insert(t.length, "BOT\n"));
    const expected = "TOP\nMID\nBOT\n";
    await waitFor(() => na.text() === expected && nb.text() === expected);
    expect(na.text()).toBe(expected);
    expect(nb.text()).toBe(expected);
  });

  it("whenSynced resolves once the initial sync completes", async () => {
    const { a, b } = pairedTransports();
    const na = new CrdtNote(a);
    new CrdtNote(b); // a peer that replies so the handshake completes
    await na.whenSynced(); // hangs (test times out) if the synced signal never fires
    expect(na.text()).toBe("");
  });

  it("syncs awareness (presence) between replicas", async () => {
    const { a, b } = pairedTransports();
    const na = new CrdtNote(a);
    const nb = new CrdtNote(b);
    na.awareness.setLocalStateField("user", { name: "agent", color: "#EA9E2A" });
    await waitFor(() => nb.awareness.getStates().has(na.awareness.clientID));
    const state = nb.awareness.getStates().get(na.awareness.clientID) as
      | { user?: { name?: string } }
      | undefined;
    expect(state?.user?.name).toBe("agent");
  });

  it("clears its presence on peers immediately on a clean disconnect", async () => {
    // On a clean disconnect a peer must broadcast a presence-clear BEFORE the socket closes, so the other
    // side drops its caret at once instead of waiting ~30s for yCollab's outdatedTimeout.
    const { a, b } = pairedTransports();
    const na = new CrdtNote(a);
    const nb = new CrdtNote(b);
    na.awareness.setLocalStateField("user", { name: "agent", color: "#EA9E2A" });
    await waitFor(() => nb.awareness.getStates().has(na.awareness.clientID));

    na.disconnect();

    await waitFor(() => !nb.awareness.getStates().has(na.awareness.clientID));
    expect(nb.awareness.getStates().has(na.awareness.clientID)).toBe(false);
  });

  it("converges two docs with divergent OFFLINE histories (local-first)", async () => {
    // A shared base, then each side edits independently while disconnected (offline).
    const docA = new Y.Doc();
    docA.getText("content").insert(0, "shared\n");
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    docA.getText("content").insert(docA.getText("content").length, "from A\n");
    docB.getText("content").insert(docB.getText("content").length, "from B\n");

    // Now they connect (come back online) — divergent histories must converge, nothing lost.
    const { a, b } = pairedTransports();
    const na = new CrdtNote(a, docA);
    const nb = new CrdtNote(b, docB);
    await waitFor(
      () => na.text().includes("from A") && na.text().includes("from B") && nb.text() === na.text(),
    );
    expect(na.text()).toBe(nb.text());
    expect(na.text()).toContain("from A");
    expect(na.text()).toContain("from B");
  });

  it("does NOT destroy an injected (store-owned) doc on disconnect", () => {
    const { a } = pairedTransports();
    const doc = new Y.Doc();
    const destroyed = vi.fn();
    doc.on("destroy", destroyed);
    const n = new CrdtNote(a, doc);
    n.disconnect();
    expect(destroyed).not.toHaveBeenCalled();
  });

  it("onChange reports the origin and can unsubscribe", async () => {
    const { a } = pairedTransports();
    const na = new CrdtNote(a);
    const origins: unknown[] = [];
    const off = na.onChange((origin) => origins.push(origin));
    na.edit((t) => t.insert(0, "x"));
    expect(origins).toEqual(["local"]);
    off();
    na.edit((t) => t.insert(0, "y"));
    expect(origins).toEqual(["local"]); // no new entry after unsubscribe
  });
});
