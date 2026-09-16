#!/usr/bin/env python3
"""Fleet-policy fixtures from the ORIGINAL pyrelay code: proxy pinning,
bot-guid derivation, signed API bodies. (The potion planner diverged from
pyrelay's on purpose — scoring, swaps, demand — and has its own tests.)

    python3 scripts/gen-relay-fleet-fixtures.py ../rotmgcommunismpyrelay
"""
import json
import os
import sys

PYRELAY = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../rotmgcommunismpyrelay")
sys.path.insert(0, PYRELAY)
os.chdir(PYRELAY)

from Communism.BotPool import derive_bot_guid  # noqa: E402
from Communism.Api import CommunismApi  # noqa: E402
from hashlib import md5  # noqa: E402

out = {"guids": [], "pins": [], "api": []}

for email in ["a@example.com", "Bot.Seven+x@mail.test", "ünïcode@example.com"]:
    out["guids"].append({"email": email, "botGuid": derive_bot_guid(email)})

hosts = [f"10.0.0.{i}" for i in range(1, 13)]
for guid in ["a@example.com", "b@example.com", "c@example.com"]:
    key = guid.encode("utf-8")
    pref = sorted(hosts, key=lambda h: md5(h.encode("utf-8") + key).digest(), reverse=True)
    out["pins"].append({"guid": guid, "hosts": hosts, "preference": pref})

SECRET = "s" * 40
class Capture(CommunismApi):
    def __init__(self):
        super().__init__("http://site", SECRET)
        self.calls = []
    def _now_ms(self):
        return 1700000000000
    def _nonce(self):
        return "fixednonce_0123456789"
    def _post(self, path, body):
        self.calls.append({"path": path, "body": body})
        return {"ok": True}

api = Capture()
api.heartbeat("botguid1", "Alias", "IgnName", "USEast", 7, "idle", seasonal=False)
api.claim_deposit("botguid1", free_slots=5)
api.claim_deposit("botguid1")
api.claim_withdraw("botguid1", [{"itemId": "patk", "qty": 2}, {"itemId": "ubatk", "qty": 1}], ["inst-b", "inst-a"])
api.fulfill_deposit("botguid1", 42, [{"itemId": "ubatk", "qty": 1}, {"itemId": "patk", "qty": 2}], units=[{"itemId": "patk", "enchants": 0}, {"itemId": "ubatk", "enchants": 2}, {"itemId": "patk", "enchants": 0}])
api.fulfill_deposit("botguid1", 43, [{"itemId": "patk", "qty": 1}])
api.fulfill_withdraw("botguid1", 44, [{"itemId": "ubatk", "qty": 1}], instance_ids=["z-inst", "a-inst"])
api.fulfill_withdraw("botguid1", 45, [{"itemId": "ubatk", "qty": 1}])
api.register_pool(123)
api.unclaim("botguid1", 46, "deposit")
api.give_up("botguid1", 47, "withdraw")
api.list_pending()
out["api"] = {"secret": SECRET, "now": 1700000000000, "nonce": "fixednonce_0123456789", "calls": api.calls}

dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "relay", "fleet", "__tests__", "fixtures.json")
os.makedirs(os.path.dirname(dest), exist_ok=True)
with open(dest, "w") as f:
    json.dump(out, f, indent=1)
print(f"wrote {len(out['guids'])} guids, {len(out['pins'])} pins, {len(out['api']['calls'])} api calls")
