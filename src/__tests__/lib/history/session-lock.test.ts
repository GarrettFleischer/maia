import { describe, it, expect } from "bun:test";
import { runExclusive } from "@/lib/history/session-lock";

describe("runExclusive", () => {
  it("serializes concurrent work per session id", async () => {
    const order: string[] = [];
    const s = "sess-1";
    await Promise.all([
      runExclusive(s, async () => {
        order.push("a-start");
        await Promise.resolve();
        order.push("a-end");
      }),
      runExclusive(s, async () => {
        order.push("b-start");
        await Promise.resolve();
        order.push("b-end");
      }),
    ]);
    expect(order.indexOf("a-end")).toBeLessThan(order.indexOf("b-start"));
  });

  it("allows different sessions in parallel", async () => {
    let aDone = false;
    let bDone = false;
    await Promise.all([
      runExclusive("s1", async () => {
        await new Promise((r) => setTimeout(r, 20));
        aDone = true;
      }),
      runExclusive("s2", async () => {
        bDone = true;
      }),
    ]);
    expect(aDone && bDone).toBe(true);
  });
});
