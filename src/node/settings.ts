// One JSON file of node-level settings in the data dir: what the owner has
// opted into, and what the node has learned that must survive a restart.
// Read once, written whole on every change; small enough that this is fine.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface NodeSettings {
  /** Opt-in ban telemetry (design doc §8). Off until the owner says yes. */
  telemetry: { enabled: boolean; hubUrl: string; salt: string };
  /** Realm builds this node has run bots on without a protocol kick (design doc §8). */
  knownBuilds: string[];
  /** Connected mode (design doc §4.3): the hub this node is linked to, or null in local mode. */
  hub: HubLink | null;
}

export interface HubLink {
  url: string;
  nodeId: string;
  /** The hub account this node was linked with (for display only). */
  email: string;
  publicKeyPem: string;
  /** Sealed with src/node/secrets.ts; never written in the clear. */
  privateKeyPemSealed: string;
  linkedAt: number;
}

export const NODE_SETTINGS_FILE = "node.json";

function defaults(): NodeSettings {
  return { telemetry: { enabled: false, hubUrl: "", salt: randomBytes(16).toString("base64url") }, knownBuilds: [], hub: null };
}

export class NodeSettingsStore {
  private value: NodeSettings;
  constructor(readonly file: string, private readonly log: (s: string) => void = () => {}) {
    this.value = defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<NodeSettings>;
      this.value = {
        telemetry: { ...this.value.telemetry, ...(raw.telemetry ?? {}) },
        knownBuilds: Array.isArray(raw.knownBuilds) ? raw.knownBuilds.filter((b): b is string => typeof b === "string") : [],
        hub: raw.hub && typeof raw.hub === "object" && typeof raw.hub.nodeId === "string" ? raw.hub : null,
      };
    } catch {
      // absent or unreadable: defaults, written on the first change
    }
  }
  static at(dataDir: string, log?: (s: string) => void): NodeSettingsStore {
    return new NodeSettingsStore(path.join(dataDir, NODE_SETTINGS_FILE), log);
  }
  get(): Readonly<NodeSettings> {
    return this.value;
  }
  update(fn: (s: NodeSettings) => void): Readonly<NodeSettings> {
    fn(this.value);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2) + "\n");
    } catch (e) {
      this.log(`node settings: could not write ${this.file}: ${String(e)}`);
    }
    return this.value;
  }
}
