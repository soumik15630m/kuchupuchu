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
const DEVICE_KEY = "kuchupuchu:device";
const EMAIL_KEY = "kuchupuchu:email";

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
}

export function clearSession(): void {
  localStorage.removeItem(REFRESH_KEY);
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

export async function verifyOtp(email: string, code: string): Promise<Tokens> {
  return request<Tokens>("/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code, deviceId: deviceId(), platform: "web" }),
  });
}

/** Holds the access token in memory only and serialises refreshes, so a burst of
 * parallel calls after expiry produces one refresh rather than N racing ones —
 * which matters here because refresh tokens rotate and the loser of that race
 * presents a superseded token, which the server treats as a leak and responds to
 * by revoking every device on the account. */
export class Session {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    readonly email: string,
    private readonly onEnded: () => void
  ) {
    this.refreshToken = storedRefreshToken();
  }

  adopt(tokens: Tokens): void {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    persistSession(this.email, tokens);
  }

  private async refresh(): Promise<string> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      if (!this.refreshToken) throw new SessionEndedError("no refresh token");
      let tokens: Tokens;
      try {
        tokens = await request<Tokens>("/token/refresh", {
          method: "POST",
          body: JSON.stringify({ refreshToken: this.refreshToken }),
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
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async authed<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.accessToken) await this.refresh();
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

  /** The messaging service sits behind a different nginx prefix, so these
   * bypass `authed`'s API_BASE. They still need the same 401-retry, hence
   * `msgAuthed` rather than a bare fetch. */
  private async msgAuthed<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.accessToken) await this.refresh();
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

  /** The browser WebSocket API cannot set an Authorization header, so the
   * access token goes in the query string. It must be the short-lived access
   * token, never the refresh token — this lands in the server's access log. */
  async socketUrl(): Promise<string> {
    if (!this.accessToken) await this.refresh();
    const base = MSG_BASE.startsWith("http")
      ? MSG_BASE.replace(/^http/, "ws")
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${MSG_BASE}`;
    return `${base}/ws?token=${encodeURIComponent(this.accessToken!)}`;
  }
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
