import { describe, expect, it } from "vitest";

import { AwarenessRateLimiter } from "../room.js";

describe("awareness rate limiter", () => {
  it("admits a normal burst of frames", () => {
    const limiter = new AwarenessRateLimiter(90, 60, 1_000);
    // A legitimate client sends about one frame per animation frame.
    for (let index = 0; index < 60; index += 1) {
      expect(limiter.tryConsume(1_000)).toBe(true);
    }
    expect(limiter.droppedCount).toBe(0);
  });

  it("rejects a flood beyond the bucket capacity", () => {
    const limiter = new AwarenessRateLimiter(90, 60, 1_000);
    let admitted = 0;
    for (let index = 0; index < 500; index += 1) {
      if (limiter.tryConsume(1_000)) admitted += 1;
    }
    // Capacity is 90 and no time passes, so exactly 90 are admitted.
    expect(admitted).toBe(90);
    expect(limiter.droppedCount).toBe(410);
  });

  it("refills over elapsed time", () => {
    const limiter = new AwarenessRateLimiter(90, 60, 1_000);
    for (let index = 0; index < 90; index += 1) limiter.tryConsume(1_000);
    expect(limiter.tryConsume(1_000)).toBe(false);

    // One second later the bucket has refilled to capacity.
    expect(limiter.tryConsume(2_000)).toBe(true);
  });

  it("never refills past capacity", () => {
    const limiter = new AwarenessRateLimiter(10, 60, 0);
    // Ten minutes of idle time must not accumulate a huge allowance.
    let admitted = 0;
    for (let index = 0; index < 100; index += 1) {
      if (limiter.tryConsume(600_000)) admitted += 1;
    }
    expect(admitted).toBe(10);
  });

  it("counts drops without throwing", () => {
    const limiter = new AwarenessRateLimiter(1, 1, 0);
    expect(limiter.tryConsume(0)).toBe(true);
    expect(limiter.tryConsume(0)).toBe(false);
    expect(limiter.droppedCount).toBe(1);
  });
});
