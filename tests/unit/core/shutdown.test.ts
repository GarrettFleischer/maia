/**
 * @fileoverview Unit tests for the graceful shutdown coordinator.
 * @module tests/unit/core/shutdown
 */

import { describe, it, expect } from "bun:test";
import { createShutdownCoordinator } from "../../../src/core/shutdown.js";

describe("ShutdownCoordinator", () => {
  it("should register and execute shutdown hooks", async () => {
    const coordinator = createShutdownCoordinator();
    const order: string[] = [];

    coordinator.register("db", async () => { order.push("db"); });
    coordinator.register("gateway", async () => { order.push("gateway"); });

    await coordinator.shutdown("test");

    expect(order).toContain("db");
    expect(order).toContain("gateway");
  });

  it("should execute hooks in reverse priority order (highest first)", async () => {
    const coordinator = createShutdownCoordinator();
    const order: string[] = [];

    coordinator.register("low", async () => { order.push("low"); }, 1);
    coordinator.register("high", async () => { order.push("high"); }, 10);
    coordinator.register("mid", async () => { order.push("mid"); }, 5);

    await coordinator.shutdown("test");

    expect(order).toEqual(["high", "mid", "low"]);
  });

  it("should report isShuttingDown during shutdown", async () => {
    const coordinator = createShutdownCoordinator();

    expect(coordinator.isShuttingDown()).toBe(false);

    let wasShuttingDown = false;
    coordinator.register("check", async () => {
      wasShuttingDown = coordinator.isShuttingDown();
    });

    await coordinator.shutdown("test");

    expect(wasShuttingDown).toBe(true);
    expect(coordinator.isShuttingDown()).toBe(true);
  });

  it("should continue even if a hook throws", async () => {
    const coordinator = createShutdownCoordinator();
    const order: string[] = [];

    coordinator.register("failing", async () => { throw new Error("fail"); }, 10);
    coordinator.register("succeeding", async () => { order.push("ok"); }, 1);

    await coordinator.shutdown("test");

    expect(order).toContain("ok");
  });

  it("should not run hooks twice", async () => {
    const coordinator = createShutdownCoordinator();
    let count = 0;

    coordinator.register("once", async () => { count++; });

    await coordinator.shutdown("first");
    await coordinator.shutdown("second");

    expect(count).toBe(1);
  });

  it("should pass the reason to hooks", async () => {
    const coordinator = createShutdownCoordinator();
    let receivedReason = "";

    coordinator.register("check", async (reason) => {
      receivedReason = reason;
    });

    await coordinator.shutdown("watchdog-critical");

    expect(receivedReason).toBe("watchdog-critical");
  });
});
