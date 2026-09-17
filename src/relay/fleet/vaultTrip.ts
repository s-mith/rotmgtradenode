// The Vault map as a bot sees it (docs/relay/STORAGE.md): getting there
// from the Nexus, the VAULTINFO sequence that names every container, and
// the small waits and walks every trip through it is made of. Shared by
// the backpack chore (backpacks.ts) and the storage chore (storage.ts).
import { findPath, smoothPath } from "../../accountgen/walker/pathfinding";
import type { GameClient } from "../client/gameClient";
import type { AnyPacket, Packet } from "../protocol/packets";
import type { WorldPos } from "../protocol/data";

/** Realm object types (object.xml). */
export const VAULT_PORTAL_TYPE = 0x0720;
export const GIFT_CHEST_TYPE = 0x0744;
export const NEXUS_MAP = "Nexus";
export const VAULT_MAP = "Vault";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const dist = (a: WorldPos, b: WorldPos): number => Math.hypot(a.x - b.x, a.y - b.y);

/** One container as VAULTINFO describes it: its object id and the item type in each slot, -1 for empty. */
export interface VaultContainer {
  objectId: number;
  slots: number[];
}
/**
 * Everything one VAULTINFO sequence said. The vault is one object whose
 * slots run across every chest the account owns (8 per chest); the potion
 * rack, the Gift Chest and the seasonal spoils chest are one object each.
 * Materials (the forge's) are read but not touched.
 */
export interface VaultView {
  vault: VaultContainer;
  material: VaultContainer;
  gift: VaultContainer;
  potion: VaultContainer;
  spoils: VaultContainer;
}
const emptyContainer = (): VaultContainer => ({ objectId: -1, slots: [] });
export const emptyVaultView = (): VaultView => ({ vault: emptyContainer(), material: emptyContainer(), gift: emptyContainer(), potion: emptyContainer(), spoils: emptyContainer() });

/** Fold one VAULTINFO packet into a view: lists concatenate across a sequence, ids are taken where given. */
export function mergeVaultInfo(view: VaultView, p: Packet<"VAULTINFO">): VaultView {
  const add = (c: VaultContainer, objectId: number, contents: number[]): VaultContainer => ({ objectId: objectId >= 0 ? objectId : c.objectId, slots: c.slots.concat(contents) });
  return {
    vault: add(view.vault, p.vaultObjectId, p.vaultContents),
    material: add(view.material, p.materialObjectId, p.materialContents),
    gift: add(view.gift, p.giftObjectId, p.giftContents),
    potion: add(view.potion, p.potionObjectId, p.potionContents),
    spoils: add(view.spoils, p.spoilsObjectId, p.spoilsContents),
  };
}

/** Timeouts a vault trip needs; the chores pass their own tables. */
export interface VaultTimeouts {
  inWorldMs: number;
  findObjectMs: number;
  walkMs: number;
  portalWaitMs: number;
  portalAttempts: number;
  vaultInfoMs: number;
}

/** Poll `pred` until true or the deadline; throws with `what` on timeout. */
export async function waitFor(client: GameClient, pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!client.active) throw new Error(`client went inactive while waiting for ${what}`);
    if (pred()) return;
    await sleep(150);
  }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
}
export const inWorld = (client: GameClient, map: string): boolean => client.connected && client.objectId !== -1 && !!client.playerData.name && client.mapName === map;

/** The first `pred` packet within `ms`; arm BEFORE the action that provokes it. */
export function nextPacket<K extends AnyPacket["type"]>(client: GameClient, type: K, ms: number, pred: (p: Extract<AnyPacket, { type: K }>) => boolean = () => true): Promise<Extract<AnyPacket, { type: K }> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.off("packet", on);
      resolve(null);
    }, ms);
    const on = (p: AnyPacket) => {
      if (p.type !== type) return;
      const q = p as Extract<AnyPacket, { type: K }>;
      if (!pred(q)) return;
      clearTimeout(timer);
      client.off("packet", on);
      resolve(q);
    };
    client.on("packet", on);
  });
}

/** Wait for an entity of `type` to be in view; the nearest one. */
export async function findEntity(client: GameClient, type: number, ms: number, what: string): Promise<{ objectId: number; pos: WorldPos }> {
  let found: { objectId: number; pos: WorldPos } | null = null;
  await waitFor(client, () => {
    const me = client.pos;
    let best: { objectId: number; pos: WorldPos; d: number } | null = null;
    for (const [oid, ent] of client.world.entities) {
      if (ent.type !== type) continue;
      const d = me ? dist(me, ent.pos) : 0;
      if (!best || d < best.d) best = { objectId: oid, pos: ent.pos, d };
    }
    if (best) found = { objectId: best.objectId, pos: best.pos };
    return !!best;
  }, ms, what);
  return found!;
}

export async function walkTo(client: GameClient, goal: WorldPos, goalDist: number, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  let lastPlan = 0;
  while (Date.now() < deadline) {
    if (!client.active || !client.connected) throw new Error(`client went inactive while walking to ${what}`);
    const pos = client.pos;
    if (pos && dist(pos, goal) <= goalDist) {
      client.setPath([]);
      return;
    }
    const now = Date.now();
    if (pos && (now - lastPlan >= 1000 || client.pathLength === 0)) {
      lastPlan = now;
      const path = findPath(client.world, pos, goal, goalDist);
      client.setPath(path ? smoothPath(client.world, pos, path) : [{ ...goal }]);
    }
    await sleep(100);
  }
  client.setPath([]);
  throw new Error(`timed out after ${ms / 1000}s walking to ${what}`);
}

/** Gather one VAULTINFO sequence (lists concatenate until `last`). */
export async function readVaultInfo(client: GameClient, ms: number): Promise<VaultView | null> {
  const deadline = Date.now() + ms;
  let view = emptyVaultView();
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const p = await nextPacket(client, "VAULTINFO", left);
    if (!p) return null;
    view = mergeVaultInfo(view, p as Packet<"VAULTINFO">);
    if ((p as Packet<"VAULTINFO">).last) return view;
  }
}

/** Collect the server's chatter (notifications, claim responses, failures) between arm() and stop(), for the trip log. */
export function captureChatter(client: GameClient): { seen: string[]; stop: () => string[] } {
  const seen: string[] = [];
  const on = (p: AnyPacket) => {
    if (p.type === "NOTIFICATION") seen.push(`NOTIFICATION ${p.message}`);
    else if (p.type === "CLAIMDAILYLOGINRESPONSE") seen.push(`CLAIMDAILYLOGINRESPONSE ${p.message}`);
    else if (p.type === "CLAIMREWARDRESULT") seen.push(`CLAIMREWARDRESULT success=${p.success}`);
    else if (p.type === "FAILURE") seen.push(`FAILURE ${p.errorId} ${p.errorDescription}`);
    else if (p.type === "TEXT" && p.name === "") seen.push(`TEXT ${p.text}`);
    // 0 answers an INVSWAP, 1 a USEITEM; unknownBool false is a refusal (proxy giftchest plugin).
    else if (p.type === "INVRESULT") seen.push(`INVRESULT ok=${p.unknownBool} kind=${p.unknownByte}`);
  };
  client.on("packet", on);
  return { seen, stop: () => { client.off("packet", on); return seen; } };
}

/**
 * Walk to a Vault Portal in view and go through it, retrying the USEPORTAL
 * (re-walking first) until the Vault's MAPINFO arrives. Resolves with the
 * view the VAULTINFO sequence gave.
 */
export async function enterVault(client: GameClient, T: VaultTimeouts, log: (l: string) => void): Promise<VaultView> {
  let last = "";
  for (let attempt = 1; attempt <= T.portalAttempts; attempt++) {
    const portal = await findEntity(client, VAULT_PORTAL_TYPE, T.findObjectMs, "the Vault Portal in view");
    await walkTo(client, portal.pos, 0.8, T.walkMs, "the Vault Portal");
    await sleep(700); // let the server's copy of us arrive too (the first USEPORTAL right after the walk was ignored, live 2026-09-07)
    const me = client.pos ?? portal.pos;
    const vaultInfo = readVaultInfo(client, T.portalWaitMs + T.vaultInfoMs);
    const arrived = nextPacket(client, "MAPINFO", T.portalWaitMs, (p) => p.name === VAULT_MAP);
    client.send("USEPORTAL", { objectId: portal.objectId });
    last = `USEPORTAL #${portal.objectId} attempt ${attempt} from (${me.x.toFixed(1)},${me.y.toFixed(1)}), portal at (${portal.pos.x.toFixed(1)},${portal.pos.y.toFixed(1)})`;
    log(last);
    if (await arrived) {
      await waitFor(client, () => inWorld(client, VAULT_MAP), T.inWorldMs, "the Vault");
      const vault = await vaultInfo;
      if (!vault) throw new Error("no VAULTINFO after entering the vault");
      return vault;
    }
  }
  throw new Error(`USEPORTAL did not lead to the Vault after ${T.portalAttempts} attempts (${last})`);
}
