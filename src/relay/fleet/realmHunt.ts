// The realm hunter: a bot that holds a hunt's party open and counts who
// follows it into called dungeons (docs/REALMHUNTS.md §3). The site orders
// one per hunt through the hook in lib/realmhunts.ts. The trip: pick an
// idle account, hold it out of trading, log in on the hunt's server, stay
// in the Nexus, open the in-game party named after the hunt (size = the
// dungeon's player limit, public, activity "realm") and read party chat.
// The hunters themselves roam realms for the dungeon; when one of them has
// found it and is inside, they say "j" in party chat. The bot answers with
// the party's teleport action on that member (PARTYACTION TeleportTo), the
// server hands it a RECONNECT into the dungeon instance, and from the
// moment the dungeon's map arrives it counts every player it sees for
// JOIN_COUNT_WINDOW_S, says the count in party chat, reports it to the
// site, nexuses and waits for the next call. It waits CALL_IDLE_MS for a
// call; every call that lands it in the hunted dungeon restarts that
// clock, and when it runs out it leaves the party and the hunt ends. It
// never walks, never fights, never uses an item, never trades.
//
// The party join, the teleport-to-member action and the reconnect it
// answers with were read off the wire with rotmgproxy on 2026-09-14
// (docs/REALMHUNTS.md §5).
import type { GameClient } from "../client/gameClient";
import type { AnyPacket, PartyPlayer } from "../protocol/packets";
import { getServers } from "../realm/api";
import type { BotAccount, BotPool } from "./botPool";
import { bringUp, BringUpRefused, takeDown, type FleetDeps } from "./bringUp";
import { BazaarObserver, NEXUS_MAP } from "./raidWatch";
import { bareName, CALL_IDLE_MS, isJoinCall, JOIN_COUNT_WINDOW_S, PARTY_REFRESH_MS, type CallOutcome, type HunterReport, type HunterState, type HuntOrder, type HuntSite, type RealmHuntHook } from "../../lib/realmhuntRules";

/** PartyActionType (the client's enum). */
export const PartyAction = { Kick: 1, Disconnect: 2, PromoteToLeader: 3, Refresh: 4, GetPartyList: 5, LeaveParty: 6, TeleportTo: 7 } as const;
/** PartyResponse (the client's enum). */
export const PartyResponse = { Pending: 1, Cancelled: 2, Accepted: 3, Declined: 4, PartyFull: 5, Blacklisted: 6 } as const;
export const PartyActivity = { None: 0, Dungeons: 1, Realm: 2, Other: 3 } as const;
export const PartyPrivacy = { None: 0, Public: 1, Private: 2 } as const;
/** The player id a party action carries when it is about nobody (the list request sends it). */
export const NO_PLAYER = 0xffff;
/** PARTYMEMBERINFO's party id when the account is in no party (live 2026-09-14). */
export const NO_PARTY = 0xffffffff;
export const PARTY_CHAT = "*Party*";
/** The game's chat line limit; a longer PLAYERTEXT is not something a real client ever sends. */
export const CHAT_MAX = 128;

/** Split a message into chat-sized lines at word boundaries (a "/p " prefix is added per line by the caller). */
export function chatLines(text: string, max = CHAT_MAX - 3): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** Trips per hunt before the hunter gives up; the counter resets whenever a trip reaches "hunting" again. */
export const MAX_RETRIES = 6;

export const TIMEOUTS = {
  /** Login, queue included. */
  inWorldMs: 180_000,
  partyCreateMs: 6_000,
  partyAttempts: 2,
  /** From the teleport action to the dungeon's MAPINFO (a RECONNECT in between). */
  teleportMs: 12_000,
  dungeonInWorldMs: 30_000,
  countMs: JOIN_COUNT_WINDOW_S * 1000,
  /** Two calls are at least this far apart (a second "j" while one is being served is ignored). */
  callGapMs: 2_000,
  partyRefreshMs: PARTY_REFRESH_MS,
  /** After a map loads, the real client asks for its party about this much later; asked at once, the server answered "no party" for a member it still had (prod 2026-09-14). */
  refreshDelayMs: 1_500,
  /** A "no party" answer inside this window after a connection is not believed on its own. */
  partySettleMs: 10_000,
  /** No call into the hunted dungeon for this long: leave the party, end the hunt. */
  idleMs: CALL_IDLE_MS,
  retryDelayMs: 5_000,
  tickMs: 1_000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Pure pieces

/** Everyone the roster has seen since its last reset (present or gone), by bare name; the bot excluded. */
export function seenNames(obs: BazaarObserver, selfId: number): string[] {
  const out: string[] = [];
  for (const p of obs.players.values()) if (p.name && p.objectId !== selfId) out.push(bareName(p.name));
  return out;
}

/** The count a call reports: everyone seen in the dungeon, and how many of them are party members. */
export function countEntered(names: string[], members: Iterable<string>): { entered: number; partyEntered: number } {
  const party = new Set([...members].map((m) => bareName(m).toLowerCase()));
  const seen = new Set(names.map((n) => bareName(n).toLowerCase()));
  let partyEntered = 0;
  for (const n of seen) if (party.has(n)) partyEntered++;
  return { entered: seen.size, partyEntered };
}

/** CREATEPARTY's serverIndex: the server's position in the account/servers list (the client's dropdown order). */
export function serverIndexOf(list: { name: string }[], server: string): number {
  const i = list.findIndex((s) => s.name === server);
  return i < 0 ? 0 : i;
}

/** A party-chat line from someone else, the sender's name bare. */
export function partyLine(pkt: AnyPacket, self: string): { name: string; text: string } | null {
  if (pkt.type !== "TEXT" || pkt.recipient !== PARTY_CHAT || !pkt.name) return null;
  const name = bareName(pkt.name);
  if (!name || (self && name.toLowerCase() === bareName(self).toLowerCase())) return null;
  return { name, text: pkt.text };
}

/** The party as the bot sees it. */
export class PartyState {
  /** 0 when in none. */
  partyId = 0;
  maxSize = 0;
  /** Members by party player id (what the teleport action takes). */
  readonly members = new Map<number, PartyPlayer>();
  /** Bumps whenever the members or the party id change. */
  version = 0;
  get inParty(): boolean {
    return this.partyId !== 0;
  }
  apply(pkt: AnyPacket): void {
    switch (pkt.type) {
      case "PARTYMEMBERINFO":
        this.partyId = pkt.partyId === NO_PARTY ? 0 : pkt.partyId;
        this.maxSize = pkt.maxSize;
        this.members.clear();
        for (const p of pkt.players) this.members.set(p.playerId, p);
        this.version++;
        break;
      case "PARTYMEMBERADDED":
        this.members.set(pkt.playerId, { playerId: pkt.playerId, name: pkt.name, classId: pkt.classId, skinId: pkt.skinId });
        this.version++;
        break;
      case "PARTYACTIONRESULT":
        // Someone left or was kicked (their id).
        if (pkt.result === 6 || pkt.result === 2) {
          if (this.members.delete(pkt.playerId)) this.version++;
        }
        break;
    }
  }
  /** Bare names. */
  memberNames(): string[] {
    return [...this.members.values()].map((m) => bareName(m.name)).filter(Boolean);
  }
  /** The member's party player id, or null when no member has that (bare) name. */
  playerIdOf(name: string): number | null {
    const lower = bareName(name).toLowerCase();
    for (const m of this.members.values()) if (bareName(m.name).toLowerCase() === lower) return m.playerId;
    return null;
  }
}

// ---------------------------------------------------------------------------
// The service: one hunter per hunt

/** What a trip drives: the hunt it serves, and how to report. */
export interface TripContext {
  huntId: number;
  server: string;
  order: () => HuntOrder;
  /** The account the previous attempt used (a retry prefers it: its party may still be open). */
  lastGuid(): string | null;
  tookAccount(guid: string): void;
  /** The trip reached its steady state: earlier failures no longer count against it. */
  settled(): void;
  stopped(): boolean;
  report(state: HunterState, note: string): void;
  setBot(alias: string | null): void;
  setParty(partyId: number): void;
  members(names: string[]): void;
  callStarted(caller: string): number;
  /** `names`: everyone seen in the dungeon, null when the bot never got in. */
  callDone(callId: number, outcome: CallOutcome, names: string[] | null, note: string): void;
}
export type TripRunner = (ctx: TripContext) => Promise<void>;

class Hunter {
  state: HunterState = "ordered";
  note = "";
  bot: string | null = null;
  partyId = 0;
  members: string[] = [];
  calls = 0;
  running = false;
  stopRequested = false;
  retries = 0;
  /** The account of the last attempt: a retry takes it again when it is free, so the party it opened is still its own. */
  lastGuid: string | null = null;
  constructor(public order: HuntOrder, public since: number) {}
}

export interface RealmHuntOptions {
  deps: FleetDeps;
  pool: BotPool;
  /** The dispatcher's maintenance holds: a hunting bot is neither traded with nor evicted for idling. */
  holds: Set<string>;
  vaultBots?: () => Set<string>;
  /** Which accounts may hunt at all (live: empty ones without a backpack — a hunter can die). Default: any. */
  eligible?: (acc: BotAccount) => boolean;
  log: (line: string) => void;
  now?: () => number;
  /** Test hook: replaces the real trip. */
  trip?: TripRunner;
  timeouts?: Partial<typeof TIMEOUTS>;
}

export class RealmHuntService implements RealmHuntHook {
  private readonly hunters = new Map<number, Hunter>();
  private site: HuntSite | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly T: typeof TIMEOUTS;
  constructor(private readonly o: RealmHuntOptions) {
    this.now = o.now ?? (() => Date.now());
    this.T = { ...TIMEOUTS, ...o.timeouts };
  }

  attachSite(site: HuntSite | null): void {
    this.site = site;
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.T.tickMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const h of this.hunters.values()) h.stopRequested = true;
  }

  // --- the hook ---------------------------------------------------------------

  order(o: HuntOrder): void {
    let h = this.hunters.get(o.huntId);
    if (!h) {
      h = new Hunter(o, this.now());
      this.hunters.set(o.huntId, h);
      this.o.log(`realmhunt: #${o.huntId}: ${o.dungeon} in ${o.region} on ${o.server}, party "${o.partyName}" (${o.maxPartySize}); until +${Math.round((o.until - this.now()) / 1000)}s`);
    } else h.order = o;
    h.stopRequested = false;
    if (!h.running) this.launch(h);
  }

  release(huntId: number): void {
    const h = this.hunters.get(huntId);
    if (!h) return;
    this.o.log(`realmhunt: #${huntId}: released`);
    h.stopRequested = true;
    if (!h.running) this.hunters.delete(huntId);
  }

  list(): HunterReport[] {
    return [...this.hunters.values()].map((h) => ({
      huntId: h.order.huntId, server: h.order.server, state: h.state, note: h.note, bot: h.bot, since: h.since, partyId: h.partyId,
      members: h.members.slice(), calls: h.calls, until: h.order.until,
    }));
  }

  // --- lifecycle ---------------------------------------------------------------

  private tick(): void {
    const now = this.now();
    for (const [id, h] of [...this.hunters]) {
      if (h.order.until > now || h.stopRequested) continue;
      this.o.log(`realmhunt: #${id}: lapsed`);
      h.stopRequested = true;
      if (!h.running) this.hunters.delete(id);
    }
  }

  private context(h: Hunter): TripContext {
    const id = h.order.huntId;
    const update = () => this.site?.hunterUpdate({ huntId: id, state: h.state, note: h.note, bot: h.bot, server: h.order.server, partyId: h.partyId });
    return {
      huntId: id, server: h.order.server, order: () => h.order,
      lastGuid: () => h.lastGuid,
      tookAccount: (guid) => {
        h.lastGuid = guid;
      },
      settled: () => {
        h.retries = 0;
      },
      stopped: () => h.stopRequested,
      report: (state, note) => {
        h.state = state;
        h.note = note;
        this.o.log(`realmhunt: #${id}: ${state}${note ? ` — ${note}` : ""}`);
        update();
      },
      setBot: (alias) => {
        h.bot = alias;
      },
      setParty: (partyId) => {
        if (h.partyId === partyId) return;
        h.partyId = partyId;
        update();
      },
      members: (names) => {
        h.members = names;
        this.site?.membersSeen({ huntId: id, members: names });
      },
      callStarted: (caller) => {
        h.calls++;
        this.o.log(`realmhunt: #${id}: ${caller} called`);
        return this.site?.callStarted({ huntId: id, caller, at: this.now() }) ?? 0;
      },
      callDone: (callId, outcome, names, note) => {
        this.o.log(`realmhunt: #${id}: call ${outcome}${names === null ? "" : `: ${names.length} entered (${names.join(", ") || "nobody"})`}${note ? ` — ${note}` : ""}`);
        this.site?.callDone({ huntId: id, callId, outcome, names, partyMembers: h.members.slice(), note, at: this.now() });
      },
    };
  }

  private launch(h: Hunter): void {
    h.running = true;
    h.stopRequested = false;
    const ctx = this.context(h);
    void (async () => {
      try {
        await (this.o.trip ?? this.trip)(ctx);
        if (h.state !== "done") ctx.report("left", h.stopRequested ? "the hunt ended" : "the trip ended");
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        // Still wanted and there is time: go again (a hunter dying in a dungeon is expected — the next bring-up makes a new
        // character and the account is still in the party), before the site is told the hunter failed (which ends the hunt).
        if (!h.stopRequested && h.retries < MAX_RETRIES && h.order.until > this.now() + 60_000) {
          h.retries++;
          this.o.log(`realmhunt: #${h.order.huntId}: ${why}; retrying in ${this.T.retryDelayMs / 1000}s`);
          ctx.report("ordered", `retrying after: ${why}`);
          await sleep(this.T.retryDelayMs);
          if (!h.stopRequested) {
            h.running = false;
            this.launch(h);
            return;
          }
        }
        ctx.report("failed", why);
      } finally {
        if (h.running) {
          h.running = false;
          if (h.stopRequested) this.hunters.delete(h.order.huntId);
        }
      }
    })();
  }

  // --- the trip ------------------------------------------------------------------

  private pickAccount(server: string, prefer: string | null): BotAccount | null {
    const vault = this.o.vaultBots?.() ?? new Set<string>();
    const gate = this.o.deps.gate;
    const free = this.o.pool.all().filter((a) =>
      !a.online && !a.inUse && a.assignedRequestId === null && !a.suspended && !this.o.holds.has(a.guid) && !vault.has(a.botGuid) && gate.lockoutRemainingMs(a.guid) <= 0 && (this.o.eligible?.(a) ?? true),
    );
    free.sort((a, b) => Number(b.guid === prefer) - Number(a.guid === prefer) || Number(b.info.server === server) - Number(a.info.server === server) || (a.guid < b.guid ? -1 : 1));
    return free[0] ?? null;
  }

  private readonly trip: TripRunner = async (ctx) => {
    const { deps, holds } = this.o;
    const T = this.T;
    if (deps.gate.pausedRemainingMs() > 0) throw new Error("logins are paused");
    const acc = this.pickAccount(ctx.server, ctx.lastGuid());
    if (!acc) throw new Error("no free account to send (a hunter must be idle, empty and without a backpack: it may die)");
    ctx.tookAccount(acc.guid);
    holds.add(acc.guid);
    ctx.setBot(acc.alias);
    let client: GameClient | null = null;
    let onPacket: ((p: AnyPacket) => void) | null = null;
    let onQueue: ((pos: number, max: number) => void) | null = null;
    try {
      ctx.report("logging_in", `${acc.alias} on ${ctx.server}`);
      try {
        client = await (deps.bringUp ?? bringUp)(deps, acc, ctx.server);
      } catch (e) {
        throw new Error(e instanceof BringUpRefused ? `bring-up ${e.verdict}: ${e.message}` : String(e));
      }
      const c = client;
      onQueue = (pos, max) => ctx.report("queued", `${acc.alias}: position ${pos} of ${max} on ${ctx.server}`);
      c.on("queue", onQueue);
      await waitFor(c, () => inWorld(c, NEXUS_MAP), T.inWorldMs, "the Nexus", ctx);
      c.off("queue", onQueue);
      onQueue = null;

      // What the bot reads off its stream: players in view (the roster, reset on every map), the party, and party chat.
      const obs = new BazaarObserver({ selfId: () => c.objectId, isPortal: () => false });
      const party = new PartyState();
      const chat: { name: string; text: string }[] = [];
      let connectedAt = Date.now();
      onPacket = (pkt) => {
        obs.apply(pkt);
        party.apply(pkt);
        if (pkt.type === "MAPINFO") connectedAt = Date.now();
        if (pkt.type === "PARTYMEMBERINFO") this.o.log(`realmhunt: #${ctx.huntId}: party info ${pkt.partyId === NO_PARTY ? "none" : `#${pkt.partyId}`} (${pkt.players.length} in: ${pkt.players.map((m) => m.name).join(", ") || "-"}) ${Math.round((Date.now() - connectedAt) / 100) / 10}s after the map`);
        if (pkt.type === "PARTYMEMBERADDED") this.o.log(`realmhunt: #${ctx.huntId}: party member added ${pkt.name} (player ${pkt.playerId})`);
        if (pkt.type === "PARTYACTIONRESULT") this.o.log(`realmhunt: #${ctx.huntId}: party action result ${pkt.result} for player ${pkt.playerId}`);
        const line = partyLine(pkt, c.playerData.name);
        if (line) chat.push(line);
        // A join request reaching the leader (a public party adds members without one, live 2026-09-14): logged, not answered, until the reply's layout is seen on the wire.
        if (pkt.type === "PARTYJOINREQUESTRESPONSE") this.o.log(`realmhunt: #${ctx.huntId}: join request from ${pkt.name} (class ${pkt.classId}, state ${pkt.state}); not answered`);
        if (pkt.type === "PARTYJOINREQUEST") this.o.log(`realmhunt: #${ctx.huntId}: PARTYJOINREQUEST party ${pkt.partyId} state ${pkt.state}`);
        if (pkt.type === "FAILURE") this.o.log(`realmhunt: #${ctx.huntId}: FAILURE ${pkt.errorId} ${JSON.stringify(pkt.errorDescription)}`);
      };
      c.on("packet", onPacket);
      const say = (text: string) => {
        for (const line of chatLines(text)) c.send("PLAYERTEXT", { text: `/p ${line}` });
        this.o.log(`realmhunt: #${ctx.huntId}: said in party: ${text}`);
      };

      // The party. The real client asks for it (PARTYACTION refresh) right after every MAPINFO, and the server
      // dropped a hunter that did not (live 2026-09-14: "left" ~40 s after it nexused back), so every arrival in a
      // world refreshes at once; the answer is also how the bot learns its party after a reconnect.
      const o = ctx.order();
      const serverIndex = await this.serverIndex(c, ctx.server);
      let lastRefreshAt = 0;
      /** Ask the server for the party, the client's delay after a fresh map first. */
      const refreshParty = async (waitMs = 3000) => {
        const since = Date.now() - connectedAt;
        if (since < T.refreshDelayMs) await sleep(T.refreshDelayMs - since);
        lastRefreshAt = Date.now();
        const info = nextPacket(c, "PARTYMEMBERINFO", waitMs);
        c.send("PARTYACTION", { playerId: NO_PLAYER, actionId: PartyAction.Refresh });
        const have = await info;
        if (have) party.apply(have);
        return have !== null;
      };
      /** A "no party" reading is believed only once the connection has settled and a second answer agrees. */
      const reallyNoParty = async (): Promise<boolean> => {
        for (let i = 0; i < 3; i++) {
          if (party.inParty) return false;
          const wait = Math.max(5000, T.partySettleMs - (Date.now() - connectedAt));
          this.o.log(`realmhunt: #${ctx.huntId}: the server says no party; asking again in ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          if (ctx.stopped() || !c.connected) return false;
          await refreshParty(4000);
          if (party.inParty) return false;
          if (Date.now() - connectedAt >= T.partySettleMs) return true;
        }
        return !party.inParty;
      };
      await refreshParty();
      if (!party.inParty) await createParty(c, party, { description: o.partyName, maxPartySize: o.maxPartySize, serverIndex }, T, ctx);
      ctx.setParty(party.partyId);
      ctx.members(party.memberNames());
      const hunting = () => {
        ctx.settled();
        ctx.report("hunting", `${acc.alias} in the Nexus on ${ctx.server}, party "${o.partyName}" open (${party.members.size} in)`);
      };
      hunting();

      let lastCallAt = 0;
      // The idle clock: restarted by every call that lands the bot in the hunted dungeon.
      let lastCountedAt = Date.now();
      let membersVersion = party.version;
      const greeted = new Set<string>([bareName(c.playerData.name).toLowerCase()]);
      while (!ctx.stopped() && c.active && c.connected) {
        if (Date.now() - lastCountedAt >= T.idleMs) {
          if (party.inParty) {
            say(`no ${o.dungeon} call for ${T.idleMs / 60_000} minutes; I'm leaving the party. Request a new hunt on the site when you're hunting again.`);
            c.send("PARTYACTION", { playerId: NO_PLAYER, actionId: PartyAction.LeaveParty });
            await sleep(500);
          }
          ctx.report("done", `no call into a ${o.dungeon} for ${T.idleMs / 60_000} minutes; ${acc.alias} left "${o.partyName}"`);
          return;
        }
        // The party as the server has it, once a minute (the member list the site shows, and the ids a teleport needs).
        if (Date.now() - lastRefreshAt >= T.partyRefreshMs) {
          lastRefreshAt = Date.now();
          c.send("PARTYACTION", { playerId: NO_PLAYER, actionId: PartyAction.Refresh });
        }
        // Party changes: greet newcomers with what to do.
        if (party.version !== membersVersion) {
          membersVersion = party.version;
          ctx.members(party.memberNames());
          ctx.setParty(party.partyId);
          for (const name of party.memberNames()) {
            const lower = name.toLowerCase();
            if (greeted.has(lower)) continue;
            greeted.add(lower);
            say(`welcome ${name}. Hunt any realm for a ${o.dungeon}. Once inside it, say j here: I teleport to you and count who joins in ${T.countMs / 1000}s.`);
          }
          if (!party.inParty && (await reallyNoParty())) {
            this.o.log(`realmhunt: #${ctx.huntId}: no party any more; creating it again`);
            await createParty(c, party, { description: o.partyName, maxPartySize: o.maxPartySize, serverIndex }, T, ctx);
            ctx.setParty(party.partyId);
          }
        }
        // A call.
        const line = chat.shift();
        if (line) {
          if (!isJoinCall(line.text)) continue;
          const now = Date.now();
          if (now - lastCallAt < T.callGapMs) continue;
          lastCallAt = now;
          chat.length = 0;
          const callId = ctx.callStarted(line.name);
          const result = await serveCall(c, { obs, party, say, membersBefore: party.memberNames() }, line.name, o, T, ctx);
          ctx.members(party.memberNames());
          ctx.callDone(callId, result.outcome, result.names, result.note);
          if (result.outcome === "counted") lastCountedAt = Date.now();
          if (c.mapName !== NEXUS_MAP && c.connected) {
            ctx.report("returning", `${acc.alias} nexusing from "${c.mapName}"`);
            c.nexus();
            await waitFor(c, () => inWorld(c, NEXUS_MAP), T.inWorldMs, "the Nexus", ctx);
          }
          // A new connection: refresh at once, as the real client does, or the server drops us from the party.
          await refreshParty();
          hunting();
          continue;
        }
        await sleep(200);
      }
      if (!ctx.stopped()) throw new Error(`${acc.alias} lost its connection in "${c.mapName}"`);
      // Leave the party so it does not linger under the bot's name.
      if (c.connected && party.inParty) {
        c.send("PARTYACTION", { playerId: NO_PLAYER, actionId: PartyAction.LeaveParty });
        await sleep(500);
      }
    } finally {
      if (client) {
        if (onPacket) client.off("packet", onPacket);
        if (onQueue) client.off("queue", onQueue);
      }
      takeDown(deps, acc, "realm hunt done");
      holds.delete(acc.guid);
    }
  };

  /** The server's index in account/servers (CREATEPARTY's serverIndex); 0 with a note when the list cannot be read. */
  private async serverIndex(c: GameClient, server: string): Promise<number> {
    const r = await getServers(c.token, c.proxy);
    if (!r.ok) {
      this.o.log(`realmhunt: account/servers failed (${r.error.kind}); party serverIndex 0`);
      return 0;
    }
    return serverIndexOf(r.value, server);
  }
}

// ---------------------------------------------------------------------------
// The trip's steps

const inWorld = (client: GameClient, map: string): boolean => client.connected && client.objectId !== -1 && !!client.playerData.name && client.mapName === map;

async function waitFor(client: GameClient, pred: () => boolean, ms: number, what: string, ctx: TripContext): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    if (ctx.stopped()) throw new Error("stopped");
    if (!client.active) throw new Error(`client went inactive waiting for ${what}`);
    await sleep(100);
  }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
}

function nextPacket<K extends AnyPacket["type"]>(client: GameClient, type: K, ms: number, pred: (p: Extract<AnyPacket, { type: K }>) => boolean = () => true): Promise<Extract<AnyPacket, { type: K }> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.off("packet", handler);
      resolve(null);
    }, ms);
    const handler = (p: AnyPacket) => {
      if (p.type !== type || !pred(p as Extract<AnyPacket, { type: K }>)) return;
      clearTimeout(timer);
      client.off("packet", handler);
      resolve(p as Extract<AnyPacket, { type: K }>);
    };
    client.on("packet", handler);
  });
}

/** Open the hunt's party. A CREATEPARTY the server does not answer usually means the account is in one already: it is asked before giving up. */
async function createParty(client: GameClient, party: PartyState, p: { description: string; maxPartySize: number; serverIndex: number }, T: typeof TIMEOUTS, ctx: TripContext): Promise<void> {
  for (let attempt = 1; attempt <= T.partyAttempts; attempt++) {
    const answer = nextPacket(client, "PARTYMEMBERINFO", T.partyCreateMs, (x) => x.partyId !== 0 && x.partyId !== NO_PARTY);
    client.send("CREATEPARTY", {
      description: p.description, minPowerLevel: 0, maxPartySize: Math.min(255, p.maxPartySize), activity: PartyActivity.Realm, maxedStatReq: 0, privacy: PartyPrivacy.Public, serverIndex: p.serverIndex,
    });
    const info = await answer;
    if (info) {
      party.apply(info);
      return;
    }
    if (ctx.stopped()) throw new Error("stopped");
    const asked = nextPacket(client, "PARTYMEMBERINFO", 3000);
    client.send("PARTYACTION", { playerId: NO_PLAYER, actionId: PartyAction.Refresh });
    const have = await asked;
    if (have) party.apply(have);
    if (party.inParty) return;
  }
  throw new Error(`CREATEPARTY "${p.description}" got no party back after ${T.partyAttempts} attempts`);
}

interface CallTools {
  obs: BazaarObserver;
  party: PartyState;
  say: (text: string) => void;
  /** The party as known before the teleport: a fresh connection's first reading may be empty for a moment. */
  membersBefore: string[];
}

/** Answer one call: teleport to the caller through the party, count the window. */
async function serveCall(client: GameClient, t: CallTools, caller: string, o: HuntOrder, T: typeof TIMEOUTS, ctx: TripContext): Promise<{ outcome: CallOutcome; names: string[] | null; note: string }> {
  const playerId = t.party.playerIdOf(caller);
  if (playerId === null) {
    t.say(`${caller}: I don't see you in the party; join it and say j again.`);
    return { outcome: "unreachable", names: null, note: `${caller} is not in the party as the bot knows it` };
  }
  ctx.report("joining", `teleporting to ${caller} (party player ${playerId})`);
  // The server answers with a RECONNECT into the caller's instance; the client follows it and the dungeon's MAPINFO arrives.
  const arrived = nextPacket(client, "MAPINFO", T.teleportMs, (p) => p.name !== NEXUS_MAP);
  client.send("PARTYACTION", { playerId, actionId: PartyAction.TeleportTo });
  const map = await arrived;
  if (!map) {
    t.say(`${caller}: I couldn't teleport to you. Are you inside the ${o.dungeon}? Say j again once you are.`);
    return { outcome: "unreachable", names: null, note: `teleport to ${caller} brought no new map within ${T.teleportMs / 1000}s` };
  }
  const wanted = map.name.toLowerCase() === o.dungeon.toLowerCase();
  try {
    await waitFor(client, () => inWorld(client, map.name), T.dungeonInWorldMs, `the world "${map.name}"`, ctx);
  } catch (e) {
    return { outcome: "failed", names: null, note: e instanceof Error ? e.message : String(e) };
  }
  // A new connection: the party refresh the real client sends after every MAPINFO (the server drops a member who does not) — after the client's delay, not at once.
  const arrivedAt = Date.now();
  void (async () => {
    await sleep(T.refreshDelayMs);
    if (client.connected) client.send("PARTYACTION", { playerId: NO_PLAYER, actionId: PartyAction.Refresh });
  })();
  // Count the window from the moment the map arrived (the roster reset with it).
  ctx.report("counting", `in "${map.name}"${wanted ? "" : ` (not a ${o.dungeon})`}; counting who joins for ${T.countMs / 1000}s`);
  t.say(`in ${map.name}. Counting for ${T.countMs / 1000}s.`);
  const countStart = arrivedAt;
  let cut = "";
  while (Date.now() - countStart < T.countMs) {
    if (ctx.stopped()) break;
    if (!client.connected) {
      // Died or dropped mid-count (a hunter has no self-preservation by design): what it saw until then still counts.
      cut = `the bot lost its connection after ${Math.round((Date.now() - countStart) / 1000)}s of the window`;
      break;
    }
    await sleep(250);
  }
  const names = seenNames(t.obs, client.objectId);
  const { entered, partyEntered } = countEntered(names, [...t.membersBefore, ...t.party.memberNames()]);
  if (client.connected) t.say(`${map.name}: ${entered} in (${partyEntered} from the party). Back to the Nexus.`);
  return { outcome: wanted ? "counted" : "other_dungeon", names, note: [wanted ? "" : `"${map.name}" is not a ${o.dungeon}`, cut].filter(Boolean).join("; ") };
}
