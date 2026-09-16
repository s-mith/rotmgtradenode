// Every standard dungeon key in the game, for the Raids tab. Generated from
// RealmEye's dungeon-keys wiki page (2026-09-12) plus the Time Chamber from
// realm.wiki (item 53200, object 53181); images are copies under public/raids/.
export interface RaidDungeon {
  id: string;
  /** The key's item name. */
  key: string;
  /** The dungeon it opens. */
  dungeon: string;
  /** Player limit: Realm refuses entry past it ("Dungeon is full"). 50 unless the dungeon says otherwise. */
  limit: number;
  /** The portal object the key opens (its CreatePortal activate; scripts/raid-portals.mjs). null: unknown, so a pop cannot be verified. */
  portalType: number | null;
  keyImg: string;
  portalImg: string | null;
}

export const RAID_DUNGEONS: RaidDungeon[] = [
  { id: "pirate-cave-key", limit: 50, portalType: 0x0717, key: "Pirate Cave Key", dungeon: "Pirate Cave", keyImg: "/raids/keys/pirate-cave-key.png", portalImg: "/raids/portals/pirate-cave.png" },
  { id: "forest-maze-key", limit: 50, portalType: 0x5f34, key: "Forest Maze Key", dungeon: "Forest Maze", keyImg: "/raids/keys/forest-maze-key.png", portalImg: "/raids/portals/forest-maze.png" },
  { id: "spider-den-key", limit: 50, portalType: 0x0719, key: "Spider Den Key", dungeon: "Spider Den", keyImg: "/raids/keys/spider-den-key.png", portalImg: "/raids/portals/spider-den.png" },
  { id: "totem-key", limit: 50, portalType: 0x0733, key: "Totem Key", dungeon: "Forbidden Jungle", keyImg: "/raids/keys/totem-key.png", portalImg: "/raids/portals/forbidden-jungle.png" },
  { id: "the-hive-key", limit: 50, portalType: 0x011d, key: "The Hive Key", dungeon: "The Hive", keyImg: "/raids/keys/the-hive-key.png", portalImg: "/raids/portals/the-hive.png" },
  { id: "treasure-map", limit: 50, portalType: 0x5e2e, key: "Treasure Map", dungeon: "Cave of a Thousand Treasures", keyImg: "/raids/keys/treasure-map.png", portalImg: "/raids/portals/cave-of-a-thousand-treasures.png" },
  { id: "snake-pit-key", limit: 50, portalType: 0x0718, key: "Snake Pit Key", dungeon: "Snake Pit", keyImg: "/raids/keys/snake-pit-key.png", portalImg: "/raids/portals/snake-pit.gif" },
  { id: "sprite-world-key", limit: 50, portalType: 0x070c, key: "Sprite World Key", dungeon: "Sprite World", keyImg: "/raids/keys/sprite-world-key.png", portalImg: "/raids/portals/sprite-world.png" },
  { id: "ancient-ruins-key", limit: 50, portalType: 0x25b9, key: "Ancient Ruins Key", dungeon: "Ancient Ruins", keyImg: "/raids/keys/ancient-ruins-key.png", portalImg: "/raids/portals/ancient-ruins.png" },
  { id: "magic-woods-key", limit: 50, portalType: 0x087c, key: "Magic Woods Key", dungeon: "Magic Woods", keyImg: "/raids/keys/magic-woods-key.png", portalImg: "/raids/portals/magic-woods.png" },
  { id: "candy-key", limit: 50, portalType: 0x074a, key: "Candy Key", dungeon: "Candyland Hunting Grounds", keyImg: "/raids/keys/candy-key.png", portalImg: "/raids/portals/candyland-hunting-grounds.png" },
  { id: "undead-lair-key", limit: 50, portalType: 0x071a, key: "Undead Lair Key", dungeon: "Undead Lair", keyImg: "/raids/keys/undead-lair-key.png", portalImg: "/raids/portals/undead-lair.gif" },
  { id: "theatre-key", limit: 50, portalType: 0x2353, key: "Theatre Key", dungeon: "Puppet Master\u2019s Theatre", keyImg: "/raids/keys/theatre-key.png", portalImg: "/raids/portals/puppet-masters-theatre.png" },
  { id: "toxic-sewers-key", limit: 50, portalType: 0x023e, key: "Toxic Sewers Key", dungeon: "Toxic Sewers", keyImg: "/raids/keys/toxic-sewers-key.png", portalImg: "/raids/portals/toxic-sewers.png" },
  { id: "cursed-library-key", limit: 50, portalType: 0xab56, key: "Cursed Library Key", dungeon: "Cursed Library", keyImg: "/raids/keys/cursed-library-key.png", portalImg: "/raids/portals/cursed-library.gif" },
  { id: "lab-key", limit: 50, portalType: 0x0890, key: "Lab Key", dungeon: "Mad Lab", keyImg: "/raids/keys/lab-key.png", portalImg: "/raids/portals/mad-lab.gif" },
  { id: "abyss-of-demons-key", limit: 50, portalType: 0x071b, key: "Abyss of Demons Key", dungeon: "Abyss of Demons", keyImg: "/raids/keys/abyss-of-demons-key.png", portalImg: "/raids/portals/abyss-of-demons.gif" },
  { id: "manor-key", limit: 50, portalType: 0x0739, key: "Manor Key", dungeon: "Manor of the Immortals", keyImg: "/raids/keys/manor-key.png", portalImg: "/raids/portals/manor-of-the-immortals.png" },
  { id: "cemetery-key", limit: 50, portalType: 0x074b, key: "Cemetery Key", dungeon: "Haunted Cemetery", keyImg: "/raids/keys/cemetery-key.png", portalImg: "/raids/portals/haunted-cemetery.gif" },
  { id: "the-machine-key", limit: 50, portalType: 0xabd2, key: "The Machine Key", dungeon: "The Machine", keyImg: "/raids/keys/the-machine-key.png", portalImg: "/raids/portals/the-machine.png" },
  { id: "beachzone-key", limit: 50, portalType: 0x0742, key: "Beachzone Key", dungeon: "Beachzone", keyImg: "/raids/keys/beachzone-key.png", portalImg: "/raids/portals/beachzone.png" },
  { id: "davys-key", limit: 50, portalType: 0x0741, key: "Davy's Key", dungeon: "Davy Jones\u2019 Locker", keyImg: "/raids/keys/davys-key.png", portalImg: "/raids/portals/davy-jones-locker.png" },
  { id: "ocean-trench-key", limit: 50, portalType: 0x0730, key: "Ocean Trench Key", dungeon: "Ocean Trench", keyImg: "/raids/keys/ocean-trench-key.png", portalImg: "/raids/portals/ocean-trench.png" },
  { id: "ice-cave-key", limit: 50, portalType: 0x748b, key: "Ice Cave Key", dungeon: "Ice Cave", keyImg: "/raids/keys/ice-cave-key.png", portalImg: "/raids/portals/ice-cave.png" },
  { id: "the-crawling-depths-key", limit: 50, portalType: 0x072e, key: "The Crawling Depths Key", dungeon: "The Crawling Depths", keyImg: "/raids/keys/the-crawling-depths-key.png", portalImg: "/raids/portals/the-crawling-depths.gif" },
  { id: "woodland-labyrinth-key", limit: 50, portalType: 0x075c, key: "Woodland Labyrinth Key", dungeon: "Woodland Labyrinth", keyImg: "/raids/keys/woodland-labyrinth-key.png", portalImg: "/raids/portals/woodland-labyrinth.gif" },
  { id: "deadwater-docks-key", limit: 50, portalType: 0x075d, key: "Deadwater Docks Key", dungeon: "Deadwater Docks", keyImg: "/raids/keys/deadwater-docks-key.png", portalImg: "/raids/portals/deadwater-docks.png" },
  { id: "puppet-masters-encore-key", limit: 25, portalType: 0x7466, key: "Puppet Master's Encore Key", dungeon: "Puppet Master\u2019s Encore", keyImg: "/raids/keys/puppet-masters-encore-key.png", portalImg: "/raids/portals/puppet-masters-encore.png" },
  { id: "reef-key", limit: 25, portalType: 0x09fa, key: "Reef Key", dungeon: "Reef Key", keyImg: "/raids/keys/reef-key.png", portalImg: "/raids/portals/reef-key.png" },
  { id: "parasite-chambers-key", limit: 50, portalType: 0x0798, key: "Parasite Chambers Key", dungeon: "Parasite Chambers", keyImg: "/raids/keys/parasite-chambers-key.png", portalImg: "/raids/portals/parasite-chambers.gif" },
  { id: "the-tavern-key", limit: 25, portalType: 0x4550, key: "The Tavern Key", dungeon: "The Tavern", keyImg: "/raids/keys/the-tavern-key.png", portalImg: "/raids/portals/the-tavern.png" },
  { id: "sulfurous-wetlands-key", limit: 50, portalType: 0x6392, key: "Sulfurous Wetlands Key", dungeon: "Sulfurous Wetlands", keyImg: "/raids/keys/sulfurous-wetlands-key.png", portalImg: "/raids/portals/sulfurous-wetlands.png" },
  { id: "mountain-temple-key", limit: 50, portalType: 0x0137, key: "Mountain Temple Key", dungeon: "Mountain Temple", keyImg: "/raids/keys/mountain-temple-key.png", portalImg: "/raids/portals/mountain-temple.png" },
  { id: "draconis-key", limit: 50, portalType: 0xb217, key: "Draconis Key", dungeon: "Lair of Draconis", keyImg: "/raids/keys/draconis-key.png", portalImg: "/raids/portals/lair-of-draconis.png" },
  { id: "tomb-of-the-ancients-key", limit: 50, portalType: 0x0734, key: "Tomb of the Ancients Key", dungeon: "Tomb of the Ancients", keyImg: "/raids/keys/tomb-of-the-ancients-key.png", portalImg: "/raids/portals/tomb-of-the-ancients.png" },
  { id: "the-third-dimension-key", limit: 50, portalType: 0x4b66, key: "The Third Dimension Key", dungeon: "The Third Dimension", keyImg: "/raids/keys/the-third-dimension-key.png", portalImg: "/raids/portals/the-third-dimension.png" },
  { id: "shaitans-key", limit: 25, portalType: 0x6d99, key: "Shaitan's Key", dungeon: "Lair of Shaitan", keyImg: "/raids/keys/shaitans-key.png", portalImg: "/raids/portals/lair-of-shaitan.png" },
  { id: "heroic-undead-lair-key", limit: 50, portalType: 0x3962, key: "Heroic Undead Lair Key", dungeon: "Heroic Undead Lair", keyImg: "/raids/keys/heroic-undead-lair-key.png", portalImg: "/raids/portals/heroic-undead-lair.png" },
  { id: "infernal-abyss-of-demons-key", limit: 50, portalType: 0x3a0d, key: "Infernal Abyss of Demons Key", dungeon: "Infernal Abyss of Demons", keyImg: "/raids/keys/infernal-abyss-of-demons-key.png", portalImg: "/raids/portals/infernal-abyss-of-demons.png" },
  { id: "secluded-thicket-key", limit: 25, portalType: 0x369f, key: "Secluded Thicket Key", dungeon: "Secluded Thicket", keyImg: "/raids/keys/secluded-thicket-key.png", portalImg: "/raids/portals/secluded-thicket.png" },
  { id: "high-tech-terror-key", limit: 25, portalType: 0x3d72, key: "High Tech Terror Key", dungeon: "High Tech Terror", keyImg: "/raids/keys/high-tech-terror-key.png", portalImg: "/raids/portals/high-tech-terror.png" },
  { id: "ice-citadel-key", limit: 50, portalType: 0x9cfd, key: "Ice Citadel Key", dungeon: "Ice Citadel", keyImg: "/raids/keys/ice-citadel-key.png", portalImg: "/raids/portals/ice-citadel.png" },
  { id: "fungal-cavern-key", limit: 50, portalType: 0xb26f, key: "Fungal Cavern Key", dungeon: "Fungal Cavern", keyImg: "/raids/keys/fungal-cavern-key.png", portalImg: "/raids/portals/fungal-cavern.png" },
  { id: "the-nest-key", limit: 50, portalType: 0x10a3, key: "The Nest Key", dungeon: "The Nest", keyImg: "/raids/keys/the-nest-key.png", portalImg: "/raids/portals/the-nest.png" },
  { id: "kogbold-steamworks-key", limit: 50, portalType: 0xc119, key: "Kogbold Steamworks Key", dungeon: "Kogbold Steamworks", keyImg: "/raids/keys/kogbold-steamworks-key.png", portalImg: "/raids/portals/kogbold-steamworks.png" },
  { id: "shatters-key", limit: 50, portalType: 0x727e, key: "Shatters Key", dungeon: "The Shatters", keyImg: "/raids/keys/shatters-key.png", portalImg: "/raids/portals/the-shatters.png" },
  { id: "lost-halls-key", limit: 50, portalType: 0xb024, key: "Lost Halls Key", dungeon: "Lost Halls", keyImg: "/raids/keys/lost-halls-key.png", portalImg: "/raids/portals/lost-halls.png" },
  { id: "moonlight-village-key", limit: 50, portalType: 0x4fdf, key: "Moonlight Village Key", dungeon: "Moonlight Village", keyImg: "/raids/keys/moonlight-village-key.png", portalImg: "/raids/portals/moonlight-village.png" },
  { id: "spectral-penitentiary-key", limit: 25, portalType: 0x5c8b, key: "Spectral Penitentiary Key", dungeon: "Spectral Penitentiary", keyImg: "/raids/keys/spectral-penitentiary-key.png", portalImg: "/raids/portals/spectral-penitentiary.png" },
  { id: "advanced-kogbold-steamworks-key", limit: 50, portalType: 0x7096, key: "Advanced Kogbold Steamworks Key", dungeon: "Advanced Kogbold Steamworks", keyImg: "/raids/keys/advanced-kogbold-steamworks-key.png", portalImg: "/raids/portals/advanced-kogbold-steamworks.png" },
  { id: "plagued-nest-key", limit: 50, portalType: null, key: "Plagued Nest Key", dungeon: "Plagued Nest", keyImg: "/raids/keys/plagued-nest-key.png", portalImg: "/raids/portals/plagued-nest.png" },
  { id: "malogia-key", limit: 25, portalType: 0xb2b8, key: "Malogia Key", dungeon: "Malogia", keyImg: "/raids/keys/malogia-key.png", portalImg: "/raids/portals/malogia.png" },
  { id: "untaris-key", limit: 25, portalType: 0xb2b7, key: "Untaris Key", dungeon: "Untaris", keyImg: "/raids/keys/untaris-key.png", portalImg: "/raids/portals/untaris.png" },
  { id: "forax-key", limit: 25, portalType: 0xb2cb, key: "Forax Key", dungeon: "Forax", keyImg: "/raids/keys/forax-key.png", portalImg: "/raids/portals/forax.png" },
  { id: "katalund-key", limit: 25, portalType: 0xb2ce, key: "Katalund Key", dungeon: "Katalund", keyImg: "/raids/keys/katalund-key.png", portalImg: "/raids/portals/katalund.png" },
  { id: "neo-malogia-key", limit: 25, portalType: 0xdc61, key: "Neo Malogia Key", dungeon: "Neo Malogia", keyImg: "/raids/keys/neo-malogia-key.png", portalImg: "/raids/portals/neo-malogia.png" },
  { id: "neo-untaris-key", limit: 25, portalType: 0xdc62, key: "Neo Untaris Key", dungeon: "Neo Untaris", keyImg: "/raids/keys/neo-untaris-key.png", portalImg: "/raids/portals/neo-untaris.png" },
  { id: "neo-forax-key", limit: 25, portalType: 0xdc63, key: "Neo Forax Key", dungeon: "Neo Forax", keyImg: "/raids/keys/neo-forax-key.png", portalImg: "/raids/portals/neo-forax.png" },
  { id: "neo-katalund-key", limit: 25, portalType: 0xdc64, key: "Neo Katalund Key", dungeon: "Neo Katalund", keyImg: "/raids/keys/neo-katalund-key.png", portalImg: "/raids/portals/neo-katalund.png" },
  { id: "legacy-heroic-undead-lair-key", limit: 15, portalType: 0x246b, key: "Legacy Heroic Undead Lair Key", dungeon: "Legacy Heroic Undead Lair", keyImg: "/raids/keys/legacy-heroic-undead-lair-key.png", portalImg: "/raids/portals/legacy-heroic-undead-lair.gif" },
  { id: "legacy-heroic-abyss-of-demons-key", limit: 15, portalType: 0x246c, key: "Legacy Heroic Abyss of Demons Key", dungeon: "Legacy Heroic Abyss of Demons", keyImg: "/raids/keys/legacy-heroic-abyss-of-demons-key.png", portalImg: "/raids/portals/legacy-heroic-abyss-of-demons.png" },
  { id: "battle-nexus-key", limit: 50, portalType: 0x075e, key: "Battle Nexus Key", dungeon: "Battle for the Nexus", keyImg: "/raids/keys/battle-nexus-key.png", portalImg: "/raids/portals/battle-for-the-nexus.png" },
  { id: "bellas-key", limit: 50, portalType: 0x2291, key: "Bella's Key", dungeon: "Belladonna\u2019s Garden", keyImg: "/raids/keys/bellas-key.png", portalImg: "/raids/portals/belladonnas-garden.png" },
  { id: "ice-tomb-key", limit: 50, portalType: 0x7fb8, key: "Ice Tomb Key", dungeon: "Ice Tomb", keyImg: "/raids/keys/ice-tomb-key.png", portalImg: "/raids/portals/ice-tomb.png" },
  { id: "st-patricks-key", limit: 50, portalType: 0x1648, key: "St. Patricks Key", dungeon: "Rainbow Road", keyImg: "/raids/keys/st-patricks-key.png", portalImg: "/raids/portals/rainbow-road.png" },
  { id: "mad-god-mayhem-key", limit: 50, portalType: 0x0f21, key: "Mad God Mayhem Key", dungeon: "Mad God Mayhem", keyImg: "/raids/keys/mad-god-mayhem-key.png", portalImg: "/raids/portals/mad-god-mayhem.gif" },
  { id: "hidden-interregnum-key", limit: 15, portalType: 0xc268, key: "Hidden Interregnum Key", dungeon: "Hidden Interregnum", keyImg: "/raids/keys/hidden-interregnum-key.png", portalImg: "/raids/portals/hidden-interregnum.png" },
  { id: "queen-bunny-chamber-key", limit: 50, portalType: 0x0596, key: "Queen Bunny Chamber Key", dungeon: "Queen Bunny Chamber", keyImg: "/raids/keys/queen-bunny-chamber-key.png", portalImg: "/raids/portals/queen-bunny-chamber.png" },
  { id: "white-snake-invasion-i-key", limit: 50, portalType: 0xe9ee, key: "White Snake Invasion I Key", dungeon: "White Snake Invasion I", keyImg: "/raids/keys/white-snake-invasion-i-key.png", portalImg: "/raids/portals/white-snake-invasion-i.png" },
  { id: "white-snake-invasion-ii-key", limit: 50, portalType: 0xe9ef, key: "White Snake Invasion II Key", dungeon: "White Snake Invasion II", keyImg: "/raids/keys/white-snake-invasion-ii-key.png", portalImg: "/raids/portals/white-snake-invasion-ii.png" },
  { id: "white-snake-invasion-iii-key", limit: 20, portalType: 0xe9f0, key: "White Snake Invasion III Key", dungeon: "White Snake Invasion III", keyImg: "/raids/keys/white-snake-invasion-iii-key.png", portalImg: "/raids/portals/white-snake-invasion-iii.png" },
  { id: "the-trials-of-cronus", limit: 50, portalType: 0x332c, key: "The Trials of Cronus", dungeon: "The Trials of Cronus", keyImg: "/raids/keys/the-trials-of-cronus.png", portalImg: "/raids/portals/the-trials-of-cronus.png" },
  { id: "stromwells-rift-i-key", limit: 85, portalType: 0x3321, key: "Stromwell's Rift I Key", dungeon: "Stromwell\u2019s Rift I", keyImg: "/raids/keys/stromwells-rift-i-key.png", portalImg: "/raids/portals/stromwells-rift-i.png" },
  { id: "stromwells-rift-ii-key", limit: 85, portalType: 0x3322, key: "Stromwell's Rift II Key", dungeon: "Stromwell\u2019s Rift II", keyImg: "/raids/keys/stromwells-rift-ii-key.png", portalImg: "/raids/portals/stromwells-rift-ii.png" },
  { id: "stromwells-rift-iii-key", limit: 85, portalType: 0x3323, key: "Stromwell's Rift III Key", dungeon: "Stromwell\u2019s Rift III", keyImg: "/raids/keys/stromwells-rift-iii-key.png", portalImg: "/raids/portals/stromwells-rift-iii.png" },
  { id: "time-chamber-key", limit: 50, portalType: 0xcfbd, key: "Time Chamber Key", dungeon: "Time Chamber", keyImg: "/raids/keys/time-chamber.png", portalImg: "/raids/portals/time-chamber.png" },
];
