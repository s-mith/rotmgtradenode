import { useState } from "react";

// One open (or just-finished) request group as the player sees it: the trade
// they should act on now, the bot to /trade, and how far along a multi-bot
// request is. Shared by the transact form (outcome of the request it just
// sent) and the In Flight panel (every open request, server-backed, so it
// survives a reload).
export type TradeStep = { requestId: number; status: string; botIgn: string | null };

export function TradeStepperBox({
  kind,
  trades,
  tradeCount,
  status,
  endReason = null,
  communism = false,
}: {
  kind: "withdraw" | "deposit";
  trades: TradeStep[];
  tradeCount: number;
  status: "polling" | "in-flight" | "fulfilled" | "partial" | "cancelled" | "timeout";
  endReason?: string | null;
  /** A communism trade: "full" means communism accounts, not the pool. */
  communism?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (status === "polling" && trades.length === 0) {
    return (
      <div className="hint-box">
        <p style={{ margin: 0 }}>
          <strong>
            Waiting for {tradeCount > 1 ? `${tradeCount} bots` : "a bot"} to
            claim your {kind}…
          </strong>
          <br />
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            Once a bot is assigned, you&rsquo;ll see its name below.
          </span>
        </p>
      </div>
    );
  }

  if (status === "cancelled") {
    // A request the node ended says why (the server had a login queue, no
    // bot has the room, the trade window never opened); anything else timed out.
    const why = endReason && endReason !== "vault-full" ? endReason : null;
    return (
      <div className="hint-box hint-box-bad">
        <p style={{ margin: 0 }}>
          <strong>{kind === "withdraw" ? "Withdraw" : "Deposit"} cancelled.</strong>{" "}
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            {why ? `${why.replace(/\.$/, "")}.` : "The request timed out before it could be fulfilled. Try again later."}
          </span>
        </p>
      </div>
    );
  }

  // Pick the trade the user should act on right now. Prefer 'claimed'
  // (a bot is ready to trade) over 'pending' (waiting on a claim). If
  // neither, fall back to the first non-terminal row; finally, the last
  // row so the "Trade N/N" final-state label still renders.
  const activeIdx = (() => {
    let firstClaimed = -1;
    let firstPending = -1;
    let firstNonTerminal = -1;
    for (let i = 0; i < trades.length; i++) {
      const s = trades[i].status;
      if (s === "claimed" && firstClaimed === -1) firstClaimed = i;
      else if (s === "pending" && firstPending === -1) firstPending = i;
      if (
        firstNonTerminal === -1 &&
        s !== "fulfilled" &&
        s !== "cancelled" &&
        s !== "failed"
      ) {
        firstNonTerminal = i;
      }
    }
    if (firstClaimed !== -1) return firstClaimed;
    if (firstPending !== -1) return firstPending;
    if (firstNonTerminal !== -1) return firstNonTerminal;
    return Math.max(0, trades.length - 1);
  })();
  const active = trades[activeIdx] ?? null;
  const totalSteps = trades.length > 0 ? trades.length : tradeCount;
  // Step number = how many trades are DONE plus 1 (this one). Reads as
  // "you're on trade 2 of 3" even when the rows are out of order, instead
  // of stuck on whichever row happens to be earliest by id.
  const completedSoFar = trades.filter(
    (t) => t.status === "fulfilled" || t.status === "cancelled" || t.status === "failed",
  ).length;
  const stepNumber = Math.min(completedSoFar + 1, totalSteps || 1);
  const fulfilledCount = trades.filter((t) => t.status === "fulfilled").length;

  const allDone = trades.length > 0 && trades.every((t) => t.status === "fulfilled");
  const wrapperClass =
    "hint-box " +
    (status === "fulfilled" || allDone
      ? "hint-box-good"
      : status === "partial"
        ? "hint-box-bad"
        : "");

  if (allDone || status === "fulfilled") {
    // A deposit is one trade, so "complete" is the trade going through. When
    // it also used up the last of the room, say so: the player may be
    // about to queue another and find no bot can take it.
    const vaultFull = kind === "deposit" && endReason === "vault-full";
    return (
      <div className={wrapperClass}>
        <p style={{ margin: 0 }}>
          <strong>
            {vaultFull
              ? communism
                ? "Deposit complete — communism is now full."
                : "Deposit complete — the pool is now full."
              : `${kind === "withdraw" ? "Withdraw" : "Deposit"} complete.`}
          </strong>{" "}
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            {vaultFull
              ? communism
                ? "The trade went through. Every communism slot on this node is taken now — another deposit will have to wait for someone to take something."
                : "The trade went through. No bot in this pool has a free slot left — another deposit will have to wait for a withdrawal."
              : totalSteps > 1
                ? `All ${totalSteps} trades fulfilled.`
                : kind === "deposit"
                  ? "Trade fulfilled — whatever you handed over is in."
                  : "Trade fulfilled."}
          </span>
        </p>
      </div>
    );
  }

  if (status === "partial") {
    const fulfilled = trades.filter((t) => t.status === "fulfilled").length;
    return (
      <div className={wrapperClass}>
        <p style={{ margin: 0 }}>
          <strong>{kind === "withdraw" ? "Withdraw" : "Deposit"} partially completed.</strong>{" "}
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            {fulfilled}/{totalSteps} trades fulfilled — the rest were cancelled.
          </span>
        </p>
      </div>
    );
  }

  // A bot is "ready to trade" once the row is `claimed` — the dispatcher
  // has picked the work and the bot is heading to nexus / has the trade
  // window open. Until then (still `pending`, or queued behind another
  // fragment waiting on the per-partner cooldown) we show the waiting
  // message instead of a "/trade <name>" hint the user can't act on yet.
  const botReady = active?.status === "claimed" && !!active?.botIgn;
  const tradeCmd = botReady && active ? `/trade ${active.botIgn}` : null;
  const stepLabel =
    totalSteps > 1
      ? `Trade ${stepNumber}/${totalSteps}` +
        (fulfilledCount > 0 ? ` — ${fulfilledCount} done` : "")
      : "Trade";

  return (
    <div className={wrapperClass}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong>{stepLabel}</strong>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          {active?.status ?? "pending"}
        </span>
      </div>
      <div style={{ marginTop: 6, fontSize: 13 }}>
        {botReady && active ? (
          <>
            Bot: <strong>{active.botIgn}</strong>
          </>
        ) : (
          <em>waiting for a bot to claim this trade…</em>
        )}
      </div>
      {tradeCmd && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            borderRadius: 4,
            background: "var(--bg-alt, rgba(255,255,255,0.04))",
            fontSize: 12,
          }}
        >
          <div style={{ color: "var(--muted)", marginBottom: 4 }}>
            If the bot is taking too long, paste this in Realm chat to start
            the trade manually:
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code style={{ flex: 1 }}>{tradeCmd}</code>
            <button
              type="button"
              onClick={() => copy(tradeCmd)}
              className="hint-box-copy"
            >
              {copied ? "✓ copied" : "copy"}
            </button>
          </div>
        </div>
      )}
      {status === "timeout" && (
        <div style={{ marginTop: 6, color: "var(--muted)", fontSize: 12 }}>
          Still waiting — leave the page open, bots may still pick this up.
        </div>
      )}
    </div>
  );
}
