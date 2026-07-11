import { describe, expect, it } from "vitest";
import * as Y from "yjs";

/**
 * Adversarial convergence fuzzer — the bulletproof gate. It models exactly what Copal's sync does (peers
 * accumulate ops while offline, then exchange them by state vector on reconnect) across many deterministic
 * scenarios of concurrent edits + random offline windows, and asserts on EVERY run that all replicas
 * converge to one text AND every inserted token survives (zero loss). A failure here is a real bug.
 *
 * Deterministic (a seeded LCG, never Math.random/Date.now) so any failure reproduces exactly.
 */

/** Exchange ops between two docs by state vector — precisely what our `y-sync` handshake transfers. */
function sync(a: Y.Doc, b: Y.Doc): void {
  const av = Y.encodeStateVector(a);
  const bv = Y.encodeStateVector(b);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, av));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, bv));
}

function lcg(seed: number): () => number {
  let s = (seed * 2654435761) & 0x7fffffff;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe("adversarial convergence fuzzer", () => {
  const SCENARIOS = 50;
  for (let scenario = 0; scenario < SCENARIOS; scenario++) {
    it(`converges with zero loss under offline + concurrent edits (scenario ${scenario})`, () => {
      const rand = lcg(scenario + 1);
      const n = 3 + (scenario % 4); // 3–6 replicas + a server
      const server = new Y.Doc();
      server.getText("t").insert(0, "BASE\n");
      const replicas = Array.from({ length: n }, () => {
        const d = new Y.Doc();
        Y.applyUpdate(d, Y.encodeStateAsUpdate(server)); // shared base history
        return d;
      });
      const online = replicas.map(() => true);
      const tokens = new Set<string>();
      const rounds = 8 + (scenario % 6);

      for (let round = 0; round < rounds; round++) {
        for (let i = 0; i < n; i++) {
          if (rand() < 0.3) online[i] = !online[i]; // network flaps
          const token = `<${i}.${round}>`;
          tokens.add(token);
          const t = replicas[i]!.getText("t");
          t.insert(Math.floor(rand() * (t.length + 1)), token); // edit at a pseudo-random position
          if (online[i]) sync(replicas[i]!, server); // an online replica syncs; an offline one accumulates
        }
      }

      // Everyone reconnects; converge to quiescence.
      for (let pass = 0; pass < 3; pass++) for (const r of replicas) sync(r, server);

      const text = server.getText("t").toString();
      for (const r of replicas) expect(r.getText("t").toString()).toBe(text); // all converged

      // Zero loss: every inserted character survives exactly once (concurrent interior inserts legitimately
      // interleave tokens, so compare the character MULTISET, not substring order).
      const multiset = (s: string) => [...s].sort().join("");
      const expected = `BASE\n${[...tokens].join("")}`;
      expect(multiset(text)).toBe(multiset(expected));
    });
  }
});
