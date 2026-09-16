import type Database from "better-sqlite3";
import { SERVERS } from "./servers";
import { serverUsage } from "./serverUsage";

export type ServerControl = {
  server: string;
  depositsDisabled: boolean;
  withdrawsDisabled: boolean;
  /** Realm's current load for the server (0..1) when a fresh reading holds one, else null. */
  usage: number | null;
  /** The load gate has this server closed: usage above SERVER_USAGE_MAX. Independent of the manual toggles. */
  busy: boolean;
};

/** Why a trade may not target `server` right now: an operator toggle, Realm's load, or nothing. */
export type BlockReason = "disabled" | "busy" | null;

/** Player-facing text for a refused server. */
export function blockMessage(server: string, kind: "deposit" | "withdraw", reason: Exclude<BlockReason, null>): string {
  const verb = kind === "deposit" ? "Deposits are" : "Withdraws are";
  if (reason === "busy") {
    const r = serverUsage.reading(server);
    const pct = r ? ` (${Math.round(r.usage * 100)}% full)` : "";
    return `${server} is busy right now${pct} — trades only run on empty servers. Pick another server.`;
  }
  return `${verb} temporarily disabled on ${server}. Pick another server.`;
}

export function getAllServerControls(db: Database.Database): ServerControl[] {
  const rows = db
    .prepare("SELECT server, deposits_disabled, withdraws_disabled FROM server_controls")
    .all() as { server: string; deposits_disabled: number; withdraws_disabled: number }[];

  const map = new Map(rows.map((r) => [r.server, r]));
  const now = Date.now();
  return SERVERS.map((s) => {
    const row = map.get(s);
    const reading = serverUsage.reading(s, now);
    return {
      server: s,
      depositsDisabled: row ? Boolean(row.deposits_disabled) : false,
      withdrawsDisabled: row ? Boolean(row.withdraws_disabled) : false,
      usage: reading ? reading.usage : null,
      busy: serverUsage.busy(s, now),
    };
  });
}

/** The manual toggle first (it is the operator's word), then Realm's load. */
export function depositBlock(db: Database.Database, server: string): BlockReason {
  if (isDepositsDisabled(db, server)) return "disabled";
  return serverUsage.busy(server) ? "busy" : null;
}
export function withdrawBlock(db: Database.Database, server: string): BlockReason {
  if (isWithdrawsDisabled(db, server)) return "disabled";
  return serverUsage.busy(server) ? "busy" : null;
}

export function setServerControl(
  db: Database.Database,
  server: string,
  depositsDisabled: boolean,
  withdrawsDisabled: boolean,
): void {
  db.prepare(
    `INSERT INTO server_controls (server, deposits_disabled, withdraws_disabled, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(server) DO UPDATE SET
       deposits_disabled = excluded.deposits_disabled,
       withdraws_disabled = excluded.withdraws_disabled,
       updated_at = excluded.updated_at`,
  ).run(server, depositsDisabled ? 1 : 0, withdrawsDisabled ? 1 : 0, Date.now());
}

export function isDepositsDisabled(db: Database.Database, server: string): boolean {
  const row = db
    .prepare("SELECT deposits_disabled FROM server_controls WHERE server = ?")
    .get(server) as { deposits_disabled: number } | undefined;
  return Boolean(row?.deposits_disabled);
}

export function isWithdrawsDisabled(db: Database.Database, server: string): boolean {
  const row = db
    .prepare("SELECT withdraws_disabled FROM server_controls WHERE server = ?")
    .get(server) as { withdraws_disabled: number } | undefined;
  return Boolean(row?.withdraws_disabled);
}
