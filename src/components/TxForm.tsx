
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveUpdates } from "@/lib/useLive";
import { SERVERS, WITHDRAW_SERVERS, isDepositOnly } from "@/lib/servers";
import { serverOffLabel, useServerControls } from "@/lib/useServerControls";
import { DEPOSIT_SIZES, type DepositSize } from "@/lib/depositSizes";
import { POTION_STATS, STAT_LABELS, type PotionStat } from "@/lib/potionPlan";
import type { PoolInstance, Tab, VaultHalfView } from "./Vault";
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
};

type GroupHint = {
  groupId: string;
  tradeCount: number;
  trades: { requestId: number; status: string; botIgn: string | null }[];
  status: "polling" | "in-flight" | "fulfilled" | "partial" | "cancelled" | "timeout";
  // Deposits only: why the chain stopped, when it stopped for a reason other
  // than the player under-filling a trade. 'vault-full' = the pool ran out
  // of room, so there was nothing left to chain to.
  endReason?: string | null;
};

// Status for an open group. The live stream announces every change to it
// (see useLiveUpdates.onRequest), so the poll here is only a slow safety net
// for a dropped stream — not the mechanism. A 3-trade worst case is ~180s;
// we give up at 240s.
function pollGroup(
  url: string,
  groupId: string,
  setter: React.Dispatch<React.SetStateAction<GroupHint | null>>,
  wake: { current: (() => void) | null },
): () => void {
  let cancelled = false;
  const start = Date.now();
  const POLL_MS = 15_000;
  const TIMEOUT_MS = 240_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (cancelled) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      const r = await fetch(url, { cache: "no-store" });
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
    if (Date.now() - start > TIMEOUT_MS) {
      if (!cancelled) setter((cur) => (cur ? { ...cur, status: "timeout" } : cur));
      return;
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
  vault,
  onVaultChanged,
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
  // "pool": deposit / withdraw / potions / claim against the commons.
  // "vault": deposit into, withdraw from, or donate out of personal storage.
  mode: "pool" | "vault";
  // Active pool tab — deposits are routed to a bot of this type. In vault
  // mode it is the half of the vault being looked at.
  seasonal: boolean;
  /** The account's vault for `seasonal`'s pool half. */
  vault: VaultHalfView | null;
  /** A claim, donate or vault trade changed what the account holds. */
  onVaultChanged?: () => void;
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
  const [depositSlots, setDepositSlots] = useState<DepositSize>(8);
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
    setCapacity(null);
    if (mode !== "pool") return;
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

  // If the bigger trade stops being possible (the backpack bot went to
  // someone else), fall back to the one that is.
  useEffect(() => {
    if (depositSlots === 16 && mode === "pool" && capacity !== null && !capacity.full && capacity.largestFree !== undefined && capacity.largestFree < 16 && capacity.largestFree >= 8 && !capacity.canMake16) setDepositSlots(8);
  }, [capacity, depositSlots, mode]);

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
    if (tab !== "withdraw" && tab !== "claim" && tab !== "donate") return;
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

  // Claim (pool -> vault) and donate (vault -> pool) are instant: ownership
  // changes in the ledger, nothing moves in game, so no server, no bot, no
  // polling — just the tray.
  async function submitInstant(kind: "claim" | "donate") {
    if (trayFilled.length === 0) {
      setMsg({ kind: "err", text: kind === "claim" ? "Click items in the pool to add them." : "Click items in your vault to add them." });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/vault/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceIds: trayFilled.map((t) => t.instanceId) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ kind: "err", text: data.error || "Request failed" });
        return;
      }
      const n = Number(kind === "claim" ? data.claimed : data.donated);
      setMsg({
        kind: "ok",
        text:
          kind === "claim"
            ? `Claimed ${n} item${n === 1 ? "" : "s"} into your ${data.seasonal ? "seasonal" : "non-seasonal"} vault (${data.used}/${data.slots} slots used). The fleet will gather them onto your bot; withdraw them from the My vault tab whenever you like.`
            : `Donated ${n} item${n === 1 ? "" : "s"} to the pool (${data.used}/${data.slots} ${data.seasonal ? "seasonal" : "non-seasonal"} slots used). Thank you, comrade.`,
      });
      onClearTray();
      onComplete();
      onVaultChanged?.();
    } catch {
      setMsg({ kind: "err", text: "Network error" });
    } finally {
      setSubmitting(false);
    }
  }

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
    if (tab === "claim" || tab === "donate") {
      await submitInstant(tab);
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
      // `vault: true` sends the trade to personal storage instead of the pool:
      // the account's own bot meets the player, and nothing hits the ledger.
      const vaultFlag = mode === "vault" ? { vault: true } : {};
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
        const vaultRoom = Math.max(0, (vault?.slots ?? 8) - (vault?.used ?? 0));
        setMsg({
          kind: "ok",
          text:
            mode === "vault"
              ? `Vault deposit queued for ${ign} on ${server}. Your own bot will meet you for one trade of up to ${Math.min(depositSlots, vaultRoom)} items — they stay yours.`
              : willMake16
                ? `Deposit queued for ${ign} on ${server}. No bot has 16 free slots right now, so one is being fitted with a backpack for you — allow a few minutes, then it meets you for one trade.`
                : `Deposit queued for ${ign} on ${server}. A bot with ${depositSlots} free slots will meet you for one trade — whatever you hand over is deposited.`,
        });
        if (mode === "vault") onVaultChanged?.();
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
        setMsg({
          kind: "ok",
          text: `${mode === "vault" ? "Vault withdraw" : "Withdraw"} queued: ${trayFilled.length} item${trayFilled.length === 1 ? "" : "s"} → ${ign} on ${server}${fragNote}.`,
        });
        setWithdrawHint({
          groupId: String(data.groupId),
          tradeCount,
          trades: [],
          status: "polling",
        });
        onClearTray();
        onComplete();
        if (mode === "vault") onVaultChanged?.();
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
  const sizeAvailable = (n: number) => capacity === null || (!capacity.full && (capacity.largestFree === undefined || capacity.largestFree >= n || (n > 8 && !!capacity.canMake16)));
  const willMake16 = mode === "pool" && depositSlots === 16 && capacity !== null && capacity.largestFree !== undefined && capacity.largestFree < 16 && !!capacity.canMake16;
  const depositBlockedByCapacity =
    mode === "pool" && tab === "deposit" && capacity !== null && !sizeAvailable(depositSlots);
  // Vault deposits stop at the slots this half holds.
  const vaultSlotsLeft = vault ? Math.max(0, vault.slots - vault.used) : null;
  const vaultUnallocated = vault !== null && vault.slots === 0;
  const vaultDepositBlocked = mode === "vault" && tab === "deposit" && vaultSlotsLeft === 0;
  const claimBlocked = mode === "pool" && tab === "claim" && vaultUnallocated;
  const instantTab = tab === "claim" || tab === "donate";

  const submitDisabled =
    submitting ||
    !ign ||
    (!instantTab && !server) ||
    (instantTab && trayFilled.length === 0) ||
    (tab === "withdraw" && (trayFilled.length === 0 || trayMultiServer || !!trayServerMismatch)) ||
    claimBlocked ||
    (tab === "potions" && !(Number(potionPoints) >= 1)) ||
    depositBlockedByCapacity ||
    vaultDepositBlocked;

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
        {mode === "pool" ? (
          <>
            <button
              type="button"
              className={tab === "potions" ? "active" : ""}
              onClick={() => setTab("potions")}
            >
              Potions
            </button>
            <button
              type="button"
              className={tab === "claim" ? "active" : ""}
              onClick={() => setTab("claim")}
            >
              Claim
            </button>
          </>
        ) : (
          <button
            type="button"
            className={tab === "donate" ? "active" : ""}
            onClick={() => setTab("donate")}
          >
            Donate
          </button>
        )}
      </div>

      {!ign && (
        <p className="hint">Log in above to deposit or withdraw.</p>
      )}

      {mode === "vault" && ign && (
        <p className="hint">
          {seasonal ? "Seasonal" : "Non-seasonal"} vault: {vault ? `${vault.used} of ${vault.slots} slots used` : "…"}
          {vault?.bot?.ign ? ` · your bot is ${vault.bot.ign}` : ""}
        </p>
      )}

      {instantTab && (
        <>
          <label>{tab === "claim" ? "Claim Tray" : "Donate Tray"} ({trayFilled.length}/{maxTray})</label>
          <WithdrawTray
            slots={trayInstances}
            maxTray={maxTray}
            onRemove={onRemoveFromTray}
          />
          <p className="hint">
            {tab === "claim"
              ? vaultUnallocated
                ? `You have no vault slots allocated to the ${seasonal ? "seasonal" : "non-seasonal"} pool. Open My Vault and give its ${seasonal ? "Seasonal" : "Non-seasonal"} tab some slots first.`
                : `Click items in the pool to add them. Claiming moves them into your ${seasonal ? "seasonal" : "non-seasonal"} vault instantly${vault ? ` (${Math.max(0, vault.slots - vault.used)} slot${vault.slots - vault.used === 1 ? "" : "s"} free)` : ""}.`
              : "Click items in your vault to add them. Donating gives them back to the pool instantly."}
          </p>
        </>
      )}

      {!instantTab && <label htmlFor="server">Server</label>}
      {!instantTab && <select
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
      </select>}

      {tab === "deposit" && (
        <>
          <label>Trade size</label>
          <div className="deposit-size" role="group" aria-label="Trade size">
            {DEPOSIT_SIZES.map((n) => {
              const noBot = mode === "pool" && capacity !== null && !sizeAvailable(n);
              // A vault trade is as big as the room left, so the bigger size
              // only means something with more than 8 slots free.
              const noRoom = mode === "vault" && vaultSlotsLeft !== null && n > 8 && vaultSlotsLeft <= 8;
              const off = noBot || noRoom;
              return (
                <button
                  key={n}
                  type="button"
                  className={"login-char-btn" + (depositSlots === n ? " wish-pool-active" : "")}
                  aria-pressed={depositSlots === n}
                  disabled={off}
                  title={n === 8 ? "An empty bot: 8 free slots" : "An empty bot with a backpack: 16 free slots"}
                  onClick={() => setDepositSlots(n)}
                >
                  {n} slots
                </button>
              );
            })}
            <span className="pool-option-hint">
              {depositSlots === 8 ? "an empty bot" : "an empty bot with a backpack"}
              {mode === "pool" && capacity?.largestFree !== undefined && capacity.largestFree < 16 && capacity.largestFree >= 8 && (capacity.canMake16 ? " · none ready — one will be fitted with a backpack for you, allow a few minutes" : " · no bot has 16 free right now")}
              {mode === "vault" && vaultSlotsLeft !== null && vaultSlotsLeft > 0 && vaultSlotsLeft < depositSlots && ` · capped at the ${vaultSlotsLeft} slot${vaultSlotsLeft === 1 ? "" : "s"} your vault has left`}
            </span>
          </div>
        </>
      )}
      {tab === "deposit" && mode === "pool" && (
        <p className="hint">
          Submit and a bot with {depositSlots} free slots meets {ign || "you"} on the chosen server. It&rsquo;s one trade: whatever you put in the window is deposited. For more, open another request afterwards.
        </p>
      )}
      {tab === "deposit" && mode === "vault" && (
        <p className="hint">
          {vaultUnallocated
            ? `Your ${seasonal ? "seasonal" : "non-seasonal"} vault has no slots yet. Give it some with the buttons above.`
            : vaultSlotsLeft === 0
              ? `Your ${seasonal ? "seasonal" : "non-seasonal"} vault is full. Withdraw or donate something to make room.`
              : `Submit and your own ${seasonal ? "seasonal" : "non-seasonal"} bot meets ${ign || "you"} on the chosen server for one trade. Trade in what you want to keep — it stays yours, off the ledger, and only you can see or withdraw it.`}
        </p>
      )}
      {tab === "withdraw" && mode === "vault" && (
        <p className="hint">
          Click items in your vault to add them; your bot brings them to the chosen server.
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
            max={250}
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
          {capacity.largestFree !== undefined && capacity.totalSlots > 0 && ` · biggest trade ${Math.min(16, capacity.largestFree)}`}
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
            : tab === "claim"
              ? `Claim ${trayFilled.length} Item${trayFilled.length === 1 ? "" : "s"}`
              : tab === "donate"
                ? `Donate ${trayFilled.length} Item${trayFilled.length === 1 ? "" : "s"}`
                : tab === "deposit"
                  ? depositBlockedByCapacity
                    ? "Vault is full"
                    : vaultDepositBlocked
                      ? vaultUnallocated ? "No slots in this vault" : "Your vault is full"
                      : mode === "vault"
                        ? "Deposit Into My Vault"
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
      {(tab === "withdraw" || tab === "potions") && withdrawHint && withdrawHint.status !== "polling" && withdrawHint.status !== "timeout" && (
        <TradeStepperBox
          kind="withdraw"
          trades={withdrawHint.trades}
          tradeCount={withdrawHint.tradeCount}
          status={withdrawHint.status}
        />
      )}
      {tab === "deposit" && depositHint && depositHint.status !== "polling" && depositHint.status !== "timeout" && (
        <TradeStepperBox
          kind="deposit"
          trades={depositHint.trades}
          tradeCount={depositHint.tradeCount}
          status={depositHint.status}
          endReason={depositHint.endReason ?? null}
          personal={mode === "vault"}
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
