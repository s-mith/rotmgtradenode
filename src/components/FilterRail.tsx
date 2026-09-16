
import { memo } from "react";
import { ItemSprite } from "./ItemSprite";

// The 19 playable classes, in canonical RotMG order, each paired with its
// tier-6 ability item. The ability sprite doubles as the class icon (every
// one resolves in the packed sprite atlas).
const CLASS_ABILITIES: { cls: string; ability: string }[] = [
  { cls: "Rogue", ability: "Cloak of Ghostly Concealment" },
  { cls: "Archer", ability: "Quiver of Elvish Mastery" },
  { cls: "Wizard", ability: "Elemental Detonation Spell" },
  { cls: "Priest", ability: "Tome of Holy Guidance" },
  { cls: "Warrior", ability: "Helm of the Great General" },
  { cls: "Knight", ability: "Colossus Shield" },
  { cls: "Paladin", ability: "Seal of the Blessed Champion" },
  { cls: "Assassin", ability: "Baneserpent Poison" },
  { cls: "Necromancer", ability: "Bloodsucker Skull" },
  { cls: "Huntress", ability: "Giantcatcher Trap" },
  { cls: "Mystic", ability: "Planefetter Orb" },
  { cls: "Trickster", ability: "Prism of Apparitions" },
  { cls: "Sorcerer", ability: "Scepter of Storms" },
  { cls: "Ninja", ability: "Doom Circle" },
  { cls: "Samurai", ability: "Royal Wakizashi" },
  { cls: "Bard", ability: "Skyward Lute" },
  { cls: "Summoner", ability: "Sovereign Mace" },
  { cls: "Kensei", ability: "Great Shinobi Sheath" },
  { cls: "Druid", ability: "Sigil of the Horse" },
];

// Slot filters, each keyed to the `slot` tag on catalog items. The icon is a
// representative item for that slot (T13 sword, T6 shield, T13 armor, T6 ring).
const SLOT_ICONS: { slot: string; label: string; icon: string }[] = [
  { slot: "weapon", label: "Weapon", icon: "Sword of Splendor" },
  { slot: "ability", label: "Ability", icon: "Colossus Shield" },
  { slot: "armor", label: "Armor", icon: "Dominion Armor" },
  { slot: "ring", label: "Ring", icon: "Ring of Unbound Health" },
];

// Consumable filters, keyed to the catalog category. These aren't gear, so
// they live outside the class/slot pair: picking one clears class and slot,
// and picking a class or slot clears this (see Vault).
export type ConsumableKind = "potion" | "egg";
const CONSUMABLE_ICONS: { kind: ConsumableKind; label: string; icon: string }[] = [
  { kind: "potion", label: "Potions", icon: "Potion of Life" },
  { kind: "egg", label: "Eggs", icon: "Rare ???? Egg" },
];

function RailButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={"class-rail-btn" + (active ? " active" : "")}
      aria-pressed={active}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <ItemSprite name={icon} className="class-rail-icon" />
    </button>
  );
}

// Filter rail pinned to the left of the pool: a labelled 2-icon-wide grid of
// class buttons, then a labelled grid of slot buttons, then the consumables.
// Class and slot are toggles that combine (class AND slot) when applied to
// the grid; a consumable is a toggle that stands alone.
export const FilterRail = memo(function FilterRail({
  selectedClass,
  onSelectClass,
  selectedSlot,
  onSelectSlot,
  selectedConsumable,
  onSelectConsumable,
}: {
  selectedClass: string | null;
  onSelectClass: (cls: string | null) => void;
  selectedSlot: string | null;
  onSelectSlot: (slot: string | null) => void;
  selectedConsumable: ConsumableKind | null;
  onSelectConsumable: (kind: ConsumableKind | null) => void;
}) {
  return (
    <div className="class-rail">
      <div className="class-rail-label">Class</div>
      <div className="class-rail-group" role="group" aria-label="Filter by class">
        {CLASS_ABILITIES.map(({ cls, ability }) => (
          <RailButton
            key={cls}
            active={selectedClass === cls}
            label={cls}
            icon={ability}
            onClick={() => onSelectClass(selectedClass === cls ? null : cls)}
          />
        ))}
      </div>
      <div className="class-rail-label">Slot</div>
      <div className="class-rail-group" role="group" aria-label="Filter by slot">
        {SLOT_ICONS.map(({ slot, label, icon }) => (
          <RailButton
            key={slot}
            active={selectedSlot === slot}
            label={label}
            icon={icon}
            onClick={() => onSelectSlot(selectedSlot === slot ? null : slot)}
          />
        ))}
      </div>
      <div className="class-rail-label">Consumables</div>
      <div className="class-rail-group" role="group" aria-label="Filter by consumable">
        {CONSUMABLE_ICONS.map(({ kind, label, icon }) => (
          <RailButton
            key={kind}
            active={selectedConsumable === kind}
            label={label}
            icon={icon}
            onClick={() => onSelectConsumable(selectedConsumable === kind ? null : kind)}
          />
        ))}
      </div>
    </div>
  );
});
