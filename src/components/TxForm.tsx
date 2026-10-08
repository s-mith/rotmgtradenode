
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveUpdates } from "@/lib/useLive";
import { SERVERS, WITHDRAW_SERVERS, isDepositOnly } from "@/lib/servers";
import { serverOffLabel, useServerControls } from "@/lib/useServerControls";
import { MAX_TRADE_SLOTS } from "@/lib/depositSizes";
import { POTION_STATS, STAT_LABELS, type PotionStat } from "@/lib/potionPlan";
import type { PoolInstance, Tab, CommunismRoom } from "./Vault";
import { ItemSprite } from "./ItemSprite";
import { TradeStepperBox } from "./TradeStepper";

type Capacity = {
  botCount: number;
  totalSlots: number;
  usedSlots: number;
  availableSlots: number;
  full: boolean;
  /** The biggest one-bot trade possible right now (16 needs an empty backpack bot). */
  largestFree?: number;
  /** No 16-slot bot is ready, but the fleet can fit an empty one with a backpack for a deposit that asks. */
  canMake16?: boolean;
  /** Advanced management: a deposit goes to an empty bot and continues with the next when it brings more than that bot holds (pool, then communism). */
  continues?: boolean;
  communismContinues?: boolean;
};

type GroupHint = {
  groupId: string;
  tradeCount: number;
  trades: { requestId: number; status: string; botIgn: string | null }[];
  status: "polling" | "in-flight" | "fulfilled" | "partial" | "cancelled" | "gone";
  // Deposits only: why the chain stopped, when it stopped for a reason other
  // than the player under-filling a trade. 'vault-full' = the pool ran out
  // of room, so there was nothing left to chain to.
  endReason?: string | null;
};

// Status for an open group. The live stream announces every change to it
// (see useLiveUpdates.onRequest), so the poll here is only a slow safety net
// for a dropped stream — not the mechanism. It follows the group until it
// ends, however long its trades take; only a group the node no longer knows
// (404) stops it.
function pollGroup(
  url: string,
  groupId: string,
  setter: React.Dispatch<React.SetStateAction<GroupHint | null>>,
  wake: { current: (() => void) | null },
): () => void {
  let cancelled = false;
  const POLL_MS = 15_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (cancelled) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.status === 404) {
        if (!cancelled) setter((cur) => (cur && cur.groupId === groupId ? { ...cur, status: "gone" } : cur));
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as {
        groupStatus: "in-flight" | "fulfilled" | "partial" | "cancelled";
        tradeCount: number;
        trades: { requestId: number; status: string; botIgn: string | null }[];
        // Deposit groups only; the withdraw endpoint doesn't send it.
        endReason?: string | null;
      };
      if (cancelled) return;
      setter((cur) =>
        cur && cur.groupId === groupId
          ? {
              ...cur,
              trades: data.trades,
              status: data.groupStatus === "in-flight" ? "polling" : data.groupStatus,
              endReason: data.endReason ?? null,
            }
          : cur,
      );
      if (data.groupStatus !== "in-flight") return;
    } catch {
      // ignore — next tick will retry
    }
    timer = setTimeout(tick, POLL_MS);
  };
  wake.current = () => void tick();
  timer = setTimeout(tick, POLL_MS);
  return () => {
    cancelled = true;
    wake.current = null;
    if (timer !== null) clearTimeout(timer);
  };
}

export default function TxForm({
  ign,
  tab,
  onTabChange,
  mode,
  seasonal,
  communism,
  trayInstances,
  onRemoveFromTray,
  onClearTray,
  onComplete,
  maxTray,
}: {
  // Verified session IGN, or null when not logged in. Sourced from the login
  // panel above — there's no IGN field here anymore.
  ign: string | null;
  tab: Tab;
  onTabChange: (t: Tab) => void;
  // "pool": deposit / withdraw / potions against the pool.
  // "communism": deposit into, or take out of, communism accounts.
  mode: "pool" | "communism";
  // Active pool half — deposits are routed to a bot of this type.
  seasonal: boolean;
  /** Communism's room for `seasonal`'s half (communism mode). */
  communism: CommunismRoom | null;
  trayInstances: (PoolInstance | null)[];
  onRemoveFromTray: (index: number) => void;
  onClearTray: () => void;
  onComplete: () => void;
  maxTray: number;
}) {
  const [server, setServer] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [withdrawHint, setWithdrawHint] = useState<GroupHint | null>(null);
  // Bulk potion mode: the player names a stat and how many points they're
  // short of max, and the server picks the potions (greaters first).
  const [potionStat, setPotionStat] = useState<PotionStat>("atk");
  const [potionPoints, setPotionPoints] = useState("");
  const [depositHint, setDepositHint] = useState<GroupHint | null>(null);
  // How big a trade the deposit asks for: an empty bot (8) or an empty bot
  // with a backpack (16). One trade either way.
  const [depositSlots, setDepositSlots] = useState(8);
  // A prior submit was refused because this IGN already has something open. The
  // player's logged in, so we offer a one-click cancel of their own queue
  // (POST /api/cancel) rather than the old whispered-code box.
  const [hasOpen, setHasOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Polled: Realm's load closes and reopens servers by the minute.
  const disabledServers = useServerControls();

  const trayFilled = trayInstances.filter((x): x is PoolInstance => x !== null);

  // A server that closes under the player's selection (it filled up, or an
  // operator switched it off) is dropped from the picker, so the submit
  // can't 403 on a choice the list no longer offers.
  useEffect(() => {
    if (!server) return;
    const ds = disabledServers[server];
    const off = tab === "deposit" ? ds?.deposits : ds?.withdraws;
    if (off) setServer("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabledServers, tab]);

  useEffect(() => {
    let cancelled = false;
    // Capacity is per pool — ask for the active pool's numbers so the
    // non-seasonal tab doesn't show seasonal storage. Clear first so a
    // slow response can't leave the other pool's numbers on screen.
    // Communism reads only whether its deposits continue from it; its room
    // comes with the communism view.
    setCapacity(null);
    fetch(`/api/capacity?pool=${seasonal ? "seasonal" : "nonseasonal"}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setCapacity(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [submitting, seasonal, mode]);

  // The most one deposit can be right now: a trade lands on one bot, so the
  // biggest free space on one (the pool), or what communism has left. The
  // count follows it down when that shrinks.
  const depositMax = Math.min(MAX_TRADE_SLOTS, mode === "communism" ? Math.max(0, communism?.free ?? MAX_TRADE_SLOTS) : capacity?.largestFree ?? MAX_TRADE_SLOTS);
  // Advanced management on the node: an empty bot meets the player, and a
  // deposit bigger than it holds continues with the next empty bot.
  const depositContinues = mode === "communism" ? !!capacity?.communismContinues : !!capacity?.continues;
  useEffect(() => {
    if (depositMax >= 1 && depositSlots > depositMax) setDepositSlots(depositMax);
  }, [depositMax, depositSlots]);

  const withdrawWake = useRef<(() => void) | null>(null);
  const depositWake = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!withdrawHint || withdrawHint.status !== "polling") return;
    return pollGroup(
      `/api/request-status/withdraw-group/${withdrawHint.groupId}`,
      withdrawHint.groupId,
      setWithdrawHint,
      withdrawWake,
    );
  }, [withdrawHint?.groupId, withdrawHint?.status]);

  useEffect(() => {
    if (!depositHint || depositHint.status !== "polling") return;
    return pollGroup(
      `/api/request-status/deposit-group/${depositHint.groupId}`,
      depositHint.groupId,
      setDepositHint,
      depositWake,
    );
  }, [depositHint?.groupId, depositHint?.status]);

  // The server tells us the moment one of our groups moves; refetch then.
  const openGroups = [
    withdrawHint?.status === "polling" ? withdrawHint.groupId : null,
    depositHint?.status === "polling" ? depositHint.groupId : null,
  ].filter((g): g is string => !!g);
  const onRequest = useCallback((groupId: string) => {
    if (withdrawWake.current && groupId === withdrawHintIdRef.current) withdrawWake.current();
    if (depositWake.current && groupId === depositHintIdRef.current) depositWake.current();
  }, []);
  const withdrawHintIdRef = useRef<string | null>(null);
  const depositHintIdRef = useRef<string | null>(null);
  withdrawHintIdRef.current = withdrawHint?.groupId ?? null;
  depositHintIdRef.current = depositHint?.groupId ?? null;
  useLiveUpdates({ onRequest, groups: openGroups });

  // If the user has items in the tray that are all from one server, default
  // the server picker to that. Removes a manual step in the common case.
  useEffect(() => {
    if (tab !== "withdraw") return;
    if (trayFilled.length === 0) return;
    const first = trayFilled[0].server;
    if (!first) return;
    const allSame = trayFilled.every((t) => t.server === first);
    if (allSame && server !== first && !isDepositOnly(first)) setServer(first);
    // Intentionally not depending on `server` — we only want to auto-set
    // when the tray itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trayInstances, tab]);

  function setTab(t: Tab) {
    setMsg(null);
    setWithdrawHint(null);
    setDepositHint(null);
    setHasOpen(false);
    // A deposit-only realm can't be withdrawn from, so don't carry that
    // selection into a withdraw tab — the dropdown won't even list it and the
    // submit would just 400.
    if (t !== "deposit" && isDepositOnly(server)) {
      setServer("");
    }
    onTabChange(t);
  }

  // For withdraw, warn the user if their tray spans multiple servers — the
  // bot can only trade on one server at a time, so we'd reject at submit.
  // Items held by offline bots have server="" and act as wildcards (the
  // dispatcher will wake them onto whatever server the request specifies).
  const trayServers = new Set(trayFilled.map((t) => t.server).filter(Boolean));
  const trayMultiServer = trayServers.size > 1;
  // Only a mismatch when an ONLINE bot's tile is on a server other than
  // what the user picked. Offline tiles (server="") get a pass.
  const trayServerMismatch =
    tab === "withdraw" &&
    server &&
    trayServers.size > 0 &&
    !trayServers.has(server);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setWithdrawHint(null);
    setDepositHint(null);
    setHasOpen(false);
    if (!ign) {
      setMsg({ kind: "err", text: "Log in first — see the panel above." });
      return;
    }
    if (!server) {
      setMsg({ kind: "err", text: "Pick a server." });
      return;
    }
    if (tab === "potions") {
      const n = Number(potionPoints);
      if (!Number.isInteger(n) || n < 1) {
        setMsg({ kind: "err", text: "Enter how many stat points you need." });
        return;
      }
    }
    if (tab === "withdraw") {
      if (trayFilled.length === 0) {
        setMsg({ kind: "err", text: "Click items in the pool to add them." });
        return;
      }
      if (trayMultiServer) {
        setMsg({
          kind: "err",
          text:
            "Tray has items from " +
            [...trayServers].join(", ") +
            " — one withdraw must be a single server.",
        });
        return;
      }
      if (trayServerMismatch) {
        setMsg({
          kind: "err",
          text: "Tray items are on " + [...trayServers].join(", ") + ", not " + server + ".",
        });
        return;
      }
    }
    setSubmitting(true);
    try {
      // A deposit names the size of its one trade (`slots`): a bot with that
      // many free slots meets the player, and whatever crosses is deposited.
      //
      // Every mode carries `seasonal`: the pool tab isn't a display filter,
      // it's which half of the fleet the player's character can trade. On
      // withdraws it decides which bots' stock may be drawn from, so the
      // potion tab — where the player never picks a bot — needs it just as
      // much as the grid does.
      // No `ign` in the body — the server reads it from the session cookie, so
      // the client can't spoof someone else's character.
      // `communism: true` sends the trade to communism accounts instead of the pool.
      const vaultFlag = mode === "communism" ? { communism: true } : {};
      const body =
        tab === "deposit"
          ? { server, seasonal, slots: depositSlots, ...vaultFlag }
          : tab === "potions"
            ? {
                server,
                seasonal,
                potionStat,
                potionPoints: Number(potionPoints),
              }
            : {
                server,
                seasonal,
                instanceIds: trayFilled.map((t) => t.instanceId),
                ...vaultFlag,
              };
      // Bulk potions go to the withdraw endpoint — it's the same request,
      // just expressed in stat points.
      const endpoint = tab === "potions" ? "withdraw" : tab;
      const res = await fetch(`/api/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ kind: "err", text: data.error || "Request failed" });
        // The server refused because this IGN already has something queued.
        // Logged in, so we can offer a one-click cancel of their own queue.
        if (data.hasOpen) setHasOpen(true);
      } else if (tab === "deposit") {
        const tradeCount = Number(data.tradeCount ?? 1);
        const communismRoom = Math.max(0, communism?.free ?? 0);
        setMsg({
          kind: "ok",
          text:
            mode === "communism"
              ? `Communism deposit queued for ${ign} on ${server}. A communism account will meet you for up to ${Math.min(depositSlots, communismRoom)} items; if you bring more than its character holds, the rest goes to its next character or another account with room. Anyone on the hub may take them afterwards.`
              : depositContinues
                ? `Deposit queued for ${ign} on ${server}. An empty bot will meet you — whatever you hand over is deposited, and if you bring more than it holds, the next one comes for the rest.`
                : `Deposit queued for ${ign} on ${server}. A bot with ${depositSlots} free slot${depositSlots === 1 ? "" : "s"} will meet you for one trade — whatever you hand over is deposited.`,
        });
        if (data.groupId) {
          setDepositHint({
            groupId: String(data.groupId),
            tradeCount,
            trades: [],
            status: "polling",
          });
        }
        onComplete();
      } else if (tab === "potions") {
        const tradeCount = Number(data.tradeCount ?? 1);
        const fragNote = tradeCount > 1 ? ` across ${tradeCount} trades` : "";
        const p = data.potion;
        const itemCount = p
          ? Object.values(p.items as Record<string, number>).reduce(
              (a: number, b: number) => a + b,
              0,
            )
          : 0;
        // Be explicit when the pool couldn't cover the whole request, or when
        // an odd request had to be topped off with a greater — the player is
        // counting points and a silent mismatch would look like a bug.
        const shortNote = p?.shortfall
          ? ` Only ${p.pointsFilled} of ${p.pointsRequested} points were available (${p.shortfall} short).`
          : "";
        const overNote = p?.overshoot
          ? ` Includes 1 extra point (no normal potions in stock to finish exactly).`
          : "";
        setMsg({
          kind: p?.shortfall ? "err" : "ok",
          text:
            `Potions queued: ${itemCount} potion${itemCount === 1 ? "" : "s"} ` +
            `= ${p?.pointsFilled ?? 0} ${STAT_LABELS[potionStat]} → ${ign} on ${server}${fragNote}.` +
            shortNote + overNote,
        });
        setWithdrawHint({
          groupId: String(data.groupId),
          tradeCount,
          trades: [],
          status: "polling",
        });
        onComplete();
      } else {
        const tradeCount = Number(data.tradeCount ?? 1);
        const fragNote =
          tradeCount > 1 ? ` (split across ${tradeCount} bots)` : "";
        // Picks in an account's storage: the fleet logs the account in and
        // walks it into the Vault first, so the bot takes longer to show up.
        const fetched = Number(data.fetched ?? 0);
        const fetchNote = fetched > 0 ? ` ${fetched === trayFilled.length ? "They are" : `${fetched} of them are`} in storage: the bot fetches ${fetched === 1 ? "it" : "them"} first, so allow a few extra minutes.` : "";
        setMsg({
          kind: "ok",
          text: `${mode === "communism" ? "Communism withdraw" : "Withdraw"} queued: ${trayFilled.length} item${trayFilled.length === 1 ? "" : "s"} → ${ign} on ${server}${fragNote}.${fetchNote}`,
        });
        setWithdrawHint({
          groupId: String(data.groupId),
          tradeCount,
          trades: [],
          status: "polling",
        });
        onClearTray();
        onComplete();
      }
    } catch {
      setMsg({ kind: "err", text: "Network error" });
    } finally {
      setSubmitting(false);
    }
  }

  // A deposit is one trade of the chosen size, so the pool has to have a
  // bot with that much room: the capacity report says how big the biggest
  // possible trade is right now. The submit-time server check enforces the
  // same thing; this just disables the button proactively.
  const sizeAvailable = (n: number) => capacity === null || (!capacity.full && (capacity.largestFree === undefined || capacity.largestFree >= n));
  const depositBlockedByCapacity =
    mode === "pool" && tab === "deposit" && capacity !== null && !sizeAvailable(depositSlots);
  // Communism deposits stop at the room its accounts have for this half.
  const communismFree = communism ? Math.max(0, communism.free) : null;
  const communismNone = communism !== null && communism.accounts === 0;
  const communismDepositBlocked = mode === "communism" && tab === "deposit" && (communismNone || communismFree === 0);

  const submitDisabled =
    submitting ||
    !ign ||
    !server ||
    (tab === "withdraw" && (trayFilled.length === 0 || trayMultiServer || !!trayServerMismatch)) ||
    (tab === "potions" && !(Number(potionPoints) >= 1)) ||
    depositBlockedByCapacity ||
    communismDepositBlocked;

  // The request the current tab just kicked off, if it's still running. A hint
  // stays "polling" until the group reaches a terminal state (fulfilled /
  // partial / cancelled / timeout), so that's exactly "trade in flight".
  const activeHint = tab === "deposit" ? depositHint : withdrawHint;
  const inFlight = activeHint?.status === "polling";

  // Cancel every open request for the logged-in character. Shared by the
  // "you already have one queued" prompt and the in-flight cancel button. No
  // code — the session proves control — and no timing limit; a claimed trade
  // cancels immediately too.
  async function cancelOpen() {
    setCancelling(true);
    setMsg(null);
    try {
      const r = await fetch("/api/cancel", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        setMsg({ kind: "err", text: d.error || "Couldn't cancel." });
        return;
      }
      setHasOpen(false);
      setDepositHint(null);
      setWithdrawHint(null);
      const n = (d.depositsCancelled ?? 0) + (d.withdrawsCancelled ?? 0);
      setMsg({
        kind: "ok",
        text: n > 0 ? `Cancelled ${n} request${n === 1 ? "" : "s"}.` : "Nothing left to cancel.",
      });
      onComplete();
    } catch {
      setMsg({ kind: "err", text: "Network error." });
    } finally {
      setCancelling(false);
    }
  }

  return (
    <form className="tx" onSubmit={submit}>
      <div className="tabs">
        <button
          type="button"
          className={tab === "deposit" ? "active" : ""}
          onClick={() => setTab("deposit")}
        >
          Deposit
        </button>
        <button
          type="button"
          className={tab === "withdraw" ? "active" : ""}
          onClick={() => setTab("withdraw")}
        >
          Withdraw
        </button>
        {mode === "pool" && (
          <button
            type="button"
            className={tab === "potions" ? "active" : ""}
            onClick={() => setTab("potions")}
          >
            Potions
          </button>
        )}
      </div>

      {!ign && (
        <p className="hint">Log in above to deposit or withdraw.</p>
      )}

      {mode === "communism" && ign && (
        <p className="hint">
          {seasonal ? "Seasonal" : "Non-seasonal"} communism: {communism ? `${communism.used} of ${communism.slots} slots used on ${communism.accounts} account${communism.accounts === 1 ? "" : "s"}` : "…"}
        </p>
      )}


      <label htmlFor="server">Server</label>
      <select
        id="server"
        value={server}
        onChange={(e) => setServer(e.target.value)}
        required
      >
        <option value="">— pick a server —</option>
        {(tab === "deposit" ? SERVERS : WITHDRAW_SERVERS).map((s) => {
          const ds = disabledServers[s];
          const off =
            (tab === "deposit" && ds?.deposits) ||
            (tab !== "deposit" && ds?.withdraws);
          return (
            <option key={s} value={s} disabled={off}>
              {s}{serverOffLabel(ds, tab === "deposit" ? "deposit" : "withdraw")}
            </option>
          );
        })}
      </select>

      {tab === "deposit" && (
        <>
          <label htmlFor="deposit-count">How many items</label>
          <div className="deposit-size">
            <input
              id="deposit-count"
              type="number"
              min={1}
              max={Math.max(1, depositMax)}
              value={depositSlots}
              onChange={(e) => setDepositSlots(Math.max(1, Math.min(Math.max(1, depositMax), Math.floor(Number(e.target.value) || 1))))}
              style={{ width: 72 }}
            />
            <span className="pool-option-hint">
              {depositMax >= 1
                ? mode === "communism"
                  ? `up to ${depositMax}: what communism has left, one character after another`
                  : depositContinues
                    ? `up to ${depositMax}: what the empty bots can take right now, one bot after another`
                    : `up to ${depositMax} in one trade: the most free space on one bot right now`
                : mode === "communism" ? "communism is full" : "no bot has room right now"}
            </span>
          </div>
        </>
      )}
      {tab === "deposit" && mode === "pool" && (
        <p className="hint">
          {depositContinues ? (
            <>Submit and an empty bot meets {ign || "you"} on the chosen server. Whatever you put in the window is deposited; if you bring more than one bot holds, the next empty bot comes for the rest.</>
          ) : (
            <>Submit and a bot with {depositSlots} free slot{depositSlots === 1 ? "" : "s"} meets {ign || "you"} on the chosen server. It&rsquo;s one trade: whatever you put in the window is deposited. For more, open another request afterwards.</>
          )}
        </p>
      )}
      {tab === "deposit" && mode === "communism" && (
        <p className="hint">
          {communismNone
            ? `No ${seasonal ? "seasonal" : "non-seasonal"} account is set aside for communism on this node. Tick "communism" on one under Control panel → Accounts.`
            : communismFree === 0
              ? `The ${seasonal ? "seasonal" : "non-seasonal"} communism is full. It has room again when someone takes something.`
              : `Submit and a ${seasonal ? "seasonal" : "non-seasonal"} communism account meets ${ign || "you"} on the chosen server; if you bring more than its character holds, the rest goes to its next character or another account with room. Whatever you hand over is free for anyone on the hub to take.`}
        </p>
      )}
      {tab === "withdraw" && mode === "communism" && (
        <p className="hint">
          Click items in communism to add them; the account holding them brings them to the chosen server.
        </p>
      )}

      {tab === "potions" && (
        <>
          <label htmlFor="pstat">Stat to max</label>
          <select
            id="pstat"
            value={potionStat}
            onChange={(e) => setPotionStat(e.target.value as PotionStat)}
          >
            {POTION_STATS.map((st) => (
              <option key={st} value={st}>
                {STAT_LABELS[st]}
              </option>
            ))}
          </select>

          <label htmlFor="ppoints">Points needed to max</label>
          <input
            id="ppoints"
            type="number"
            min={1}
            inputMode="numeric"
            value={potionPoints}
            onChange={(e) => setPotionPoints(e.target.value)}
            placeholder="e.g. 23"
          />
          <p className="hint">
            How many points of {STAT_LABELS[potionStat]} you still need — the number
            the game shows on your character, not a potion count. Greater potions are
            worth 2 points and normal ones 1; the pool takes as much as it can from
            one bot before involving another, so you sit through as few trades as
            possible.
          </p>
        </>
      )}

      {tab === "withdraw" && (
        <>
          <label>Withdraw Tray ({trayFilled.length}/{maxTray})</label>
          <WithdrawTray
            slots={trayInstances}
            maxTray={maxTray}
            onRemove={onRemoveFromTray}
          />
          {trayMultiServer && (
            <p className="hint" style={{ color: "var(--bad)" }}>
              Tray spans {[...trayServers].join(", ")} — bots can only trade on
              one server at a time. Remove items so the tray is one server.
            </p>
          )}
          <p className="hint">
            Click items in the pool to add them. Click a slot to remove it.
            Up to {maxTray} items per withdraw.
          </p>
        </>
      )}

      {mode === "pool" && tab === "deposit" && capacity !== null && (
        <div
          className={"capacity" + (depositBlockedByCapacity ? " capacity-bad" : "")}
          style={{
            color: depositBlockedByCapacity ? "var(--bad)" : "var(--muted)",
            fontSize: 13,
            margin: "8px 0 4px",
          }}
        >
          Vault: {capacity.usedSlots} / {capacity.totalSlots} stored
          {capacity.totalSlots > 0 && ` · ${capacity.availableSlots} free`}
          {capacity.largestFree !== undefined && capacity.totalSlots > 0 && ` · biggest ${capacity.continues ? "deposit" : "trade"} ${Math.min(MAX_TRADE_SLOTS, capacity.largestFree)}`}
          {capacity.full && " · FULL"}
        </div>
      )}

      {inFlight ? (
        // A request is running — the submit button becomes a cancel button so
        // the player can pull it at any point, even mid-trade.
        <button
          className="submit submit-cancel"
          type="button"
          disabled={cancelling}
          onClick={cancelOpen}
        >
          {cancelling ? "Cancelling…" : "Cancel Request"}
        </button>
      ) : (
        <button className="submit" type="submit" disabled={submitDisabled}>
          {submitting
            ? "Working…"
            : tab === "deposit"
                  ? depositBlockedByCapacity
                    ? "Pool is full"
                    : communismDepositBlocked
                      ? communismNone ? "No communism account" : "Communism is full"
                      : mode === "communism"
                        ? "Deposit Into The Communism"
                        : "Open Deposit Request"
                  : tab === "potions"
                    ? Number(potionPoints) >= 1
                      ? `Withdraw ${Number(potionPoints)} ${STAT_LABELS[potionStat]}`
                      : "Enter points needed"
                    : `Withdraw ${trayFilled.length} Item${trayFilled.length === 1 ? "" : "s"}`}
        </button>
      )}

      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

      {hasOpen && (
        <div className="cancel-open">
          <p className="hint">
            You already have something queued. Cancel it to submit a new one.
          </p>
          <button
            type="button"
            className="login-secondary"
            disabled={cancelling}
            onClick={cancelOpen}
          >
            {cancelling ? "Cancelling…" : "Cancel my open request"}
          </button>
        </div>
      )}

      {/* Bulk potions are a withdraw: they post to /api/withdraw, get a group
          id back and poll the same endpoint, so they need the same stepper —
          per-trade progress and the "/trade <bot>" copy button. This was gated
          on tab === "withdraw" alone, so the potions tab set withdrawHint and
          polled it but rendered nothing, leaving the player with no bot name to
          trade and no sign that trades were being paced. */}
      {/* While a request is open it is listed (and cancellable) in the In
          Flight panel above, so the form only reports how it ended. */}
      {(tab === "withdraw" || tab === "potions") && withdrawHint && withdrawHint.status !== "polling" && withdrawHint.status !== "gone" && (
        <TradeStepperBox
          kind="withdraw"
          trades={withdrawHint.trades}
          tradeCount={withdrawHint.tradeCount}
          status={withdrawHint.status}
        />
      )}
      {tab === "deposit" && depositHint && depositHint.status !== "polling" && depositHint.status !== "gone" && (
        <TradeStepperBox
          kind="deposit"
          trades={depositHint.trades}
          tradeCount={depositHint.tradeCount}
          status={depositHint.status}
          endReason={depositHint.endReason ?? null}
          communism={mode === "communism"}
        />
      )}
    </form>
  );
}

function WithdrawTray({
  slots,
  maxTray,
  onRemove,
}: {
  slots: (PoolInstance | null)[];
  maxTray: number;
  onRemove: (index: number) => void;
}) {
  const padded = Array.from({ length: maxTray }, (_, i) => slots[i] ?? null);
  return (
    <div className="tray">
      {padded.map((inst, idx) => {
        if (!inst) {
          return (
            <div key={idx} className="tray-slot empty" aria-label="empty slot">
              <span className="tray-empty-mark">+</span>
            </div>
          );
        }
        return (
          <button
            key={idx}
            type="button"
            className={"tray-slot filled rarity-" + inst.rarity}
            onClick={() => onRemove(idx)}
            title={
              inst.enchantments.length === 0
                ? `Remove ${inst.itemName}`
                : `Remove ${inst.itemName} (${inst.enchantments
                    .map((e) => e.name ?? `#${e.id}`)
                    .join(", ")})`
            }
          >
            <ItemSprite
              name={inst.itemName}
              size={48}
              className=""
              fallbackClassName="sprite sprite-fallback"
            />
            <span className="tray-x" aria-hidden="true">
              ×
            </span>
          </button>
        );
      })}
    </div>
  );
}
