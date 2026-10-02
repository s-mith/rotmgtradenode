// Cross-node swaps (design doc §6.2) as the dispatcher sees them: a withdraw
// row with a SwapSpec becomes a two-way trade-machine assignment, and the
// trade machine's outcome becomes the row's SwapResult. Pure functions, so
// the mapping is testable without a fleet.
import type { Assignment as TradeAssignment, ItemDetail, ItemQty, Outcome } from "../trade/tradeMachine";
import type { Assignment as SiteAssignment, SwapResult } from "./siteApi";
import { coverLines, wantFromWire } from "../../lib/offers";

/**
 * The poster's side is the giver: it sends the request and offers `items`,
 * expecting `gets` back. The taker waits, puts up its own items as the
 * giver's `swapItems`, and accepts first. Both verify the other's window,
 * against the meeting's per-item enchantments when the hub sent them, and
 * both keep at it until the meeting's deadline.
 *
 * A player meeting (the partner is a person's own character) gives the same
 * items, but judges what comes back against the offer's want lines, because
 * which copies the person brings is up to them.
 */
export function swapAssignment(a: SiteAssignment & { kind: "withdraw" }): TradeAssignment {
  const swap = a.swap!;
  const gives = a.items ?? [];
  const ids = a.instanceIds ?? null;
  const count = (l: ItemQty[]) => l.reduce((n, i) => n + i.qty, 0);
  if (swap.player) {
    const lines = wantFromWire(swap.player.lines);
    const incoming = lines.reduce((n, l) => n + l.qty, 0);
    return {
      kind: "player_swap", requestId: a.requestId, partnerIgn: a.ign, items: gives, instanceIds: ids, itemCount: count(gives) + incoming,
      meetingDeadlineAt: swap.deadlineAt ?? null, incomingCount: incoming,
      incomingCheck: (offered, exact) => coverLines(lines, offered.map((o) => ({ itemId: o.itemId, enchantIds: o.enchants })), exact),
    };
  }
  const meeting = { meetingDeadlineAt: swap.deadlineAt ?? null, expectIncoming: swap.getsItems?.length ? swap.getsItems.map((g) => ({ itemId: g.itemId, enchants: g.enchants })) : null };
  if (swap.role === "give") {
    return { kind: "consolidate_give", requestId: a.requestId, partnerIgn: a.ign, items: gives, instanceIds: ids, swapItems: swap.gets, itemCount: count(gives) + count(swap.gets), ...meeting };
  }
  return { kind: "consolidate_take", requestId: a.requestId, partnerIgn: a.ign, items: swap.gets, swapItems: gives, swapInstanceIds: ids, itemCount: count(gives) + count(swap.gets), ...meeting };
}

const detail = (l: ItemDetail[] | undefined): { itemId: string; enchants: number[] | null; count: number }[] | undefined =>
  l === undefined ? undefined : l.map((d) => ({ itemId: d.itemId, enchants: d.enchants, count: d.enchants?.length ?? 0 }));

/** What the row reports: from this bot's point of view, whatever the role. The partner's name is the one the trade window showed when there was one. */
export function swapResult(a: SiteAssignment & { kind: "withdraw" }, outcome: Outcome): SwapResult {
  const gives = a.items ?? [];
  const ids = a.instanceIds ?? [];
  const partnerIgn = ("partnerName" in outcome && outcome.partnerName) || a.ign;
  if (!outcome.ok) return { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn, error: outcome.error, partnerAbsent: outcome.partnerAbsent };
  if (outcome.kind === "player_swap") {
    const gaveItems = detail(outcome.ourOffered);
    const gotItems = detail(outcome.partnerOffered);
    return { ok: true, gave: outcome.gave, gaveInstanceIds: ids, got: outcome.got, partnerIgn, ...(gaveItems ? { gaveItems } : {}), ...(gotItems ? { gotItems } : {}) };
  }
  if (outcome.kind !== "consolidate_give" && outcome.kind !== "consolidate_take") return { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn, error: `unexpected outcome ${outcome.kind}` };
  // consolidate_give: consolidated = what we gave, swapItems = what came back.
  // consolidate_take: consolidated = what arrived, swapItems = what we gave.
  const gave = outcome.kind === "consolidate_give" ? outcome.consolidated : outcome.swapItems ?? gives;
  const got = outcome.kind === "consolidate_give" ? outcome.swapItems ?? [] : outcome.consolidated;
  const gaveItems = detail(outcome.ourOffered);
  const gotItems = detail(outcome.partnerOffered);
  return { ok: true, gave, gaveInstanceIds: ids, got, partnerIgn, ...(gaveItems ? { gaveItems } : {}), ...(gotItems ? { gotItems } : {}) };
}
