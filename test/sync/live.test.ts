import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change, SyncApi } from "../../src/sync/api";
import { type RemoteSink, SyncClient } from "../../src/sync/live";
import { type SyncData, SyncState } from "../../src/sync/state";

type Cursor = { knownServer: string[]; head: number };

class StubWs {
  static OPEN = 1;
  readyState = 1;
  private handlers: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public url: string) {}
  addEventListener(type: string, h: (e: unknown) => void): void {
    (this.handlers[type] ??= []).push(h);
  }
  emit(type: string, e: unknown): void {
    for (const h of this.handlers[type] ?? []) h(e);
  }
  close(): void {}
}

describe("SyncClient", () => {
  let created: StubWs[] = [];
  beforeEach(() => {
    created = [];
    vi.stubGlobal(
      "WebSocket",
      class extends StubWs {
        constructor(url: string) {
          super(url);
          created.push(this);
        }
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function make(sink: RemoteSink, onSave?: (d: SyncData) => void): SyncClient {
    const api = {
      ticket: () => Promise.resolve({ ticket: "t", url: "wss://x/sync" }),
    } as unknown as SyncApi;
    const state = new SyncState(
      () => Promise.resolve({ lastSeq: 0, knownServer: [] }),
      (d) => {
        onSave?.(d);
        return Promise.resolve();
      },
    );
    return new SyncClient(api, sink, state, () => undefined);
  }

  it("reconciles on start and routes each change frame to the sink, in order", async () => {
    const reconcile = vi
      .fn<(k?: readonly string[]) => Promise<Cursor>>()
      .mockResolvedValue({ knownServer: [], head: 0 });
    const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
    const client = make({ reconcile, onRemoteChange });
    await client.start();
    expect(reconcile).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    const ws = created[0]!;
    ws.emit("message", {
      data: JSON.stringify({
        type: "change",
        change: { seq: 3, path: "b.md", op: "put", origin: "crdt", ts: 1 },
      }),
    });
    ws.emit("message", {
      data: JSON.stringify({
        type: "delta",
        changes: [{ seq: 4, path: "c.md", op: "put", origin: "agent", ts: 1 }],
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    const paths = onRemoteChange.mock.calls.map((c) => (c[0] as Change).path);
    expect(paths).toEqual(["b.md", "c.md"]);
  });

  it("drops a malformed change frame but keeps valid ones in order", async () => {
    const reconcile = vi
      .fn<(k?: readonly string[]) => Promise<Cursor>>()
      .mockResolvedValue({ knownServer: [], head: 0 });
    const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
    const client = make({ reconcile, onRemoteChange });
    await client.start();
    await Promise.resolve();
    await Promise.resolve();
    created[0]!.emit("message", {
      data: JSON.stringify({
        type: "delta",
        changes: [
          { seq: 1, path: "a.md", op: "put", origin: "x", ts: 1 },
          { seq: 2, path: "../evil.md", op: "put", origin: "x", ts: 1 }, // traversal → dropped
          { seq: 3, path: "c.md", op: "frob", origin: "x", ts: 1 }, // bad op → dropped
          { seq: 4, path: "d.md", op: "delete", origin: "x", ts: 1 },
        ],
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    const paths = onRemoteChange.mock.calls.map((c) => (c[0] as Change).path);
    expect(paths).toEqual(["a.md", "d.md"]);
  });

  it("refuses a downgraded ws:// ticket URL — no socket, goes offline", async () => {
    const statuses: string[] = [];
    const api = {
      ticket: () => Promise.resolve({ ticket: "t", url: "ws://x/sync" }),
    } as unknown as SyncApi;
    const state = new SyncState(
      () => Promise.resolve({ lastSeq: 0, knownServer: [] }),
      () => Promise.resolve(),
    );
    const reconcile = vi
      .fn<(k?: readonly string[]) => Promise<Cursor>>()
      .mockResolvedValue({ knownServer: [], head: 0 });
    const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
    const client = new SyncClient(api, { reconcile, onRemoteChange }, state, (s) =>
      statuses.push(s),
    );
    await client.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(0); // assertWssUrl threw → no WebSocket constructed
    expect(statuses).toContain("offline");
    client.stop(); // clear the pending reconnect timer
  });

  it("start(mode) threads the mode to reconcile; syncNow always merges (never trashes)", async () => {
    const reconcile = vi
      .fn<(k?: readonly string[], mode?: "merge" | "adopt") => Promise<Cursor>>()
      .mockResolvedValue({ knownServer: [], head: 0 });
    const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
    const client = make({ reconcile, onRemoteChange });
    await client.start("adopt");
    expect(reconcile).toHaveBeenLastCalledWith([], "adopt");
    await client.syncNow();
    expect(reconcile).toHaveBeenLastCalledWith([], "merge");
  });

  it("drains pending mutations when the WS opens (came-back-online replay)", async () => {
    const reconcile = vi
      .fn<(k?: readonly string[]) => Promise<Cursor>>()
      .mockResolvedValue({ knownServer: [], head: 0 });
    const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
    const drainPending = vi.fn<() => Promise<void>>().mockResolvedValue();
    const client = make({ reconcile, onRemoteChange, drainPending });
    await client.start();
    await Promise.resolve();
    await Promise.resolve();
    created[0]!.emit("open", {}); // the socket (re)connected
    await Promise.resolve();
    expect(drainPending).toHaveBeenCalled(); // queued offline deletes replay now
  });

  it("persists the reconcile cursor (knownServer + lastSeq=head) BEFORE opening the WS", async () => {
    const saved: SyncData[] = [];
    const reconcile = vi
      .fn<(k?: readonly string[]) => Promise<Cursor>>()
      .mockResolvedValue({ knownServer: ["a.md"], head: 9 });
    const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
    const client = make({ reconcile, onRemoteChange }, (d) => saved.push(d));
    await client.start();
    await Promise.resolve();
    await Promise.resolve();
    // Reconcile was handed the persisted knownServer, and the WS resumes from the reconciled head — which
    // only holds if the cursor was persisted before openWs (else `since` would be the stale value).
    expect(reconcile).toHaveBeenCalledWith([], "merge");
    expect(created[0]!.url).toContain("since=9");
    expect(saved.at(-1)).toEqual({ lastSeq: 9, knownServer: ["a.md"] });
  });
});
