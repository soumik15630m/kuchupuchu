import type { IdentityOnFile } from "../crypto/group-e2ee";
import type { PrekeyBundle, PublishPayload } from "../crypto/signal-crypto";

// nginx proxies /auth/ to the auth-service root with a trailing-slash
// proxy_pass, which strips the prefix — so every path below is the service's
// own route, not the one the browser sees.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/auth";

// The messaging service is proxied under its own prefix, also with a
// trailing-slash proxy_pass, so paths here are service-root relative too.
export const MSG_BASE = process.env.NEXT_PUBLIC_MSG_BASE ?? "/msg";

const REFRESH_KEY = "kuchupuchu:refresh";
const ACCESS_KEY = "kuchupuchu:access";
const DEVICE_KEY = "kuchupuchu:device";
const EMAIL_KEY = "kuchupuchu:email";

/** Refresh tokens rotate, and presenting a superseded one is treated by the
 * server as a leak — it revokes every device on the account. Two tabs (or a
 * StrictMode double-mount) each holding their own Session would otherwise
 * present the same stored token concurrently and trigger exactly that. */
const REFRESH_LOCK = "kuchupuchu:refresh-lock";

/** Refresh this long before the access token actually expires, so a request
 * in flight when it lapses does not 401. */
const EXPIRY_SKEW_MS = 30_000;

function tokenExpiryMs(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isUsable(token: string | null): token is string {
  if (!token) return false;
  const expiry = tokenExpiryMs(token);
  return expiry === null ? false : expiry - EXPIRY_SKEW_MS > Date.now();
}

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  // Web Locks is the only cross-tab mutex browsers offer. Where it is missing
  // the single-instance guard still applies; this is strictly an improvement.
  if (!navigator.locks?.request) return fn();
  return navigator.locks.request(REFRESH_LOCK, fn) as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Revoked or expired devices get a 401 from the refresh endpoint that no retry
 * can fix — the session is over and the shell has to send the user back to login. */
export class SessionEndedError extends ApiError {
  constructor(message: string) {
    super(401, message);
    this.name = "SessionEndedError";
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface TurnCredentials {
  username: string;
  password: string;
  ttl: number;
  uris: string[];
}

export interface RoomGrant {
  roomName: string;
  roomToken: string;
  livekitUrl: string;
  turnCredentials: TurnCredentials;
}

/** A device id is minted once and kept. Changing it strands the identity key
 * published under the old one, which is write-once server side. */
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function storedEmail(): string | null {
  return localStorage.getItem(EMAIL_KEY);
}

export function storedRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function persistSession(email: string, tokens: Tokens): void {
  localStorage.setItem(EMAIL_KEY, email);
  localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  // Stored, not just held in memory, so a second tab can reuse a still-valid
  // access token instead of racing to rotate the refresh token.
  localStorage.setItem(ACCESS_KEY, tokens.accessToken);
}

export function clearSession(): void {
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(EMAIL_KEY);
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    return JSON.stringify(detail ?? body);
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new ApiError(res.status, await parseError(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function requestOtp(email: string): Promise<void> {
  await request("/otp/request", { method: "POST", body: JSON.stringify({ email }) });
}

/** `asDeviceId` lets the caller register a device id it has not stored yet,
 * so a sign-in that turns out to be a typo leaves this browser untouched. */
export async function verifyOtp(
  email: string,
  code: string,
  asDeviceId?: string
): Promise<Tokens> {
  return request<Tokens>("/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code, deviceId: asDeviceId ?? deviceId(), platform: "web" }),
  });
}

/** Serialises token refresh both within an instance and across tabs, because
 * refresh tokens rotate: the loser of that race presents a superseded token,
 * which the server reads as a leak and answers by revoking every device on the
 * account. Observed for real — two Session instances sharing one stored token
 * locked both test accounts out. */
export class Session {
  private accessToken: string | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    readonly email: string,
    private readonly onEnded: () => void
  ) {
    const stored = localStorage.getItem(ACCESS_KEY);
    if (isUsable(stored)) this.accessToken = stored;
  }

  adopt(tokens: Tokens): void {
    this.accessToken = tokens.accessToken;
    persistSession(this.email, tokens);
  }

  private async refresh(): Promise<string> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = withRefreshLock(async () => {
      // Another tab may have rotated while this call waited for the lock.
      // Adopting its access token is what keeps a superseded refresh token
      // from ever reaching the server.
      const fresh = localStorage.getItem(ACCESS_KEY);
      if (isUsable(fresh) && fresh !== this.accessToken) {
        this.accessToken = fresh;
        return fresh;
      }

      const refreshToken = storedRefreshToken();
      if (!refreshToken) throw new SessionEndedError("no refresh token");

      let tokens: Tokens;
      try {
        tokens = await request<Tokens>("/token/refresh", {
          method: "POST",
          body: JSON.stringify({ refreshToken }),
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          this.onEnded();
          throw new SessionEndedError(err.message);
        }
        throw err;
      }
      this.adopt(tokens);
      return tokens.accessToken;
    }).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async authed<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!isUsable(this.accessToken)) await this.refresh();
    const send = (token: string) =>
      request<T>(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });

    try {
      return await send(this.accessToken!);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      return send(await this.refresh());
    }
  }

  publishPrekeys(payload: PublishPayload): Promise<{ unused_one_time_prekeys?: number }> {
    return this.authed("/prekeys/me", { method: "POST", body: JSON.stringify(payload) });
  }

  fetchBundle(email: string, peerDeviceId: string): Promise<PrekeyBundle> {
    return this.authed(`/prekeys/${encodeURIComponent(email)}/${encodeURIComponent(peerDeviceId)}`);
  }

  fetchIdentity(email: string, peerDeviceId: string): Promise<IdentityOnFile> {
    return this.authed(
      `/prekeys/${encodeURIComponent(email)}/${encodeURIComponent(peerDeviceId)}/identity`
    );
  }

  roomToken(participants: string[]): Promise<RoomGrant> {
    return this.authed("/room/token", { method: "POST", body: JSON.stringify({ participants }) });
  }

  devices(): Promise<{ devices: DeviceRow[] }> {
    return this.authed("/devices/me");
  }

  revokeDevice(id: string): Promise<void> {
    return this.authed(`/devices/${encodeURIComponent(id)}/revoke`, { method: "POST" });
  }

  reportQuality(body: unknown): Promise<void> {
    return this.authed("/quality/report", { method: "POST", body: JSON.stringify(body) });
  }

  peerDevices(email: string): Promise<{ email: string; devices: string[] }> {
    return this.authed(`/devices/peer/${encodeURIComponent(email)}`);
  }

  me(): Promise<Member> {
    return this.authed("/users/me");
  }

  setUsername(username: string): Promise<{ username: string }> {
    return this.authed("/users/me/username", {
      method: "PUT",
      body: JSON.stringify({ username }),
    });
  }

  setProfile(patch: { displayName?: string; about?: string }): Promise<Member> {
    return this.authed("/users/me/profile", { method: "PUT", body: JSON.stringify(patch) });
  }

  lookupUsername(username: string): Promise<Member> {
    return this.authed(`/users/lookup/${encodeURIComponent(username)}`);
  }

  directory(): Promise<{ members: Member[] }> {
    return this.authed("/users/directory");
  }

  /** The messaging service sits behind a different nginx prefix, so these
   * bypass `authed`'s API_BASE. They still need the same 401-retry, hence
   * `msgAuthed` rather than a bare fetch. */
  private async msgAuthed<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!isUsable(this.accessToken)) await this.refresh();
    const send = async (token: string): Promise<T> => {
      const res = await fetch(`${MSG_BASE}${path}`, {
        ...init,
        headers: {
          ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
          ...(init.headers ?? {}),
          authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) throw new ApiError(res.status, await parseError(res));
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("application/json")) return (await res.arrayBuffer()) as T;
      return (await res.json()) as T;
    };

    try {
      return await send(this.accessToken!);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      return send(await this.refresh());
    }
  }

  sendMessage(body: SendMessageBody): Promise<{ status: string; ids: string[] }> {
    return this.msgAuthed("/send", { method: "POST", body: JSON.stringify(body) });
  }

  pendingMessages(): Promise<{ messages: WireMessage[] }> {
    return this.msgAuthed("/pending");
  }

  ackDelivered(messageIds: string[]): Promise<{ count: number }> {
    return this.msgAuthed("/receipts/delivered", {
      method: "POST",
      body: JSON.stringify({ message_ids: messageIds }),
    });
  }

  ackRead(clientMsgIds: string[]): Promise<{ count: number }> {
    return this.msgAuthed("/receipts/read", {
      method: "POST",
      body: JSON.stringify({ client_msg_ids: clientMsgIds }),
    });
  }

  async uploadMedia(blob: Blob, audience: string[]): Promise<{ id: string }> {
    const form = new FormData();
    form.append("file", blob, "blob.bin");
    form.append("audience", audience.join(","));
    return this.msgAuthed("/media", { method: "POST", body: form });
  }

  downloadMedia(mediaId: string): Promise<ArrayBuffer> {
    return this.msgAuthed(`/media/${encodeURIComponent(mediaId)}`);
  }

  /** Uploads the encrypted history backup, replacing any previous one. The
   * body is ciphertext; the passphrase that produced it never leaves the
   * device, so the server can store and return this but not read it. */
  async uploadBackup(bytes: Uint8Array): Promise<BackupMeta> {
    return this.msgAuthed("/backup", {
      method: "PUT",
      body: new Blob([bytes]),
      headers: { "content-type": "application/octet-stream" },
    });
  }

  backupMeta(): Promise<{ exists: boolean } & Partial<BackupMeta>> {
    return this.msgAuthed("/backup/meta");
  }

  async downloadBackup(): Promise<Uint8Array> {
    return new Uint8Array(await this.msgAuthed<ArrayBuffer>("/backup"));
  }

  deleteBackup(): Promise<{ deleted: boolean }> {
    return this.msgAuthed("/backup", { method: "DELETE" });
  }

  /** Link previews are fetched by our own server because no third party
   * sends CORS headers for its HTML. Only the sender does this; the result
   * is embedded in the encrypted envelope, so the recipient never contacts
   * the site. */
  unfurl(url: string): Promise<LinkPreviewResponse> {
    return this.msgAuthed("/unfurl", { method: "POST", body: JSON.stringify({ url }) });
  }

  async unfurlImage(url: string): Promise<Blob> {
    const bytes = await this.msgAuthed<ArrayBuffer>(
      `/unfurl/image?u=${encodeURIComponent(url)}`
    );
    return new Blob([bytes]);
  }

  /** The browser WebSocket API cannot set an Authorization header, so the
   * access token goes in the query string. It must be the short-lived access
   * token, never the refresh token — this lands in the server's access log. */
  async socketUrl(): Promise<string> {
    if (!isUsable(this.accessToken)) await this.refresh();
    const base = MSG_BASE.startsWith("http")
      ? MSG_BASE.replace(/^http/, "ws")
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${MSG_BASE}`;
    return `${base}/ws?token=${encodeURIComponent(this.accessToken!)}`;
  }
}

/** A member of the allowlist. `email` is the account identifier the protocol
 * addresses by; `username` is the handle people actually use. */
export interface BackupMeta {
  byteSize: number;
  createdAt: string;
  deviceId: string;
}

export interface LinkPreviewResponse {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
}

export interface Member {
  email: string;
  username: string | null;
  displayName: string | null;
  about: string | null;
  profileUpdatedAt: string | null;
}

export interface WireMessage {
  id: string;
  client_msg_id: string;
  from_email: string;
  from_device: string;
  to_email: string;
  to_device: string;
  kind: string;
  envelope: string;
  created_at: string;
}

export interface SendMessageBody {
  client_msg_id: string;
  kind: string;
  recipients: { email: string; device_id: string; envelope: string }[];
}

export interface DeviceRow {
  id: string;
  platform: string;
  status: "active" | "revoked" | "expired";
  createdAt: string;
  lastSeenAt: string | null;
}
