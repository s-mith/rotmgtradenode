#!/usr/bin/env python3
"""Generate protocol fixtures from the ORIGINAL pyrelay packet code.

    python3 scripts/gen-relay-fixtures.py ../rotmgcommunismpyrelay

Writes src/relay/protocol/__tests__/fixtures.json. The vitest suite decodes
each frame with the TypeScript codecs and re-encodes it, so the port is
proven byte-for-byte against the implementation the fleet runs today.
"""
import base64
import json
import os
import struct
import sys

PYRELAY = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../rotmgcommunismpyrelay")
sys.path.insert(0, PYRELAY)
os.chdir(PYRELAY)

import Crypto.RC4 as RC4  # noqa: E402
import Networking.Writer as W  # noqa: E402
from Networking.PacketHelper import createPacket  # noqa: E402
import Constants.PacketIds as PacketId  # noqa: E402
from Data.WorldPosData import WorldPosData  # noqa: E402
from Data.MoveRecord import MoveRecord  # noqa: E402
from Data.StatData import StatData  # noqa: E402
from Data.ObjectStatusData import ObjectStatusData  # noqa: E402
from Data.ObjectData import ObjectData  # noqa: E402
from Data.GroundTileData import GroundTileData  # noqa: E402
from Data.SlotObjectData import SlotObjectData  # noqa: E402
from Data.TradeItem import TradeItem  # noqa: E402
from Data.FameData import FameData  # noqa: E402
from Communism.ItemMap import enchant_count  # noqa: E402


def pos(d):
    return WorldPosData(d["x"], d["y"])


def stat(d):
    return StatData(d["statType"], d["statValue"], d["strStatValue"], d["secondaryValue"])


def status(d):
    return ObjectStatusData(d["objectId"], pos(d["pos"]), [stat(s) for s in d["stats"]])


def obj(d):
    return ObjectData(d["objectType"], status(d["status"]))


def tile(d):
    return GroundTileData(d["x"], d["y"], d["type"])


def slot(d):
    return SlotObjectData(d["objectId"], d["slotId"], d["objectType"])


def titem(d):
    return TradeItem(d["item"], d["slotType"], d["tradeable"], d["included"], d["enchantment"])


def fame(d):
    return FameData(d["name"], d["rank"], d["fame"])


def mrec(d):
    return MoveRecord(d["time"], d["pos"]["x"], d["pos"]["y"])


def signed(bs):
    return [b - 256 if b > 127 else b for b in bs]


# TS field name -> (python attr, converter)
CONVERT = {
    "pcStats": ("PCStats", None),
    "key": ("key", signed),
    "pos": ("pos", pos),
    "position": ("position", pos),
    "startingPos": ("startingPos", pos),
    "records": ("records", lambda v: [mrec(x) for x in v]),
    "tiles": ("tiles", lambda v: [tile(x) for x in v]),
    "newObjs": ("newObjs", lambda v: [obj(x) for x in v]),
    "statuses": ("statuses", lambda v: [status(x) for x in v]),
    "slotObject1": ("slotObject1", slot),
    "slotObject2": ("slotObject2", slot),
    "fromSlot": ("fromSlot", slot),
    "toSlot": ("toSlot", slot),
    "clientItems": ("clientItems", lambda v: [titem(x) for x in v]),
    "partnerItems": ("partnerItems", lambda v: [titem(x) for x in v]),
    "fameBonuses": ("fameBonuses", lambda v: [fame(x) for x in v]),
}

F32 = lambda x: struct.unpack("!f", struct.pack("!f", x))[0]  # noqa: E731 — float32-exact values


def ench(ids):
    rec = bytes([0, 2, 4]) + struct.pack("<4H", *(ids + [0xFFFD] * (4 - len(ids)))) + bytes([5, 0])
    return base64.urlsafe_b64encode(rec).decode().rstrip("=")


P = lambda x, y: {"x": F32(x), "y": F32(y)}  # noqa: E731

STATS_A = [
    {"statType": 31, "statValue": 0, "strStatValue": "Somebody", "secondaryValue": 0},
    {"statType": 8, "statValue": 2979, "strStatValue": "", "secondaryValue": 0},
    {"statType": 9, "statValue": -1, "strStatValue": "", "secondaryValue": 0},
    {"statType": 6, "statValue": 0, "strStatValue": "123456", "secondaryValue": 0},
    {"statType": 131, "statValue": 65535, "strStatValue": "", "secondaryValue": 3},
    {"statType": 80, "statValue": 0, "strStatValue": ",,,," + ench([5, 16]) + ",,", "secondaryValue": 0},
    {"statType": 29, "statValue": -300000, "strStatValue": "", "secondaryValue": -64},
]

CASES = [
    ("HELLO", {"gameId": -2, "buildVersion": "7.0.0.0.0", "accessToken": "tok-ü", "keyTime": -1, "key": [],
               "userPlatform": "rotmg", "playPlatform": "rotmg", "platformToken": "", "userToken": "abc",
               "token": "XQpu8CWkMehb5rLVP3DG47FcafExRUvg"}),
    ("HELLO", {"gameId": 12345, "buildVersion": "7.0.0.0.0", "accessToken": "t", "keyTime": 999, "key": [1, 254, 127, 128, 0],
               "userPlatform": "rotmg", "playPlatform": "rotmg", "platformToken": "", "userToken": "abc",
               "token": "XQpu8CWkMehb5rLVP3DG47FcafExRUvg"}),
    ("LOAD", {"charId": 7, "isFromArena": False}),
    ("CREATE", {"classType": 782, "skinType": 0, "isChallenger": False, "isSeasonal": True}),
    ("MOVE", {"tickId": 41, "time": 4294967295, "records": [{"time": 10, "pos": P(1.5, -2.25)}, {"time": 20, "pos": P(0, 0)}]}),
    ("UPDATEACK", {}),
    ("GOTOACK", {"time": 555, "unknownByte": -1}),
    ("PONG", {"serial": 3, "time": 77}),
    ("SHOOTACK", {"time": 12}),
    ("SHOWALLYSHOOT", {"toggle": 1}),
    ("ESCAPE", {}),
    ("PLAYERTEXT", {"text": "/tell Someone ABC123"}),
    ("REQUESTTRADE", {"name": "Partner"}),
    ("CHANGETRADE", {"offer": [True, False, False, True]}),
    ("ACCEPTTRADE", {"clientOffer": [False, True], "partnerOffer": [True, True, False]}),
    ("CANCELTRADE", {}),
    ("INVSWAP", {"time": 9, "pos": P(3.5, 4.5), "slotObject1": {"objectId": 1, "slotId": 4, "objectType": 2979},
                 "slotObject2": {"objectId": 1, "slotId": 5, "objectType": -1}}),
    ("USEPORTAL", {"objectId": 4242}),
    ("FAILURE", {"errorId": 20, "errorDescription": ""}),
    ("FAILURE", {"errorId": 0, "errorDescription": "Account in use! (8 seconds until timeout)"}),
    ("MAPINFO", {"width": 100, "height": 100, "name": "Nexus", "displayName": "Nexus", "realmName": "",
                 "seed": 4000000000, "background": 0, "difficulty": F32(0.5), "allowPlayerTeleport": True,
                 "showDisplays": True, "newBool": False, "maxPlayers": 85, "gameOpenedTime": 123456,
                 "buildVersion": "7.0.0.0.0", "viewRadius": 15, "newInt": 3, "dungeonModifiers": ["a", "b"],
                 "unknownShort1": 0, "unknownBool": False, "unknownShort2": 1, "maxRealmScore": 100, "curRealmScore": 5}),
    ("MAPINFO", {"width": 1, "height": 2, "name": "Realm", "displayName": "R", "realmName": "Alpha",
                 "seed": 1, "background": 2, "difficulty": F32(1.25), "allowPlayerTeleport": False,
                 "showDisplays": False, "newBool": True, "maxPlayers": 1, "gameOpenedTime": 0,
                 "buildVersion": "", "viewRadius": 0, "newInt": 0, "dungeonModifiers": [""],
                 "unknownShort1": 0, "unknownBool": True, "unknownShort2": 0, "maxRealmScore": 0, "curRealmScore": 0}),
    ("CREATESUCCESS", {"objectId": 1234567, "charId": 3, "pcStats": "eJx"}),
    ("UPDATE", {"pos": P(50.25, 49.5), "levelType": 1,
                "tiles": [{"x": 1, "y": 2, "type": 60000}, {"x": -1, "y": -2, "type": 7}],
                "newObjs": [{"objectType": 782, "status": {"objectId": 1234567, "pos": P(50.25, 49.5), "stats": STATS_A}},
                            {"objectType": 1000, "status": {"objectId": 5, "pos": P(1, 1), "stats": []}}],
                "drops": [1, 128, -70000, 0], "unknownByte": 200}),
    ("UPDATE", {"pos": P(0, 0), "levelType": 0, "tiles": [], "newObjs": [], "drops": [], "unknownByte": -1}),
    ("NEWTICK", {"tickId": 100, "tickTime": 200, "serverRealTimeMS": 3000000000, "serverLastTimeRTTMS": 65000,
                 "statuses": [{"objectId": 1234567, "pos": P(2, 3), "stats": STATS_A[:3]}]}),
    ("GOTO", {"objectId": 1234567, "position": P(10, 20), "unknownInt": 0}),
    ("PING", {"serial": 9}),
    ("RECONNECT", {"name": "Realm", "host": "1.2.3.4", "port": 2050, "gameId": 5, "keyTime": 100, "key": [200, 1, 2, 3]}),
    ("QUEUEINFORMATION", {"curPos": 12, "maxPos": 40000}),
    ("TEXT", {"name": "Sender", "objectId": 77, "numStars": 20, "bubbleTime": 5, "recipient": "Bot",
              "text": "ABCDEFGHJK", "cleanText": "ABCDEFGHJK", "isSupporter": True, "starBg": 2}),
    ("TRADEREQUESTED", {"name": "Someone,1a2b"}),
    ("TRADESTART", {"clientItems": [{"item": 2979, "slotType": 9, "tradeable": True, "included": False, "enchantment": ench([5])},
                                    {"item": -1, "slotType": 0, "tradeable": False, "included": False, "enchantment": ""}],
                    "partnerName": "Partner,ffff",
                    "partnerItems": [{"item": 2591, "slotType": 10, "tradeable": True, "included": True, "enchantment": ""}]}),
    ("TRADECHANGED", {"offer": [False, True, True]}),
    ("TRADEACCEPTED", {"clientOffer": [True], "partnerOffer": []}),
    ("TRADEDONE", {"code": 0, "description": "Trade successful!"}),
    ("TRADEDONE", {"code": 1, "description": "Trade cancelled"}),
    ("SERVERPLAYERSHOOT", {"bulletId": 65535, "ownerId": 5, "containerType": 2979, "startingPos": P(1, 2), "angle": F32(0.75),
                           "damage": -5, "unknownInt": 1, "unknownByte": 2, "spellBomb": False, "bulletCount": 0, "bulletAngle": 0}),
    ("SERVERPLAYERSHOOT", {"bulletId": 1, "ownerId": 5, "containerType": 2979, "startingPos": P(1, 2), "angle": F32(0.75),
                           "damage": 5, "unknownInt": 1, "unknownByte": 2, "spellBomb": True, "bulletCount": 3, "bulletAngle": F32(0.5)}),
    ("ENEMYSHOOT", {"bulletId": 2, "ownerId": 9, "bulletType": 250, "startingPos": P(0, 0), "angle": F32(1.5), "damage": 30, "numShots": 1, "angleInc": 0}),
    ("ENEMYSHOOT", {"bulletId": 2, "ownerId": 9, "bulletType": 250, "startingPos": P(0, 0), "angle": F32(1.5), "damage": 30, "numShots": 3, "angleInc": F32(0.25)}),
    ("ACCOUNTLIST", {"accountListId": 0, "accountIds": ["a", "bb", ""], "lockAction": -1}),
    ("INVRESULT", {"unknownBool": True, "unknownByte": 0, "fromSlot": {"objectId": 1, "slotId": 4, "objectType": 2979},
                   "toSlot": {"objectId": 1, "slotId": 5, "objectType": -1}, "unknownInt1": 0, "unknownInt2": 0}),
    ("NOTIFICATION", {"effect": 2, "extra": 0, "message": "Error!", "objectId": 0, "uiExtra": 0, "queuePos": 0, "color": 0, "pictureType": 0, "emoteId": 0, "unknown1": 0, "unknown2": 0}),
    ("NOTIFICATION", {"effect": 4, "extra": 1, "message": "ui", "objectId": 0, "uiExtra": 7, "queuePos": 0, "color": 0, "pictureType": 0, "emoteId": 0, "unknown1": 0, "unknown2": 0}),
    ("NOTIFICATION", {"effect": 5, "extra": 0, "message": "", "objectId": 55, "uiExtra": 0, "queuePos": 3, "color": 0, "pictureType": 0, "emoteId": 0, "unknown1": 0, "unknown2": 0}),
    ("NOTIFICATION", {"effect": 6, "extra": 0, "message": "{}", "objectId": 55, "uiExtra": 0, "queuePos": 0, "color": 16711680, "pictureType": 0, "emoteId": 0, "unknown1": 0, "unknown2": 0}),
    ("NOTIFICATION", {"effect": 13, "extra": 0, "message": "", "objectId": 55, "uiExtra": 0, "queuePos": 0, "color": 0, "pictureType": 0, "emoteId": 9, "unknown1": 0, "unknown2": 0}),
]

out = {"rc4": {}, "packets": [], "compressed": [], "enchants": []}

# RC4: first 64 keystream bytes per direction (XOR of zeros), and a chained
# call to prove state carries across process() calls.
for name, key in (("incoming", RC4.INCOMING_KEY), ("outgoing", RC4.OUTGOING_KEY)):
    c = RC4.RC4(key)
    a = bytes(c.process(bytes(32)))
    b = bytes(c.process(bytes(32)))
    out["rc4"][name] = {"key": key, "keystream64": (a + b).hex()}

for name, fields in CASES:
    pkt = createPacket(name)
    for k, v in fields.items():
        attr, conv = CONVERT.get(k, (k, None))
        setattr(pkt, attr, conv(v) if conv else v)
    w = W.Writer()
    pkt.write(w)
    w.writeHeader(PacketId.typeToId[name])
    out["packets"].append({"name": name, "id": PacketId.typeToId[name], "fields": fields, "hex": bytes(w.buffer).hex()})

for v in [0, 1, 63, 64, 127, 128, 8191, 8192, 1 << 20, (1 << 27) - 1, -1, -63, -64, -70000, -(1 << 27)]:
    w = W.Writer()
    w.writeCompressedInt(v)
    out["compressed"].append({"value": v, "hex": bytes(w.buffer).hex()})

for ids in [[], [5], [5, 16], [1, 2, 3, 4]]:
    payload = ench(ids)
    out["enchants"].append({"payload": payload, "ids": ids, "count": enchant_count(payload)})
out["enchants"].append({"payload": "not base64!!", "ids": [], "count": enchant_count("not base64!!")})
out["enchants"].append({"payload": "", "ids": [], "count": 0})

dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "relay", "protocol", "__tests__", "fixtures.json")
with open(dest, "w") as f:
    json.dump(out, f, indent=1)
print(f"wrote {len(out['packets'])} packet fixtures to {os.path.relpath(dest)}")
