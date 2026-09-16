// Connected mode (design doc §4.3): the node's side of docs/hub-protocol.md.
// Linking is the one call that carries the hub password; from then on the
// node's Ed25519 key signs every request, and the hub can revoke it by
// deleting the node. Nothing here is needed for local mode, and every call
// fails soft: a hub that is down never touches the vault.
import { generateNodeKeypair, signRequest, compareVersions, type HeartbeatReply, type HeartbeatRequest, type LinkReply, type VersionInfo } from "../shared/hubWire";
import { open as unseal, seal } from "./secrets";
import type { HubLink, NodeSettingsStore } from "./settings";

export const HEARTBEAT_MS = Number(process.env.HUB_HEARTBEAT_SECONDS ?? 60) * 1000;
export const VERSION_POLL_MS = Number(process.env.HUB_VERSION_POLL_SECONDS ?? 600) * 1000;
const TIMEOUT_MS = 10_000;

export type HubResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface HubClientOptions {
  settings: NodeSettingsStore;
  nodeVersion: string;
  /** What a heartbeat reports. */
  bots: () => HeartbeatRequest["bots"];
  build: () => string;
  /** The hub says these Realm builds are fine on this node version. */
  onKnownBuilds?: (builds: string[]) => void;
  log: (s: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface HubStatus {
  linked: boolean;
  url: string | null;
  nodeId: string | null;
  email: string | null;
  linkedAt: number | null;
  lastHeartbeatAt: number | null;
  lastError: string | null;
  version: VersionInfo | null;
  /** The hub wants a newer node; hub features are off until then. */
  outdated: boolean;
}

export class HubClient {
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private versionTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt: number | null = null;
  private lastError: string | null = null;
  private version: VersionInfo | null = null;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly o: HubClientOptions) {
    this.now = o.now ?? Date.now;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  get link(): HubLink | null {
    return this.o.settings.get().hub;
  }
  get linked(): boolean {
    return this.link !== null;
  }
  get outdated(): boolean {
    return !!this.version && compareVersions(this.o.nodeVersion, this.version.minNodeVersion) < 0;
  }

  private async call<T>(url: string, init: RequestInit): Promise<HubResult<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      return { ok: false, status: 0, error: `hub unreachable: ${(e as Error).message}` };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON
    }
    if (!res.ok) return { ok: false, status: res.status, error: (body as { error?: string } | null)?.error ?? `hub returned ${res.status}` };
    return { ok: true, data: body as T };
  }

  /** A signed request to the linked hub. */
  async signed<T>(method: string, pathWithQuery: string, payload: unknown = {}): Promise<HubResult<T>> {
    const link = this.link;
    if (!link) return { ok: false, status: 0, error: "not linked to a hub" };
    const body = JSON.stringify(payload);
    let privateKey: string;
    try {
      privateKey = unseal(link.privateKeyPemSealed);
    } catch {
      return { ok: false, status: 0, error: "the node key cannot be opened (sealing key changed?)" };
    }
    const headers = signRequest(privateKey, link.nodeId, method, pathWithQuery, body, this.now());
    const r = await this.call<T>(`${link.url}${pathWithQuery}`, { method, headers: { ...headers, "content-type": "application/json" }, body: method === "GET" ? undefined : body });
    this.lastError = r.ok ? null : r.error;
    return r;
  }

  /** Log in once with the hub account; from then on the key is the credential. */
  async linkTo(url: string, email: string, password: string, name: string): Promise<HubResult<LinkReply>> {
    const base = url.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(base)) return { ok: false, status: 0, error: "hub URL must start with http:// or https://" };
    if (this.linked) return { ok: false, status: 0, error: "already linked; unlink first" };
    const kp = generateNodeKeypair();
    const r = await this.call<LinkReply>(`${base}/api/v1/nodes/link`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password, publicKey: kp.publicKeyPem, name, version: this.o.nodeVersion }),
    });
    if (!r.ok) {
      this.lastError = r.error;
      return r;
    }
    this.o.settings.update((s) => {
      s.hub = { url: base, nodeId: r.data.nodeId, email: email.trim(), publicKeyPem: kp.publicKeyPem, privateKeyPemSealed: seal(kp.privateKeyPem), linkedAt: this.now() };
      // Telemetry goes to the hub this node belongs to.
      s.telemetry.hubUrl = base;
    });
    this.lastError = null;
    this.o.log(`hub: linked to ${base} as node ${r.data.nodeId} (${email.trim()})`);
    this.start();
    return r;
  }

  /** Tell the hub (best effort), then forget the link and the key. */
  async unlink(): Promise<void> {
    if (this.linked) await this.signed("POST", "/api/v1/nodes/unlink", {}).catch(() => null);
    this.stop();
    this.o.settings.update((s) => {
      s.hub = null;
    });
    this.version = null;
    this.lastHeartbeatAt = null;
    this.o.log("hub: unlinked");
  }

  async sendHeartbeat(): Promise<boolean> {
    if (!this.linked) return false;
    const r = await this.signed<HeartbeatReply>("POST", "/api/v1/nodes/heartbeat", { version: this.o.nodeVersion, build: this.o.build(), bots: this.o.bots() } satisfies HeartbeatRequest);
    if (!r.ok) {
      this.o.log(`hub: heartbeat failed: ${r.error}`);
      return false;
    }
    this.lastHeartbeatAt = this.now();
    return true;
  }

  /** The public version feed; usable before linking too. */
  async refreshVersion(url = this.link?.url ?? null): Promise<VersionInfo | null> {
    if (!url) return null;
    const r = await this.call<VersionInfo>(`${url}/api/v1/version`, { method: "GET" });
    if (!r.ok) {
      this.lastError = r.error;
      return null;
    }
    this.version = r.data;
    if (this.outdated) this.o.log(`hub: this node (${this.o.nodeVersion}) is below the hub's minimum ${r.data.minNodeVersion}; hub features are off until it is updated`);
    if (r.data.build?.knownBuilds?.length) this.o.onKnownBuilds?.(r.data.build.knownBuilds);
    return r.data;
  }

  start(): void {
    if (!this.linked || this.heartbeat) return;
    void this.refreshVersion().then(() => this.sendHeartbeat());
    this.heartbeat = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.versionTimer = setInterval(() => void this.refreshVersion(), VERSION_POLL_MS);
    this.versionTimer.unref?.();
  }
  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.versionTimer) clearInterval(this.versionTimer);
    this.heartbeat = null;
    this.versionTimer = null;
  }

  status(): HubStatus {
    const l = this.link;
    return {
      linked: !!l, url: l?.url ?? null, nodeId: l?.nodeId ?? null, email: l?.email ?? null, linkedAt: l?.linkedAt ?? null,
      lastHeartbeatAt: this.lastHeartbeatAt, lastError: this.lastError, version: this.version, outdated: this.outdated,
    };
  }
}
