import type { Group, Member, Message, Ride, RiderLocation, SosAlert, User } from "../types";

const base = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const TOKEN_KEY = "ridemate_token";
const USER_KEY = "ridemate_user";

export const session = {
  token: () => localStorage.getItem(TOKEN_KEY), 
  user(): User | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as User) : null;
    } catch {
      return null;
    }
  },
  save(token: string, user: User) {
    localStorage.setItem(TOKEN_KEY, token); 
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY); 
    localStorage.removeItem(USER_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Fires when the server rejects our token, so the app can sign out. */
const unauthorized = new Set<() => void>();
export const onUnauthorized = (handler: () => void) => {
  unauthorized.add(handler);
  return () => {
    unauthorized.delete(handler);
  };
};

/**
 * Signing in with the wrong password is a 401 too, but it must not tear down
 * an existing session — only an expired or rejected token should do that.
 */
const isCredentialCheck = (path: string) =>
  path.startsWith("/auth/login") || path.startsWith("/auth/register");

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = session.token();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError(0, "Cannot reach RideMate. Check your connection.");
  }

  if (response.status === 401) {
    if (isCredentialCheck(path)) {
      const body = await response.json().catch(() => null);
      throw new ApiError(401, body?.detail || "Invalid email or password");
    }
    unauthorized.forEach((handler) => handler());
    throw new ApiError(401, "Your session has expired. Please sign in again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.detail || "Request failed");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/* The API speaks snake_case; these mappers are the only place that leaks in. */

type RawGroup = {
  id: string;
  name: string;
  invite_code: string;
  owner_id: string | null;
  member_count: number;
  active_ride_id: string | null;
  ride_started_at: string | null;
};

const toGroup = (raw: RawGroup): Group => ({
  id: String(raw.id),
  name: raw.name,
  inviteCode: raw.invite_code,
  ownerId: raw.owner_id === null ? null : String(raw.owner_id),
  memberCount: raw.member_count ?? 0,
  activeRideId: raw.active_ride_id === null ? null : String(raw.active_ride_id),
  rideStartedAt: raw.ride_started_at ?? null,
});

const toMember = (raw: Record<string, unknown>): Member => ({
  id: String(raw.id),
  name: String(raw.name),
  email: String(raw.email ?? ""),
  avatar: (raw.avatar_url as string | null) ?? null,
  online: Boolean(raw.online),
  lastLocationAt: (raw.last_location_at as string | null) ?? null,
});

export const toLocation = (raw: Record<string, unknown>): RiderLocation => ({
  userId: String(raw.userId ?? raw.user_id),
  name: String(raw.name ?? ""),
  latitude: Number(raw.latitude),
  longitude: Number(raw.longitude),
  accuracy: raw.accuracy === null || raw.accuracy === undefined ? null : Number(raw.accuracy),
  timestamp: String(raw.timestamp ?? new Date().toISOString()),
  online: raw.online === undefined ? true : Boolean(raw.online),
  rideId:
    raw.rideId === undefined && raw.ride_id === undefined
      ? null
      : String(raw.rideId ?? raw.ride_id ?? "") || null,
});

export const toMessage = (raw: Record<string, unknown>): Message => ({
  id: String(raw.id),
  senderId: String(raw.senderId ?? raw.sender_id ?? ""),
  sender: String(raw.sender ?? "Unknown rider"),
  text: String(raw.text ?? ""),
  timestamp: String(raw.timestamp ?? new Date().toISOString()),
  status: "sent",
  clientId: raw.clientId ? String(raw.clientId) : undefined,
});

export const toSosAlert = (raw: Record<string, unknown>): SosAlert => ({
  id: String(raw.id),
  groupId: String(raw.group_id ?? raw.groupId ?? ""),
  riderId: String(raw.rider_id ?? raw.riderId ?? ""),
  riderName: String(raw.rider_name ?? raw.riderName ?? "A rider"),
  latitude: Number(raw.latitude),
  longitude: Number(raw.longitude),
  active: raw.active === undefined ? true : Boolean(raw.active),
  createdAt: String(raw.created_at ?? raw.createdAt ?? new Date().toISOString()),
});

const toRide = (raw: Record<string, unknown>): Ride => ({
  id: String(raw.id),
  groupId: String(raw.group_id),
  groupName: String(raw.group_name ?? ""),
  startedBy: raw.started_by === null ? null : String(raw.started_by),
  startedAt: String(raw.started_at),
  endedAt: (raw.ended_at as string | null) ?? null,
  durationSeconds: Number(raw.duration_seconds ?? 0),
  distanceKm: Number(raw.distance_km ?? 0),
  riderCount: Number(raw.rider_count ?? 0),
});

type AuthResponse = { access_token: string; user: User };

export const authApi = {
  login: (email: string, password: string) =>
    api<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (name: string, email: string, password: string) =>
    api<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    }),
  // The response carries a refreshed token, which extends the session.
  me: () => api<User & { access_token?: string }>("/auth/me"),
  updateName: (name: string) =>
    api<AuthResponse>("/auth/me", { method: "PATCH", body: JSON.stringify({ name }) }),
};

export const groupsApi = {
  async list() {
    return (await api<RawGroup[]>("/groups")).map(toGroup);
  },
  async create(name: string) {
    return toGroup(await api<RawGroup>("/groups", { method: "POST", body: JSON.stringify({ name }) }));
  },
  async join(code: string) {
    return toGroup(
      await api<RawGroup>("/groups/join", { method: "POST", body: JSON.stringify({ code }) }),
    );
  },
  leave: (groupId: string) => api<void>(`/groups/${groupId}/members/me`, { method: "DELETE" }),
  async members(groupId: string) {
    return (await api<Record<string, unknown>[]>(`/groups/${groupId}/members`)).map(toMember);
  },
  async locations(groupId: string) {
    return (await api<Record<string, unknown>[]>(`/groups/${groupId}/locations`)).map(toLocation);
  },
  async messages(groupId: string) {
    return (await api<Record<string, unknown>[]>(`/groups/${groupId}/messages`)).map(toMessage);
  },
  async sendMessage(groupId: string, text: string) {
    return toMessage(
      await api<Record<string, unknown>>(`/groups/${groupId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    );
  },
  async startRide(groupId: string) {
    return await api<{ id: string }>(`/groups/${groupId}/rides`, { method: "POST" });
  },
  async activeSos(groupId: string) {
    return (await api<Record<string, unknown>[]>(`/groups/${groupId}/sos`)).map(toSosAlert);
  },
};

export const ridesApi = {
  async get(rideId: string) {
    return toRide(await api<Record<string, unknown>>(`/rides/${rideId}`));
  },
  async end(rideId: string) {
    return toRide(await api<Record<string, unknown>>(`/rides/${rideId}/end`, { method: "POST" }));
  },
  leave: (rideId: string) => api<void>(`/rides/${rideId}/leave`, { method: "POST" }),
};
