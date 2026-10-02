// Packet codecs. Only the packets the bots send or act on are defined; any
// other id parses as UNKNOWN with its raw payload attached, so a new server
// packet never crashes the read loop.
//
// Every codec has both directions so the test suite can round-trip the
// Python implementation's bytes through read() and write() and prove the
// two agree.
import type { PacketReader } from "./reader";
import type { PacketWriter } from "./writer";
import {
  FameBonus, GroundTile, MoveRecord, ObjectData, ObjectStatus, SlotObject, TradeItem, WorldPos,
  readBoolMask, readCompressedList, readShortList, writeBoolMask,
} from "./data";

// Client -> server ---------------------------------------------------------

export interface HelloPacket {
  gameId: number;
  buildVersion: string;
  accessToken: string;
  keyTime: number;
  key: Uint8Array;
  userPlatform: string;
  playPlatform: string;
  platformToken: string;
  userToken: string;
  token: string;
}
/** Fixed client token every HELLO carries. Not a secret. */
export const HELLO_TOKEN = "XQpu8CWkMehb5rLVP3DG47FcafExRUvg";

export interface LoadPacket { charId: number; isFromArena: boolean }
/** `newBool` is the fifth field added in game build 6.11.0.1.0 (meaning unknown); the server does not apply the old four-field layout. */
export interface CreatePacket { classType: number; skinType: number; isChallenger: boolean; isSeasonal: boolean; newBool: boolean }
export interface MovePacket { tickId: number; time: number; records: MoveRecord[] }
export type UpdateAckPacket = Record<string, never>;
export interface GotoAckPacket { time: number; unknownByte: number }
export interface PongPacket { serial: number; time: number }
export interface ShootAckPacket { time: number }
export interface ShowAllyShootPacket { toggle: number }
export type EscapePacket = Record<string, never>;
export interface PlayerTextPacket { text: string }
export interface RequestTradePacket { name: string }
export interface ChangeTradePacket { offer: boolean[] }
export interface AcceptTradePacket { clientOffer: boolean[]; partnerOffer: boolean[] }
export type CancelTradePacket = Record<string, never>;
export interface InvSwapPacket { time: number; pos: WorldPos; slotObject1: SlotObject; slotObject2: SlotObject }
/** Drop an item on the ground (it is gone): the slot on the player, `quickSlot` when the slot id names a quickslot (protocol.json InvDrop, 7.0.0.2.0). */
export interface InvDropPacket { slotObject: SlotObject; quickSlot: boolean }
export interface UsePortalPacket { objectId: number }
export interface PlayerShootPacket {
  time: number; bulletId: number; weaponId: number; projectileId: number; startingPos: WorldPos;
  angle: number; isBurst: boolean; patternIdx: number; attackType: number; playerPosition: WorldPos;
}
export interface UseItemPacket { time: number; slotObject: SlotObject; pos: WorldPos; useType: number; unknownInt: number }
export interface EnemyHitPacket { time: number; bulletId: number; id1: number; targetId: number; kill: boolean; id2: number }
export interface OtherHitPacket { time: number; bulletId: number; objectId: number; targetId: number }
/** Ack for received ENEMYSHOOT/SERVERPLAYERSHOOT: one per packet, ack=1. */
export interface ShootAckCounterPacket { time: number; ack: number }

// Server -> client ---------------------------------------------------------

export interface FailurePacket { errorId: number; errorDescription: string }
export interface MapInfoPacket {
  width: number; height: number; name: string; displayName: string; realmName: string;
  seed: number; background: number; difficulty: number; allowPlayerTeleport: boolean;
  showDisplays: boolean; newBool: boolean; maxPlayers: number; gameOpenedTime: number;
  buildVersion: string; viewRadius: number; newInt: number; dungeonModifiers: string[];
  unknownShort1: number; unknownBool: boolean; unknownShort2: number;
  maxRealmScore: number; curRealmScore: number;
}
export interface CreateSuccessPacket { objectId: number; charId: number; pcStats: string }
export interface UpdatePacket {
  pos: WorldPos; levelType: number; tiles: GroundTile[]; newObjs: ObjectData[]; drops: number[];
  /** -1 when absent. */
  unknownByte: number;
}
export interface NewTickPacket {
  tickId: number; tickTime: number; serverRealTimeMS: number; serverLastTimeRTTMS: number;
  statuses: ObjectStatus[];
}
export interface GotoPacket { objectId: number; position: WorldPos; unknownInt: number }
export interface PingPacket { serial: number }
export interface ReconnectPacket { name: string; host: string; port: number; gameId: number; keyTime: number; key: Uint8Array }
export interface QueueInformationPacket { curPos: number; maxPos: number }
export interface TextPacket {
  name: string; objectId: number; numStars: number; bubbleTime: number; recipient: string;
  text: string; cleanText: string; isSupporter: boolean; starBg: number;
}
export interface TradeRequestedPacket { name: string }
export interface TradeStartPacket { clientItems: TradeItem[]; partnerName: string; partnerItems: TradeItem[] }
export interface TradeChangedPacket { offer: boolean[] }
export interface TradeAcceptedPacket { clientOffer: boolean[]; partnerOffer: boolean[] }
export interface TradeDonePacket { code: number; description: string }
export interface ServerPlayerShootPacket {
  bulletId: number; ownerId: number; containerType: number; startingPos: WorldPos; angle: number;
  damage: number; unknownInt: number; unknownByte: number; spellBomb: boolean; bulletCount: number; bulletAngle: number;
}
export interface EnemyShootPacket {
  bulletId: number; ownerId: number; bulletType: number; startingPos: WorldPos; angle: number;
  damage: number; numShots: number; angleInc: number;
}
export interface DamagePacket { targetId: number; effects: number[]; damageAmount: number; info: number; bulletId: number; objectId: number }
export interface AllyShootPacket { bulletId: number; ownerId: number; containerType: number; angle: number; inspiredBuff: boolean }
export interface QuestObjIdPacket { objectId: number; unknownBytes: number[] }
export interface AccountListPacket { accountListId: number; accountIds: string[]; lockAction: number }
export interface InvResultPacket {
  unknownBool: boolean; unknownByte: number; fromSlot: SlotObject; toSlot: SlotObject; unknownInt1: number; unknownInt2: number;
}
export interface NotificationPacket {
  effect: number; extra: number; message: string; objectId: number; uiExtra: number; queuePos: number;
  color: number; pictureType: number; emoteId: number; unknown1: number; unknown2: number;
}
export interface DeathPacket {
  accountId: string; charId: number; killedBy: string; gravestoneType: number; totalFame: number;
  fameBonuses: FameBonus[]; pcStats: string;
}
export interface UnknownPacket { id: number; payload: Buffer }

// Daily-login calendar, vault and season packets (ported from rotmgproxy,
// where each was verified on the wire in 2026-09) -----------------------------

/** Client -> server: go to the Daily Quest Room. The server honours it only from the Nexus. */
export type GoToQuestRoomPacket = Record<string, never>;
/**
 * Client -> server: claim one day of the login calendar. `claimKey` is the day's key from
 * dailyLogin/fetchCalendar (a datastore key the client cannot make up), `claimType` its track:
 * "nonconsecutive" or "consecutive".
 */
export interface ClaimDailyLoginRewardPacket { claimKey: string; claimType: string }
/** Server -> client: a message about a daily reward claim. */
export interface ClaimDailyLoginResponsePacket { message: string }
/** Server -> client: the claim's verdict, echoing the key and type that were sent. */
export interface ClaimRewardResultPacket { success: boolean; claimKey: string; claimType: string }
/**
 * Server -> client on entering the vault: every chest's full contents (item type per slot, -1 empty), which the
 * chest objects' 8 INVENTORY stats cannot carry. A long vault comes in several packets whose lists are to be
 * concatenated; `last` marks the final one. The upgrade costs and enchant strings after the lists vary between
 * builds and are kept as raw bytes.
 */
export interface VaultInfoPacket {
  last: boolean;
  vaultObjectId: number;
  materialObjectId: number;
  giftObjectId: number;
  potionObjectId: number;
  spoilsObjectId: number;
  vaultContents: number[];
  materialContents: number[];
  giftContents: number[];
  potionContents: number[];
  spoilsContents: number[];
  tail: Uint8Array;
}
/** Client -> server: convert the current seasonal character to non-seasonal (the vault's Character Changer). No fields. */
export type ConvertSeasonalCharacterPacket = Record<string, never>;

// Parties and teleporting (build 7.0, layouts from the client's protocol dump
// and rotmgproxy's captures of 2026-09-13; docs/REALMHUNTS.md). The relay's
// names are its own; the client's are noted where they differ.

/** Client -> server: teleport to a player (in the same map). `objectId` -1 when unknown; the name is what the party UI sends. */
export interface TeleportPacket {
  objectId: number;
  playerName: string;
}
/** Client -> server (client: CreatePartyMessage). The server answers with PARTYMEMBERINFO for the new party. */
export interface CreatePartyPacket {
  description: string;
  minPowerLevel: number;
  /** Realm caps parties at the dungeon's player limit. */
  maxPartySize: number;
  /** PartyActivity: 0 none, 1 dungeons, 2 realm, 3 other. */
  activity: number;
  maxedStatReq: number;
  /** PartyPrivacy: 0 none, 1 public, 2 private. */
  privacy: number;
  /** Index into the account/servers list. */
  serverIndex: number;
}
/** Client -> server (client: PartyActionResult). `actionId` is a PartyActionType: 1 kick, 2 disconnect, 3 promote, 4 refresh, 5 party list, 6 leave, 7 teleport to. 0xffff as the player id for actions on no one (the list). */
export interface PartyActionPacket {
  playerId: number;
  actionId: number;
}
/** Server -> client (client: PartyAction). `result` is a PartyActionResult: 1 failed, 2 kicked, 3 kick not found, 4 promoted, 5 promote not found, 6 left party. */
export interface PartyActionResultPacket {
  playerId: number;
  result: number;
}
/** Server -> client (client: IncomingPartyInvite). */
export interface PartyInvitePacket {
  partyId: number;
  inviterName: string;
}
/** Client -> server (client: PartyInviteResponse). */
export interface PartyInviteResponsePacket {
  partyId: number;
  accept: number;
}
export interface PartyPlayer {
  playerId: number;
  name: string;
  classId: number;
  skinId: number;
}
/** Server -> client (client: IncomingPartyMemberInfo): the party this account is in, sent on load, after CREATEPARTY, on a refresh (PARTYACTION 4) and on joining. partyId 0xffffffff with no players when in none (live 2026-09-14). */
export interface PartyMemberInfoPacket {
  partyId: number;
  unknownShort: number;
  maxSize: number;
  players: PartyPlayer[];
  description: string;
}
/** Server -> client (client: PartyMemberAdded): someone joined the party. */
export interface PartyMemberAddedPacket extends PartyPlayer {}
export interface PartyInfo {
  description: string;
  partyId: number;
  minPowerLevel: number;
  size: number;
  maxSize: number;
  activity: number;
  privacy: number;
  minStats: number;
  serverIndex: number;
}
/** Server -> client (client: PartyListMessage): one page of the party finder, 20 per page; packetNumber 0xff marks the last page. */
export interface PartyListPacket {
  packetNumber: number;
  parties: PartyInfo[];
}
/** Both ways (client: PartyJoinRequest). Client -> server: ask to join `partyId`, trailing byte 1 (live 2026-09-14: `000021f0 01`, answered by PARTYMEMBERINFO for a public party). Server -> client: the state of the request (PartyResponse: 1 pending, 2 cancelled, 3 accepted, 4 declined, 5 full, 6 blacklisted). */
export interface PartyJoinRequestPacket {
  partyId: number;
  state: number;
}
/** Both ways (client: PartyRequestResponse in, PartyJoinRequestResponse out): a join request reaching the leader, and the leader's answer (state = PartyResponse: 3 accept, 4 decline). */
export interface PartyJoinRequestResponsePacket {
  name: string;
  classId: number;
  skinId: number;
  state: number;
}

export interface Packets {
  HELLO: HelloPacket; LOAD: LoadPacket; CREATE: CreatePacket; MOVE: MovePacket; UPDATEACK: UpdateAckPacket;
  GOTOACK: GotoAckPacket; PONG: PongPacket; SHOOTACK: ShootAckPacket; SHOWALLYSHOOT: ShowAllyShootPacket;
  ESCAPE: EscapePacket; PLAYERTEXT: PlayerTextPacket; REQUESTTRADE: RequestTradePacket;
  CHANGETRADE: ChangeTradePacket; ACCEPTTRADE: AcceptTradePacket; CANCELTRADE: CancelTradePacket;
  INVSWAP: InvSwapPacket; INVDROP: InvDropPacket; USEPORTAL: UsePortalPacket; PLAYERSHOOT: PlayerShootPacket; USEITEM: UseItemPacket;
  ENEMYHIT: EnemyHitPacket; OTHERHIT: OtherHitPacket; SHOOTACKCOUNTER: ShootAckCounterPacket;
  DAMAGE: DamagePacket; ALLYSHOOT: AllyShootPacket; QUESTOBJID: QuestObjIdPacket;
  FAILURE: FailurePacket; MAPINFO: MapInfoPacket; CREATESUCCESS: CreateSuccessPacket; UPDATE: UpdatePacket;
  NEWTICK: NewTickPacket; GOTO: GotoPacket; PING: PingPacket; RECONNECT: ReconnectPacket;
  QUEUEINFORMATION: QueueInformationPacket; TEXT: TextPacket; TRADEREQUESTED: TradeRequestedPacket;
  TRADESTART: TradeStartPacket; TRADECHANGED: TradeChangedPacket; TRADEACCEPTED: TradeAcceptedPacket;
  TRADEDONE: TradeDonePacket; SERVERPLAYERSHOOT: ServerPlayerShootPacket; ENEMYSHOOT: EnemyShootPacket;
  ACCOUNTLIST: AccountListPacket; INVRESULT: InvResultPacket; NOTIFICATION: NotificationPacket; DEATH: DeathPacket;
  GOTOQUESTROOM: GoToQuestRoomPacket; CLAIMDAILYLOGINREWARD: ClaimDailyLoginRewardPacket;
  CLAIMDAILYLOGINRESPONSE: ClaimDailyLoginResponsePacket; CLAIMREWARDRESULT: ClaimRewardResultPacket;
  VAULTINFO: VaultInfoPacket; CONVERTSEASONALCHARACTER: ConvertSeasonalCharacterPacket;
  TELEPORT: TeleportPacket; CREATEPARTY: CreatePartyPacket; PARTYACTION: PartyActionPacket; PARTYACTIONRESULT: PartyActionResultPacket;
  PARTYINVITE: PartyInvitePacket; PARTYINVITERESPONSE: PartyInviteResponsePacket; PARTYMEMBERINFO: PartyMemberInfoPacket;
  PARTYMEMBERADDED: PartyMemberAddedPacket; PARTYLIST: PartyListPacket; PARTYJOINREQUEST: PartyJoinRequestPacket;
  PARTYJOINREQUESTRESPONSE: PartyJoinRequestResponsePacket;
}
export type PacketName = keyof Packets;
export type Packet<K extends PacketName = PacketName> = { [N in PacketName]: { type: N } & Packets[N] }[K];
export type AnyPacket = Packet | ({ type: "UNKNOWN" } & UnknownPacket);

export interface Codec<T> {
  read(r: PacketReader): T;
  write(w: PacketWriter, p: T): void;
}

const empty: Codec<Record<string, never>> = { read: () => ({}), write: () => {} };

function readPartyPlayer(r: PacketReader): PartyPlayer {
  return { playerId: r.readUnsignedShort(), name: r.readStr(), classId: r.readUnsignedShort(), skinId: r.readUnsignedShort() };
}
function writePartyPlayer(w: PacketWriter, p: PartyPlayer): void {
  w.writeUnsignedShort(p.playerId);
  w.writeStr(p.name);
  w.writeUnsignedShort(p.classId);
  w.writeUnsignedShort(p.skinId);
}

export const CODECS: { [K in PacketName]: Codec<Packets[K]> } = {
  HELLO: {
    read: (r) => {
      const gameId = r.readInt32();
      const buildVersion = r.readStr();
      const accessToken = r.readStr();
      const keyTime = r.readInt32();
      const key = r.readBytes();
      const userPlatform = r.readStr();
      const playPlatform = r.readStr();
      const platformToken = r.readStr();
      const userToken = r.readStr();
      const token = r.readStr();
      return { gameId, buildVersion, accessToken, keyTime, key, userPlatform, playPlatform, platformToken, userToken, token };
    },
    write: (w, p) => {
      w.writeInt32(p.gameId);
      w.writeStr(p.buildVersion);
      w.writeStr(p.accessToken);
      w.writeInt32(p.keyTime);
      w.writeBytes(p.key);
      w.writeStr(p.userPlatform);
      w.writeStr(p.playPlatform);
      w.writeStr(p.platformToken);
      w.writeStr(p.userToken);
      w.writeStr(p.token);
    },
  },
  LOAD: {
    read: (r) => {
      const charId = r.readInt32();
      const isFromArena = r.readBool();
      return { charId, isFromArena };
    },
    write: (w, p) => {
      w.writeInt32(p.charId);
      w.writeBool(p.isFromArena);
    },
  },
  CREATE: {
    read: (r) => {
      const classType = r.readShort();
      const skinType = r.readShort();
      const isChallenger = r.readBool();
      const isSeasonal = r.readBool();
      const newBool = r.bytesAvailable() > 0 ? r.readBool() : false;
      return { classType, skinType, isChallenger, isSeasonal, newBool };
    },
    write: (w, p) => {
      w.writeShort(p.classType);
      w.writeShort(p.skinType);
      w.writeBool(p.isChallenger);
      w.writeBool(p.isSeasonal);
      w.writeBool(p.newBool);
    },
  },
  MOVE: {
    read: (r) => {
      const tickId = r.readInt32();
      const time = r.readUInt32();
      const records = readShortList(r, MoveRecord.read);
      return { tickId, time, records };
    },
    write: (w, p) => {
      w.writeInt32(p.tickId);
      w.writeUInt32(p.time);
      w.writeShort(p.records.length);
      for (const rec of p.records) MoveRecord.write(w, rec);
    },
  },
  UPDATEACK: empty,
  GOTOACK: {
    read: (r) => {
      const time = r.readInt32();
      const unknownByte = r.readByte();
      return { time, unknownByte };
    },
    write: (w, p) => {
      w.writeInt32(p.time);
      w.writeByte(p.unknownByte);
    },
  },
  PONG: {
    read: (r) => {
      const serial = r.readInt32();
      const time = r.readInt32();
      return { serial, time };
    },
    write: (w, p) => {
      w.writeInt32(p.serial);
      w.writeInt32(p.time);
    },
  },
  SHOOTACK: { read: (r) => ({ time: r.readInt32() }), write: (w, p) => w.writeInt32(p.time) },
  SHOWALLYSHOOT: { read: (r) => ({ toggle: r.readInt32() }), write: (w, p) => w.writeInt32(p.toggle) },
  ESCAPE: empty,
  PLAYERTEXT: { read: (r) => ({ text: r.readStr() }), write: (w, p) => w.writeStr(p.text) },
  REQUESTTRADE: { read: (r) => ({ name: r.readStr() }), write: (w, p) => w.writeStr(p.name) },
  CHANGETRADE: { read: (r) => ({ offer: readBoolMask(r) }), write: (w, p) => writeBoolMask(w, p.offer) },
  ACCEPTTRADE: {
    read: (r) => {
      const clientOffer = readBoolMask(r);
      const partnerOffer = readBoolMask(r);
      return { clientOffer, partnerOffer };
    },
    write: (w, p) => {
      writeBoolMask(w, p.clientOffer);
      writeBoolMask(w, p.partnerOffer);
    },
  },
  CANCELTRADE: empty,
  INVSWAP: {
    read: (r) => {
      const time = r.readInt32();
      const pos = WorldPos.read(r);
      const slotObject1 = SlotObject.read(r);
      const slotObject2 = SlotObject.read(r);
      return { time, pos, slotObject1, slotObject2 };
    },
    write: (w, p) => {
      w.writeInt32(p.time);
      WorldPos.write(w, p.pos);
      SlotObject.write(w, p.slotObject1);
      SlotObject.write(w, p.slotObject2);
    },
  },
  INVDROP: {
    read: (r) => ({ slotObject: SlotObject.read(r), quickSlot: r.readBool() }),
    write: (w, p) => {
      SlotObject.write(w, p.slotObject);
      w.writeBool(p.quickSlot);
    },
  },
  USEPORTAL: { read: (r) => ({ objectId: r.readInt32() }), write: (w, p) => w.writeInt32(p.objectId) },
  PLAYERSHOOT: {
    read: (r) => {
      const time = r.readInt32();
      const bulletId = r.readShort();
      const weaponId = r.readUnsignedShort();
      const projectileId = r.readByte();
      const startingPos = WorldPos.read(r);
      const angle = r.readFloat();
      const isBurst = r.readBool();
      const patternIdx = r.readByte();
      const attackType = r.readByte();
      const playerPosition = WorldPos.read(r);
      return { time, bulletId, weaponId, projectileId, startingPos, angle, isBurst, patternIdx, attackType, playerPosition };
    },
    write: (w, p) => {
      w.writeInt32(p.time);
      w.writeShort(p.bulletId);
      w.writeUnsignedShort(p.weaponId);
      w.writeByte(p.projectileId);
      WorldPos.write(w, p.startingPos);
      w.writeFloat(p.angle);
      w.writeBool(p.isBurst);
      w.writeByte(p.patternIdx);
      w.writeByte(p.attackType);
      WorldPos.write(w, p.playerPosition);
    },
  },
  USEITEM: {
    read: (r) => {
      const time = r.readInt32();
      const slotObject = SlotObject.read(r);
      const pos = WorldPos.read(r);
      const useType = r.readByte();
      const unknownInt = r.readInt32();
      return { time, slotObject, pos, useType, unknownInt };
    },
    write: (w, p) => {
      w.writeInt32(p.time);
      SlotObject.write(w, p.slotObject);
      WorldPos.write(w, p.pos);
      w.writeByte(p.useType);
      w.writeInt32(p.unknownInt);
    },
  },
  ENEMYHIT: {
    read: (r) => {
      const time = r.readInt32();
      const bulletId = r.readShort();
      const id1 = r.readInt32();
      const targetId = r.readInt32();
      const kill = r.readBool();
      const id2 = r.readInt32();
      return { time, bulletId, id1, targetId, kill, id2 };
    },
    write: (w, p) => {
      w.writeInt32(p.time);
      w.writeShort(p.bulletId);
      w.writeInt32(p.id1);
      w.writeInt32(p.targetId);
      w.writeBool(p.kill);
      w.writeInt32(p.id2);
    },
  },
  OTHERHIT: {
    read: (r) => {
      const time = r.readInt32();
      const bulletId = r.readShort();
      const objectId = r.readInt32();
      const targetId = r.readInt32();
      return { time, bulletId, objectId, targetId };
    },
    write: (w, p) => {
      w.writeInt32(p.time);
      w.writeShort(p.bulletId);
      w.writeInt32(p.objectId);
      w.writeInt32(p.targetId);
    },
  },
  SHOOTACKCOUNTER: {
    read: (r) => {
      const time = r.readInt32();
      const ack = r.readShort();
      return { time, ack };
    },
    write: (w, p) => {
      w.writeInt32(p.time);
      w.writeShort(p.ack);
    },
  },
  DAMAGE: {
    read: (r) => {
      const targetId = r.readInt32();
      const n = r.readUnsignedByte();
      const effects: number[] = [];
      for (let i = 0; i < n; i++) effects.push(r.readUnsignedByte());
      const damageAmount = r.readUnsignedShort();
      const info = r.readByte();
      const bulletId = r.readUnsignedShort();
      const objectId = r.readInt32();
      return { targetId, effects, damageAmount, info, bulletId, objectId };
    },
    write: (w, p) => {
      w.writeInt32(p.targetId);
      w.writeUnsignedByte(p.effects.length);
      for (const e of p.effects) w.writeUnsignedByte(e);
      w.writeUnsignedShort(p.damageAmount);
      w.writeByte(p.info);
      w.writeUnsignedShort(p.bulletId);
      w.writeInt32(p.objectId);
    },
  },
  ALLYSHOOT: {
    read: (r) => {
      const bulletId = r.readUnsignedShort();
      const ownerId = r.readInt32();
      const containerType = r.readInt32();
      const angle = r.readFloat();
      const inspiredBuff = r.readBool();
      return { bulletId, ownerId, containerType, angle, inspiredBuff };
    },
    write: (w, p) => {
      w.writeUnsignedShort(p.bulletId);
      w.writeInt32(p.ownerId);
      w.writeInt32(p.containerType);
      w.writeFloat(p.angle);
      w.writeBool(p.inspiredBuff);
    },
  },
  QUESTOBJID: {
    read: (r) => {
      const objectId = r.readInt32();
      const unknownBytes: number[] = [];
      while (r.bytesAvailable() > 0) unknownBytes.push(r.readByte());
      return { objectId, unknownBytes };
    },
    write: (w, p) => {
      w.writeInt32(p.objectId);
      for (const b of p.unknownBytes) w.writeByte(b);
    },
  },

  FAILURE: {
    read: (r) => {
      const errorId = r.readInt32();
      const errorDescription = r.readStr();
      return { errorId, errorDescription };
    },
    write: (w, p) => {
      w.writeInt32(p.errorId);
      w.writeStr(p.errorDescription);
    },
  },
  MAPINFO: {
    read: (r) => {
      const width = r.readInt32();
      const height = r.readInt32();
      const name = r.readStr();
      const displayName = r.readStr();
      const realmName = r.readStr();
      const seed = r.readUInt32();
      const background = r.readInt32();
      const difficulty = r.readFloat();
      const allowPlayerTeleport = r.readBool();
      const showDisplays = r.readBool();
      const newBool = r.readBool();
      const maxPlayers = r.readShort();
      const gameOpenedTime = r.readUInt32();
      const buildVersion = r.readStr();
      const viewRadius = r.readShort();
      const newInt = r.readInt32();
      const dungeonModifiers = r.readStr().split(";");
      const unknownShort1 = r.readShort();
      const unknownBool = r.readBool();
      const unknownShort2 = r.readShort();
      let maxRealmScore = 0;
      let curRealmScore = 0;
      if (r.bytesAvailable() > 0) {
        maxRealmScore = r.readInt32();
        curRealmScore = r.readInt32();
      }
      return {
        width, height, name, displayName, realmName, seed, background, difficulty, allowPlayerTeleport,
        showDisplays, newBool, maxPlayers, gameOpenedTime, buildVersion, viewRadius, newInt, dungeonModifiers,
        unknownShort1, unknownBool, unknownShort2, maxRealmScore, curRealmScore,
      };
    },
    write: (w, p) => {
      w.writeInt32(p.width);
      w.writeInt32(p.height);
      w.writeStr(p.name);
      w.writeStr(p.displayName);
      w.writeStr(p.realmName);
      w.writeUInt32(p.seed);
      w.writeInt32(p.background);
      w.writeFloat(p.difficulty);
      w.writeBool(p.allowPlayerTeleport);
      w.writeBool(p.showDisplays);
      w.writeBool(p.newBool);
      w.writeShort(p.maxPlayers);
      w.writeUInt32(p.gameOpenedTime);
      w.writeStr(p.buildVersion);
      w.writeShort(p.viewRadius);
      w.writeInt32(p.newInt);
      w.writeStr(p.dungeonModifiers.join(";"));
      w.writeShort(p.unknownShort1);
      w.writeBool(p.unknownBool);
      w.writeShort(p.unknownShort2);
      if (p.maxRealmScore !== 0 && p.curRealmScore !== 0) {
        w.writeInt32(p.maxRealmScore);
        w.writeInt32(p.curRealmScore);
      }
    },
  },
  CREATESUCCESS: {
    read: (r) => {
      const objectId = r.readInt32();
      const charId = r.readInt32();
      const pcStats = r.readStr();
      return { objectId, charId, pcStats };
    },
    write: (w, p) => {
      w.writeInt32(p.objectId);
      w.writeInt32(p.charId);
      w.writeStr(p.pcStats);
    },
  },
  UPDATE: {
    read: (r) => {
      const pos = WorldPos.read(r);
      const levelType = r.readByte();
      const tiles = readCompressedList(r, GroundTile.read);
      const newObjs = readCompressedList(r, ObjectData.read);
      const drops = readCompressedList(r, (rr) => rr.readCompressedInt());
      const unknownByte = r.bytesAvailable() > 0 ? r.readUnsignedByte() : -1;
      return { pos, levelType, tiles, newObjs, drops, unknownByte };
    },
    write: (w, p) => {
      WorldPos.write(w, p.pos);
      w.writeByte(p.levelType);
      w.writeCompressedInt(p.tiles.length);
      for (const t of p.tiles) GroundTile.write(w, t);
      w.writeCompressedInt(p.newObjs.length);
      for (const o of p.newObjs) ObjectData.write(w, o);
      w.writeCompressedInt(p.drops.length);
      for (const d of p.drops) w.writeCompressedInt(d);
      if (p.unknownByte !== -1) w.writeUnsignedByte(p.unknownByte);
    },
  },
  NEWTICK: {
    read: (r) => {
      const tickId = r.readInt32();
      const tickTime = r.readInt32();
      const serverRealTimeMS = r.readUInt32();
      const serverLastTimeRTTMS = r.readUnsignedShort();
      const statuses = readShortList(r, ObjectStatus.read);
      return { tickId, tickTime, serverRealTimeMS, serverLastTimeRTTMS, statuses };
    },
    write: (w, p) => {
      w.writeInt32(p.tickId);
      w.writeInt32(p.tickTime);
      w.writeUInt32(p.serverRealTimeMS);
      w.writeUnsignedShort(p.serverLastTimeRTTMS);
      w.writeShort(p.statuses.length);
      for (const s of p.statuses) ObjectStatus.write(w, s);
    },
  },
  GOTO: {
    read: (r) => {
      const objectId = r.readInt32();
      const position = WorldPos.read(r);
      const unknownInt = r.readInt32();
      return { objectId, position, unknownInt };
    },
    write: (w, p) => {
      w.writeInt32(p.objectId);
      WorldPos.write(w, p.position);
      w.writeInt32(p.unknownInt);
    },
  },
  PING: { read: (r) => ({ serial: r.readInt32() }), write: (w, p) => w.writeInt32(p.serial) },
  RECONNECT: {
    read: (r) => {
      const name = r.readStr();
      const host = r.readStr();
      const port = r.readShort();
      const gameId = r.readInt32();
      const keyTime = r.readInt32();
      const key = r.readBytes();
      return { name, host, port, gameId, keyTime, key };
    },
    write: (w, p) => {
      w.writeStr(p.name);
      w.writeStr(p.host);
      w.writeShort(p.port);
      w.writeInt32(p.gameId);
      w.writeInt32(p.keyTime);
      w.writeBytes(p.key);
    },
  },
  QUEUEINFORMATION: {
    read: (r) => {
      const curPos = r.readUnsignedShort();
      const maxPos = r.readUnsignedShort();
      return { curPos, maxPos };
    },
    write: (w, p) => {
      w.writeUnsignedShort(p.curPos);
      w.writeUnsignedShort(p.maxPos);
    },
  },
  TEXT: {
    read: (r) => {
      const name = r.readStr();
      const objectId = r.readInt32();
      const numStars = r.readUnsignedShort();
      const bubbleTime = r.readUnsignedByte();
      const recipient = r.readStr();
      const text = r.readStr();
      const cleanText = r.readStr();
      const isSupporter = r.readBool();
      const starBg = r.readInt32();
      return { name, objectId, numStars, bubbleTime, recipient, text, cleanText, isSupporter, starBg };
    },
    write: (w, p) => {
      w.writeStr(p.name);
      w.writeInt32(p.objectId);
      w.writeUnsignedShort(p.numStars);
      w.writeUnsignedByte(p.bubbleTime);
      w.writeStr(p.recipient);
      w.writeStr(p.text);
      w.writeStr(p.cleanText);
      w.writeBool(p.isSupporter);
      w.writeInt32(p.starBg);
    },
  },
  TRADEREQUESTED: { read: (r) => ({ name: r.readStr() }), write: (w, p) => w.writeStr(p.name) },
  TRADESTART: {
    read: (r) => {
      const clientItems = readShortList(r, TradeItem.read);
      const partnerName = r.readStr();
      const partnerItems = readShortList(r, TradeItem.read);
      return { clientItems, partnerName, partnerItems };
    },
    write: (w, p) => {
      w.writeShort(p.clientItems.length);
      for (const it of p.clientItems) TradeItem.write(w, it);
      w.writeStr(p.partnerName);
      w.writeShort(p.partnerItems.length);
      for (const it of p.partnerItems) TradeItem.write(w, it);
    },
  },
  TRADECHANGED: { read: (r) => ({ offer: readBoolMask(r) }), write: (w, p) => writeBoolMask(w, p.offer) },
  TRADEACCEPTED: {
    read: (r) => {
      const clientOffer = readBoolMask(r);
      const partnerOffer = readBoolMask(r);
      return { clientOffer, partnerOffer };
    },
    write: (w, p) => {
      writeBoolMask(w, p.clientOffer);
      writeBoolMask(w, p.partnerOffer);
    },
  },
  TRADEDONE: {
    read: (r) => {
      const code = r.readInt32();
      const description = r.readStr();
      return { code, description };
    },
    write: (w, p) => {
      w.writeInt32(p.code);
      w.writeStr(p.description);
    },
  },
  SERVERPLAYERSHOOT: {
    read: (r) => {
      const bulletId = r.readUnsignedShort();
      const ownerId = r.readInt32();
      const containerType = r.readInt32();
      const startingPos = WorldPos.read(r);
      const angle = r.readFloat();
      const damage = r.readShort();
      const unknownInt = r.readInt32();
      const unknownByte = r.readByte();
      let spellBomb = false;
      let bulletCount = 0;
      let bulletAngle = 0;
      if (r.bytesAvailable() > 0) {
        spellBomb = true;
        bulletCount = r.readByte();
        bulletAngle = r.readFloat();
      }
      return { bulletId, ownerId, containerType, startingPos, angle, damage, unknownInt, unknownByte, spellBomb, bulletCount, bulletAngle };
    },
    write: (w, p) => {
      w.writeUnsignedShort(p.bulletId);
      w.writeInt32(p.ownerId);
      w.writeInt32(p.containerType);
      WorldPos.write(w, p.startingPos);
      w.writeFloat(p.angle);
      w.writeShort(p.damage);
      w.writeInt32(p.unknownInt);
      w.writeByte(p.unknownByte);
      if (p.spellBomb) {
        w.writeByte(p.bulletCount);
        w.writeFloat(p.bulletAngle);
      }
    },
  },
  ENEMYSHOOT: {
    read: (r) => {
      const bulletId = r.readUnsignedShort();
      const ownerId = r.readInt32();
      const bulletType = r.readUnsignedByte();
      const startingPos = WorldPos.read(r);
      const angle = r.readFloat();
      const damage = r.readShort();
      let numShots = 1;
      let angleInc = 0;
      if (r.bytesAvailable() > 0) {
        numShots = r.readUnsignedByte();
        angleInc = r.readFloat();
      }
      return { bulletId, ownerId, bulletType, startingPos, angle, damage, numShots, angleInc };
    },
    write: (w, p) => {
      w.writeUnsignedShort(p.bulletId);
      w.writeInt32(p.ownerId);
      w.writeUnsignedByte(p.bulletType);
      WorldPos.write(w, p.startingPos);
      w.writeFloat(p.angle);
      w.writeShort(p.damage);
      if (p.angleInc !== 0 || p.numShots !== 1) {
        w.writeUnsignedByte(p.numShots);
        w.writeFloat(p.angleInc);
      }
    },
  },
  ACCOUNTLIST: {
    read: (r) => {
      const accountListId = r.readInt32();
      const accountIds = readShortList(r, (rr) => rr.readStr());
      const lockAction = r.readInt32();
      return { accountListId, accountIds, lockAction };
    },
    write: (w, p) => {
      w.writeInt32(p.accountListId);
      w.writeShort(p.accountIds.length);
      for (const id of p.accountIds) w.writeStr(id);
      w.writeInt32(p.lockAction);
    },
  },
  INVRESULT: {
    read: (r) => {
      const unknownBool = r.readBool();
      const unknownByte = r.readByte();
      const fromSlot = SlotObject.read(r);
      const toSlot = SlotObject.read(r);
      const unknownInt1 = r.readInt32();
      const unknownInt2 = r.readInt32();
      return { unknownBool, unknownByte, fromSlot, toSlot, unknownInt1, unknownInt2 };
    },
    write: (w, p) => {
      w.writeBool(p.unknownBool);
      w.writeByte(p.unknownByte);
      SlotObject.write(w, p.fromSlot);
      SlotObject.write(w, p.toSlot);
      w.writeInt32(p.unknownInt1);
      w.writeInt32(p.unknownInt2);
    },
  },
  NOTIFICATION: {
    read: (r) => {
      const p: NotificationPacket = {
        effect: r.readByte(), extra: r.readByte(), message: "", objectId: 0, uiExtra: 0, queuePos: 0,
        color: 0, pictureType: 0, emoteId: 0, unknown1: 0, unknown2: 0,
      };
      switch (p.effect) {
        case 0: case 1: case 2: case 3: p.message = r.readStr(); break;
        case 4: p.message = r.readStr(); p.uiExtra = r.readShort(); break;
        case 5: p.objectId = r.readInt32(); p.queuePos = r.readShort(); break;
        case 6: p.message = r.readStr(); p.objectId = r.readInt32(); p.color = r.readInt32(); break;
        case 7: case 8: p.message = r.readStr(); p.pictureType = r.readInt32(); break;
        case 10: p.message = r.readStr(); p.unknown1 = r.readInt32(); p.unknown2 = r.readShort(); break;
        case 13: p.objectId = r.readInt32(); p.emoteId = r.readInt32(); break;
        default: break;
      }
      return p;
    },
    write: (w, p) => {
      w.writeByte(p.effect);
      w.writeByte(p.extra);
      switch (p.effect) {
        case 0: case 1: case 2: case 3: w.writeStr(p.message); break;
        case 4: w.writeStr(p.message); w.writeShort(p.uiExtra); break;
        case 5: w.writeInt32(p.objectId); w.writeShort(p.queuePos); break;
        case 6: w.writeStr(p.message); w.writeInt32(p.objectId); w.writeInt32(p.color); break;
        case 7: case 8: w.writeStr(p.message); w.writeInt32(p.pictureType); break;
        case 10: w.writeStr(p.message); w.writeInt32(p.unknown1); w.writeShort(p.unknown2); break;
        case 13: w.writeInt32(p.objectId); w.writeInt32(p.emoteId); break;
        default: break;
      }
    },
  },
  DEATH: {
    read: (r) => {
      const accountId = r.readStr();
      const charId = r.readCompressedInt();
      const killedBy = r.readStr();
      const gravestoneType = r.readInt32();
      const totalFame = r.readCompressedInt();
      const fameBonuses = readCompressedList(r, FameBonus.read);
      const pcStats = r.readStr();
      return { accountId, charId, killedBy, gravestoneType, totalFame, fameBonuses, pcStats };
    },
    write: (w, p) => {
      w.writeStr(p.accountId);
      w.writeCompressedInt(p.charId);
      w.writeStr(p.killedBy);
      w.writeInt32(p.gravestoneType);
      w.writeCompressedInt(p.totalFame);
      w.writeCompressedInt(p.fameBonuses.length);
      for (const f of p.fameBonuses) FameBonus.write(w, f);
      w.writeStr(p.pcStats);
    },
  },
  GOTOQUESTROOM: empty,
  CONVERTSEASONALCHARACTER: empty,
  TELEPORT: {
    read: (r) => ({ objectId: r.readInt32(), playerName: r.readStr() }),
    write: (w, p) => {
      w.writeInt32(p.objectId);
      w.writeStr(p.playerName);
    },
  },
  CREATEPARTY: {
    read: (r) => ({
      description: r.readStr(), minPowerLevel: r.readUnsignedShort(), maxPartySize: r.readUnsignedByte(), activity: r.readUnsignedByte(),
      maxedStatReq: r.readUnsignedByte(), privacy: r.readUnsignedByte(), serverIndex: r.readUnsignedByte(),
    }),
    write: (w, p) => {
      w.writeStr(p.description);
      w.writeUnsignedShort(p.minPowerLevel);
      w.writeUnsignedByte(p.maxPartySize);
      w.writeUnsignedByte(p.activity);
      w.writeUnsignedByte(p.maxedStatReq);
      w.writeUnsignedByte(p.privacy);
      w.writeUnsignedByte(p.serverIndex);
    },
  },
  PARTYACTION: {
    read: (r) => ({ playerId: r.readUnsignedShort(), actionId: r.readUnsignedByte() }),
    write: (w, p) => {
      w.writeUnsignedShort(p.playerId);
      w.writeUnsignedByte(p.actionId);
    },
  },
  PARTYACTIONRESULT: {
    read: (r) => ({ playerId: r.readUnsignedShort(), result: r.readUnsignedByte() }),
    write: (w, p) => {
      w.writeUnsignedShort(p.playerId);
      w.writeUnsignedByte(p.result);
    },
  },
  PARTYINVITE: {
    read: (r) => ({ partyId: r.readInt32() >>> 0, inviterName: r.readStr() }),
    write: (w, p) => {
      w.writeInt32(p.partyId | 0);
      w.writeStr(p.inviterName);
    },
  },
  PARTYINVITERESPONSE: {
    read: (r) => ({ partyId: r.readInt32() >>> 0, accept: r.readUnsignedByte() }),
    write: (w, p) => {
      w.writeInt32(p.partyId | 0);
      w.writeUnsignedByte(p.accept);
    },
  },
  PARTYMEMBERINFO: {
    read: (r) => {
      const partyId = r.readInt32() >>> 0;
      const unknownShort = r.readUnsignedShort();
      const maxSize = r.readUnsignedByte();
      const n = r.readUnsignedShort();
      const players: PartyPlayer[] = [];
      for (let i = 0; i < n; i++) players.push(readPartyPlayer(r));
      const description = r.readStr();
      return { partyId, unknownShort, maxSize, players, description };
    },
    write: (w, p) => {
      w.writeInt32(p.partyId | 0);
      w.writeUnsignedShort(p.unknownShort);
      w.writeUnsignedByte(p.maxSize);
      w.writeUnsignedShort(p.players.length);
      for (const x of p.players) writePartyPlayer(w, x);
      w.writeStr(p.description);
    },
  },
  PARTYMEMBERADDED: { read: (r) => readPartyPlayer(r), write: (w, p) => writePartyPlayer(w, p) },
  PARTYLIST: {
    read: (r) => {
      const packetNumber = r.readUnsignedByte();
      const n = r.readUnsignedShort();
      const parties: PartyInfo[] = [];
      for (let i = 0; i < n; i++) {
        parties.push({
          description: r.readStr(), partyId: r.readInt32() >>> 0, minPowerLevel: r.readUnsignedShort(), size: r.readUnsignedByte(), maxSize: r.readUnsignedByte(),
          activity: r.readUnsignedByte(), privacy: r.readUnsignedByte(), minStats: r.readUnsignedByte(), serverIndex: r.readUnsignedByte(),
        });
      }
      return { packetNumber, parties };
    },
    write: (w, p) => {
      w.writeUnsignedByte(p.packetNumber);
      w.writeUnsignedShort(p.parties.length);
      for (const x of p.parties) {
        w.writeStr(x.description);
        w.writeInt32(x.partyId | 0);
        w.writeUnsignedShort(x.minPowerLevel);
        w.writeUnsignedByte(x.size);
        w.writeUnsignedByte(x.maxSize);
        w.writeUnsignedByte(x.activity);
        w.writeUnsignedByte(x.privacy);
        w.writeUnsignedByte(x.minStats);
        w.writeUnsignedByte(x.serverIndex);
      }
    },
  },
  PARTYJOINREQUEST: {
    read: (r) => ({ partyId: r.readInt32() >>> 0, state: r.bytesAvailable() > 0 ? r.readUnsignedByte() : 0 }),
    write: (w, p) => {
      w.writeInt32(p.partyId | 0);
      w.writeUnsignedByte(p.state);
    },
  },
  PARTYJOINREQUESTRESPONSE: {
    read: (r) => ({ name: r.readStr(), classId: r.readUnsignedShort(), skinId: r.readUnsignedShort(), state: r.readUnsignedByte() }),
    write: (w, p) => {
      w.writeStr(p.name);
      w.writeUnsignedShort(p.classId);
      w.writeUnsignedShort(p.skinId);
      w.writeUnsignedByte(p.state);
    },
  },
  CLAIMDAILYLOGINREWARD: {
    read: (r) => ({ claimKey: r.readStr(), claimType: r.readStr() }),
    write: (w, p) => {
      w.writeStr(p.claimKey);
      w.writeStr(p.claimType);
    },
  },
  CLAIMDAILYLOGINRESPONSE: { read: (r) => ({ message: r.readStr() }), write: (w, p) => w.writeStr(p.message) },
  CLAIMREWARDRESULT: {
    read: (r) => ({ success: r.readBool(), claimKey: r.readStr(), claimType: r.readStr() }),
    write: (w, p) => {
      w.writeBool(p.success);
      w.writeStr(p.claimKey);
      w.writeStr(p.claimType);
    },
  },
  VAULTINFO: {
    read: (r) => {
      const list = (): number[] => readCompressedList(r, (rr) => rr.readCompressedInt());
      const last = r.readBool();
      const vaultObjectId = r.readCompressedInt();
      const materialObjectId = r.readCompressedInt();
      const giftObjectId = r.readCompressedInt();
      const potionObjectId = r.readCompressedInt();
      const spoilsObjectId = r.readCompressedInt();
      const vaultContents = list();
      const materialContents = list();
      const giftContents = list();
      const potionContents = list();
      const spoilsContents = list();
      const tail = Buffer.from(r.peek(r.bytesAvailable()));
      return { last, vaultObjectId, materialObjectId, giftObjectId, potionObjectId, spoilsObjectId, vaultContents, materialContents, giftContents, potionContents, spoilsContents, tail };
    },
    write: (w, p) => {
      const list = (xs: number[]): void => {
        w.writeCompressedInt(xs.length);
        for (const x of xs) w.writeCompressedInt(x);
      };
      w.writeBool(p.last);
      w.writeCompressedInt(p.vaultObjectId);
      w.writeCompressedInt(p.materialObjectId);
      w.writeCompressedInt(p.giftObjectId);
      w.writeCompressedInt(p.potionObjectId);
      w.writeCompressedInt(p.spoilsObjectId);
      list(p.vaultContents);
      list(p.materialContents);
      list(p.giftContents);
      list(p.potionContents);
      list(p.spoilsContents);
      for (const b of p.tail) w.writeUnsignedByte(b);
    },
  },
};

export function isKnownPacket(name: string): name is PacketName {
  return Object.prototype.hasOwnProperty.call(CODECS, name);
}
