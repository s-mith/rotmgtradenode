// The bot's own character, folded from UPDATE/NEWTICK stat lists.
import { Stat } from "../protocol/stats";
import { decodeEnchantStat } from "../protocol/enchants";
import type { ObjectData, StatData, WorldPos } from "../protocol/data";

export const INV_SLOTS = 28; // 4 equipment + 8 main + up to 16 backpack (stats 131-146)

export class PlayerData {
  name = "";
  level = 0;
  accountId = "";
  characterClass = 0;
  objectId = 0;
  pos: WorldPos | null = null;
  hp = 0;
  maxHp = 0;
  mp = 0;
  maxMp = 0;
  spd = 0;
  spdBoost = 0;
  dex = 0;
  dexBoost = 0;
  condition = 0;
  nameChosen = false;
  guildName = "";
  /** Object type per slot, -1 when empty. */
  inv: number[] = Array(INV_SLOTS).fill(-1);
  /** Enchant ids per slot, aligned with `inv`. */
  enchantments: number[][] = Array.from({ length: INV_SLOTS }, () => []);
  /** True once the ENCHANTMENTS stat has arrived; it lags the inventory ints. */
  enchantmentsSeen = false;
  /** HAS_BACKPACK stat (79) as last reported, or null if it never arrived. */
  backpackStat: boolean | null = null;
  /** Sticky: an item was seen in a backpack slot, which only a backpack has. */
  private backpackItemSeen = false;
  /** Sticky: an item was seen in backpack slots 8-15, which only the 16-slot backpack has. */
  private wideBackpackSeen = false;
  /** char/list BackpackSlots (0, 8 or 16) when the client read it; null before. */
  knownBackpackSlots: number | null = null;

  /**
   * Whether this character has a backpack. Realm's evidence is messy: stat
   * 79 doesn't arrive for every account, and the BACKPACK_* slot stats show
   * up as -1 for characters with no backpack at all, so "any backpack stat
   * seen" is a false positive. Trust only a positive stat 79 or an item
   * actually occupying a backpack slot; otherwise assume 8 slots.
   */
  get hasBackpack(): boolean {
    return this.backpackStat === true || this.backpackItemSeen;
  }
  /**
   * Backpack slots this character trades with: 16 once an item was seen past
   * the eighth (or char/list said 16), else 8 with a backpack, else 0. The
   * 16-slot backpack is the upgraded one (live 2026-09-17: stat 144, backpack
   * slot 13, in use on a character).
   */
  get backpackSlots(): number {
    if (this.wideBackpackSeen || this.knownBackpackSlots === 16) return 16;
    return this.hasBackpack ? 8 : 0;
  }
  /** Trade slots: the 8 main ones plus the backpack's. */
  get tradeSlots(): number {
    return 8 + this.backpackSlots;
  }

  applyObject(obj: ObjectData): void {
    this.characterClass = obj.objectType;
    this.pos = obj.status.pos;
    this.objectId = obj.status.objectId;
    this.applyStats(obj.status.stats);
  }

  applyStats(stats: StatData[]): void {
    for (const s of stats) {
      const t = s.statType;
      if (t >= Stat.INVENTORY0 && t <= Stat.INVENTORY11) {
        this.inv[t - Stat.INVENTORY0] = s.statValue;
        continue;
      }
      if (t >= Stat.BACKPACK0 && t <= Stat.BACKPACK15) {
        const i = t - Stat.BACKPACK0;
        this.inv[12 + i] = s.statValue;
        if (s.statValue !== -1) {
          this.backpackItemSeen = true;
          if (i >= 8) this.wideBackpackSeen = true;
        }
        continue;
      }
      switch (t) {
        case Stat.NAME: this.name = s.strStatValue; break;
        case Stat.LEVEL: this.level = s.statValue; break;
        case Stat.ACCOUNTID: this.accountId = s.strStatValue; break;
        case Stat.HP: this.hp = s.statValue; break;
        case Stat.MAXHP: this.maxHp = s.statValue; break;
        case Stat.MP: this.mp = s.statValue; break;
        case Stat.MAXMP: this.maxMp = s.statValue; break;
        case Stat.SPEED: this.spd = s.statValue; break;
        case Stat.SPEEDBOOST: this.spdBoost = s.statValue; break;
        case Stat.DEXTERITY: this.dex = s.statValue; break;
        case Stat.DEXTERITYBOOST: this.dexBoost = s.statValue; break;
        case Stat.CONDITION: this.condition = s.statValue; break;
        case Stat.NAMECHOSEN: this.nameChosen = s.statValue !== 0; break;
        case Stat.GUILDNAME: this.guildName = s.strStatValue; break;
        case Stat.HASBACKPACK: this.backpackStat = s.statValue === 1; break;
        case Stat.ENCHANTMENTS:
          this.enchantments = decodeEnchantStat(s.strStatValue);
          this.enchantmentsSeen = true;
          break;
        default: break;
      }
    }
  }

  /** Occupied trade slots (main + backpack), as {slot -> [objectType, enchants]}. */
  occupiedSlots(): Map<number, { objectType: number; enchantments: number[] }> {
    const out = new Map<number, { objectType: number; enchantments: number[] }>();
    for (let i = 4; i < INV_SLOTS; i++) {
      if (this.inv[i] !== -1) out.set(i, { objectType: this.inv[i], enchantments: this.enchantments[i] ?? [] });
    }
    return out;
  }

  freeSlots(): number {
    const cap = this.tradeSlots;
    let used = 0;
    for (let i = 4; i < 4 + cap; i++) if (this.inv[i] !== -1) used++;
    return cap - used;
  }
}
