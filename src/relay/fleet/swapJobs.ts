// Cross-node swaps (design doc §6.2) as the dispatcher sees them: a withdraw
// row with a SwapSpec becomes a two-way trade-machine assignment, and the
// trade machine's outcome becomes the row's SwapResult. Pure functions, so
// the mapping is testable without a fleet.
import type { Assignment as TradeAssignment, ItemQty, Outcome } from "../trade/tradeMachine";
import type { Assignment as SiteAssignment, SwapResult } from "./siteApi";

/**
 * The poster's side is the giver: it sends the request and offers `items`,
 * expecting `gets` back. The taker waits, puts up its own items as the
 * giver's `swapItems`, and accepts first. Both verify the other's window.
 */
export function swapAssignment(a: SiteAssignment & { kind: "withdraw" }): TradeAssignment {
  const swap = a.swap!;
  const gives = a.items ?? [];
  const ids = a.instanceIds ?? null;
  const count = (l: ItemQty[]) => l.reduce((n, i) => n + i.qty, 0);
  if (swap.role === "give") {
    return { kind: "consolidate_give", requestId: a.requestId, partnerIgn: a.ign, items: gives, instanceIds: ids, swapItems: swap.gets, itemCount: count(gives) + count(swap.gets) };
  }
  return { kind: "consolidate_take", requestId: a.requestId, partnerIgn: a.ign, items: swap.gets, swapItems: gives, swapInstanceIds: ids, itemCount: count(gives) + count(swap.gets) };
}

/** What the row reports: from this bot's point of view, whatever the role. */
export function swapResult(a: SiteAssignment & { kind: "withdraw" }, outcome: Outcome): SwapResult {
  const gives = a.items ?? [];
  const ids = a.instanceIds ?? [];
  const partnerIgn = a.ign;
  if (!outcome.ok) return { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn, error: outcome.error, partnerAbsent: outcome.partnerAbsent };
  if (outcome.kind !== "consolidate_give" && outcome.kind !== "consolidate_take") return { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn, error: `unexpected outcome ${outcome.kind}` };
  // consolidate_give: consolidated = what we gave, swapItems = what came back.
  // consolidate_take: consolidated = what arrived, swapItems = what we gave.
  const gave = outcome.kind === "consolidate_give" ? outcome.consolidated : outcome.swapItems ?? gives;
  const got = outcome.kind === "consolidate_give" ? outcome.swapItems ?? [] : outcome.consolidated;
  return { ok: true, gave, gaveInstanceIds: ids, got, partnerIgn };
}
