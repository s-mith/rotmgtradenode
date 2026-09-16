// The live bus's raids channel: a burst of changes reaches the browsers as one event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../poolSnapshot", () => ({ markPoolDirty: vi.fn(), refreshPoolSnapshot: vi.fn(async () => null) }));

const { emitRaids, RAIDS_COALESCE_MS, subscribe } = await import("../liveBus");

describe("emitRaids", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst into one event, then starts a new window", () => {
    const seen: string[] = [];
    const off = subscribe((ev) => seen.push(ev.kind));
    emitRaids();
    emitRaids();
    emitRaids();
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(RAIDS_COALESCE_MS);
    expect(seen).toEqual(["raids"]);
    emitRaids();
    vi.advanceTimersByTime(RAIDS_COALESCE_MS);
    expect(seen).toEqual(["raids", "raids"]);
    off();
  });
});
