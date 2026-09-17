import type { IdentityOnFile } from "../crypto/group-e2ee";
import type { PrekeyBundle, PublishPayload } from "../crypto/signal-crypto";

// nginx proxies /auth/ to the auth-service root with a trailing-slash
// proxy_pass, which strips the prefix — so every path below is the service's
// own route, not the one the browser sees.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/auth";

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

export interface RoomGrant {
  roomName: string;
  roomToken: string;
  livekitUrl: string;
  turnCredentials: { urls: string[]; username: string; credential: string };
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
}

export interface DeviceRow {
  id: string;
  platform: string;
  status: "active" | "revoked" | "expired";
  createdAt: string;
  lastSeenAt: string | null;
}
