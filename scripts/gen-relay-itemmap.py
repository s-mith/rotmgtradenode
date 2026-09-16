#!/usr/bin/env python3
"""Export pyrelay's catalog-id <-> Realm object-type maps as JSON.

    python3 scripts/gen-relay-itemmap.py ../rotmgcommunismpyrelay

Legacy: itemMap.json is now also extended in place by scripts/sync-equip.mjs,
so re-running this export drops every id added from equip.xml since.
"""
import json
import os
import sys

PYRELAY = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../rotmgcommunismpyrelay")
sys.path.insert(0, PYRELAY)
from Communism.ItemMap import ID_TO_OBJTYPE, MIN_ENCHANTS  # noqa: E402

dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "relay", "trade", "itemMap.json")
with open(dest, "w") as f:
    json.dump({
        "communism": ID_TO_OBJTYPE,
        "minEnchants": {str(k): v for k, v in MIN_ENCHANTS.items()},
    }, f, indent=1, sort_keys=True)
print(f"wrote {len(ID_TO_OBJTYPE)} curated ids")
