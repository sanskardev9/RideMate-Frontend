import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  authApi,
  groupsApi,
  onUnauthorized,
  ridesApi,
  session,
  toLocation,
  toMessage,
  toSosAlert,
} from "../api/client";
import { ws } from "../websocket/manager";
import type {
  Group,
  Member,
  Message,
  Ride,
  RiderLocation,
  SosAlert,
  User,
} from "../types";

const ACTIVE_GROUP_KEY = "ridemate_active_group";

/** What the browser will do if we ask for a position right now. */
export type LocationStatus =
  | "idle"
  | "prompt"
  | "granted"
  | "denied"
  | "unsupported"
  | "insecure";
/** How long a "<name> is typing" hint survives without a refresh. */
const TYPING_TIMEOUT_MS = 4000;

type Store = {
  user: User | null;
  authLoading: boolean;
  ready: boolean;
  connected: boolean;
  error: string | null;
  dismissError: () => void;

  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  updateName: (name: string) => Promise<void>;

  groups: Group[];
  group: Group | null;
  selectGroup: (groupId: string) => void;
  createGroup: (name: string) => Promise<Group>;
  joinGroup: (code: string) => Promise<Group>;
  leaveGroup: (groupId: string) => Promise<void>;

  members: Member[];
  locations: RiderLocation[];
  myLocation: RiderLocation | null;
  locationError: string | null;
  locationStatus: LocationStatus;
  sharingLocation: boolean;
  startLocation: () => void;
  /** Bumped to ask the map to centre on the rider's own position. */
  recenterToken: number;
  recenter: () => void;
  stopLocation: () => void;

  ride: Ride | null;
  startRide: () => Promise<void>;
  joinRide: () => Promise<void>;
  endRideForEveryone: () => Promise<void>;
  leaveRide: () => Promise<void>;

  messages: Message[];
  sendMessage: (text: string) => Promise<void>;
  typingNames: string[];
  notifyTyping: () => void;

  sosAlerts: SosAlert[];
  mySos: SosAlert | null;
  triggerSos: () => Promise<void>;
  cancelSos: () => Promise<void>;

  refresh: () => Promise<void>;
};

const Ctx = createContext<Store | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => session.user());
  const [authLoading, setAuthLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [groups, setGroups] = useState<Group[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_GROUP_KEY),
  );
  const [members, setMembers] = useState<Member[]>([]);
  const [locations, setLocations] = useState<RiderLocation[]>([]);
  const [myLocation, setMyLocation] = useState<RiderLocation | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [ride, setRide] = useState<Ride | null>(null);
  const [sosAlerts, setSosAlerts] = useState<SosAlert[]>([]);
  const [typing, setTyping] = useState<Record<string, { name: string; at: number }>>({});
  const [sharingLocation, setSharingLocation] = useState(false);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>("idle");
  const [recenterToken, setRecenterToken] = useState(0);

  const watchId = useRef<number | null>(null);
  const typingSentAt = useRef(0);
  // Read inside the geolocation callback, which outlives a single render.
  const groupIdRef = useRef<string | null>(activeGroupId);
  // Read inside the geolocation callback, which outlives a single render.
  const ridingRef = useRef(false);

  const group = useMemo(
    () => groups.find((candidate) => candidate.id === activeGroupId) ?? groups[0] ?? null,
    [groups, activeGroupId],
  );
  useEffect(() => {
    groupIdRef.current = group?.id ?? null;
  }, [group]);

  const selectGroup = useCallback((groupId: string) => {
    setActiveGroupId(groupId);
    localStorage.setItem(ACTIVE_GROUP_KEY, groupId);
  }, []);

  const signOut = useCallback(() => {
    if (watchId.current !== null) navigator.geolocation?.clearWatch(watchId.current);
    watchId.current = null;
    setSharingLocation(false);
    ws.disconnect();
    session.clear();
    localStorage.removeItem(ACTIVE_GROUP_KEY);
    setUser(null);
    setGroups([]);
    setActiveGroupId(null);
    setMembers([]);
    setLocations([]);
    setMyLocation(null);
    setMessages([]);
    setRide(null);
    setSosAlerts([]);
    setTyping({});
  }, []);

  useEffect(() => {
    if (!("geolocation" in navigator)) return setLocationStatus("unsupported");
    // Browsers refuse geolocation outside a secure context, which includes
    // plain http:// on a LAN address -- localhost is the only exception.
    if (!window.isSecureContext) return setLocationStatus("insecure");
    if (!navigator.permissions?.query) return setLocationStatus("prompt");

    let subscription: PermissionStatus | undefined;
    const apply = (state: PermissionState) =>
      setLocationStatus(state === "prompt" ? "prompt" : state);
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((result) => {
        subscription = result;
        apply(result.state);
        result.onchange = () => apply(result.state);
      })
      // Safari has only recently supported this; assume we can still ask.
      .catch(() => setLocationStatus("prompt"));
    return () => {
      if (subscription) subscription.onchange = null;
    };
  }, []);

  useEffect(() => onUnauthorized(signOut), [signOut]);
  useEffect(() => ws.onStatusChange(setConnected), []);

  /** Loads everything the signed-in rider needs for their current group. */
  const refresh = useCallback(async () => {
    if (!session.token()) return;
    try {
      const list = await groupsApi.list();
      setGroups(list);

      const selected =
        list.find((candidate) => candidate.id === activeGroupId) ?? list[0] ?? null;
      if (!selected) {
        setMembers([]);
        setLocations([]);
        setMessages([]);
        setRide(null);
        setSosAlerts([]);
        return;
      }
      if (selected.id !== activeGroupId) setActiveGroupId(selected.id);

      const [groupMembers, groupLocations, groupMessages, alerts] = await Promise.all([
        groupsApi.members(selected.id),
        groupsApi.locations(selected.id),
        groupsApi.messages(selected.id),
        groupsApi.activeSos(selected.id),
      ]);
      setMembers(groupMembers);
      setLocations(groupLocations);
      setMessages(groupMessages);
      setSosAlerts(alerts);
      setRide(selected.activeRideId ? await ridesApi.get(selected.activeRideId) : null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your ride data.");
    }
  }, [activeGroupId]);

  // Confirm the stored token is still valid before trusting the cached rider.
  useEffect(() => {
    if (!session.token()) {
      setReady(true);
      return;
    }
    let cancelled = false;
    authApi
      .me()
      .then(({ access_token: refreshed, ...fresh }) => {
        if (cancelled) return;
        setUser(fresh);
        // Store the refreshed token so the seven-day window starts again.
        session.save(refreshed || session.token()!, fresh);
      })
      .catch(() => {})
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    ws.connect();
    void refresh();
  }, [user, refresh]);

  // Live events. Anything that changes derived stats re-reads the ride.
  useEffect(() => {
    if (!user) return;
    return ws.subscribe((event) => {
      switch (event.type) {
        case "location_update": {
          const incoming = toLocation(event as Record<string, unknown>);
          setLocations((current) => [
            ...current.filter((entry) => entry.userId !== incoming.userId),
            incoming,
          ]);
          setMembers((current) =>
            current.map((member) =>
              member.id === incoming.userId
                ? { ...member, online: true, lastLocationAt: incoming.timestamp }
                : member,
            ),
          );
          break;
        }
        case "chat_message": {
          const incoming = toMessage(event as Record<string, unknown>);
          setMessages((current) => {
            const withoutOptimistic = current.filter(
              (entry) =>
                entry.id !== incoming.id &&
                !(incoming.clientId && entry.id === incoming.clientId),
            );
            return [...withoutOptimistic, incoming];
          });
          setTyping((current) => {
            const next = { ...current };
            delete next[incoming.senderId];
            return next;
          });
          break;
        }
        case "typing": {
          const userId = String(event.userId);
          if (userId === user.id) break;
          setTyping((current) =>
            event.isTyping === false
              ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== userId))
              : { ...current, [userId]: { name: String(event.name), at: Date.now() } },
          );
          break;
        }
        case "presence": {
          const userId = String(event.userId);
          setMembers((current) =>
            current.map((member) =>
              member.id === userId ? { ...member, online: Boolean(event.online) } : member,
            ),
          );
          break;
        }
        case "sos_trigger": {
          const alert = toSosAlert(event as Record<string, unknown>);
          setSosAlerts((current) => [
            alert,
            ...current.filter((entry) => entry.id !== alert.id),
          ]);
          break;
        }
        case "sos_cancel": {
          const alert = toSosAlert(event as Record<string, unknown>);
          setSosAlerts((current) => current.filter((entry) => entry.id !== alert.id));
          break;
        }
        case "ride_started":
        case "ride_ended":
        case "ride_left":
        case "ride_joined":
        case "member_left":
          void refresh();
          break;
        case "error":
          setError(String(event.detail ?? "Something went wrong."));
          break;
      }
    });
  }, [user, refresh]);

  // Expire stale typing hints; without this a dropped socket leaves one stuck.
  useEffect(() => {
    if (!Object.keys(typing).length) return;
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - TYPING_TIMEOUT_MS;
      setTyping((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(([, value]) => value.at > cutoff),
        );
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [typing]);

  const authenticate = async (request: () => Promise<{ access_token: string; user: User }>) => {
    setAuthLoading(true);
    try {
      const result = await request();
      session.save(result.access_token, result.user);
      setUser(result.user);
    } finally {
      setAuthLoading(false);
    }
  };

  const publishLocation = useCallback((position: GeolocationPosition) => {
    const groupId = groupIdRef.current;
    const next: RiderLocation = {
      userId: session.user()?.id ?? "",
      name: session.user()?.name ?? "",
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy ?? null,
      timestamp: new Date().toISOString(),
      online: true,
      rideId: null,
    };
    setMyLocation(next);
    setLocationError(null);
    // Your position only leaves the device while you are on a ride. Off a
    // ride it stays here, shown to you and to nobody else.
    if (groupId && ridingRef.current)
      ws.send({
        type: "location_update",
        groupId,
        latitude: next.latitude,
        longitude: next.longitude,
        accuracy: next.accuracy,
      });
  }, []);

  const startLocation = useCallback(() => {
    if (!groupIdRef.current) {
      setLocationError("Join or create a group before sharing your location.");
      return;
    }
    if (!("geolocation" in navigator)) {
      setLocationStatus("unsupported");
      setLocationError("This browser cannot share a location.");
      return;
    }
    if (!window.isSecureContext) {
      setLocationStatus("insecure");
      setLocationError("Location sharing needs a secure (https) connection.");
      return;
    }

    // Always drop the previous watch first. watchPosition hands back an id
    // even when it fails immediately, so holding on to it made every retry a
    // silent no-op -- the button appeared dead.
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setLocationError(null);

    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        setLocationStatus("granted");
        publishLocation(position);
      },
      (cause) => {
        if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
        setSharingLocation(false);
        if (cause.code === cause.PERMISSION_DENIED) {
          setLocationStatus("denied");
          setLocationError("Location is blocked for this site.");
        } else if (cause.code === cause.TIMEOUT) {
          setLocationError("Still looking for a GPS fix. Try somewhere with a clearer sky.");
        } else {
          setLocationError("Could not get a location fix yet.");
        }
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 },
    );
    setSharingLocation(true);
  }, [publishLocation]);

  const stopLocation = useCallback(() => {
    if (watchId.current !== null) navigator.geolocation?.clearWatch(watchId.current);
    watchId.current = null;
    setSharingLocation(false);
    setMyLocation(null);
  }, []);

  useEffect(() => () => stopLocation(), [stopLocation]);

  useEffect(() => {
    const riding = Boolean(ride && ride.joined && !ride.endedAt);
    ridingRef.current = riding;
    // Off a ride nobody is sharing, so hold no positions but your own.
    if (!riding) setLocations((current) => (current.length ? [] : current));
  }, [ride]);

  const sendMessage = async (text: string) => {
    if (!group) return;
    const clientId = crypto.randomUUID();
    const optimistic: Message = {
      id: clientId,
      clientId,
      senderId: user?.id ?? "",
      sender: user?.name ?? "",
      text,
      timestamp: new Date().toISOString(),
      status: "sending",
    };
    setMessages((current) => [...current, optimistic]);

    if (ws.send({ type: "chat_message", groupId: group.id, text, clientId })) return;
    // No socket: fall back to REST so the message is not lost.
    try {
      const saved = await groupsApi.sendMessage(group.id, text);
      setMessages((current) => current.map((m) => (m.id === clientId ? saved : m)));
    } catch {
      setMessages((current) =>
        current.map((m) => (m.id === clientId ? { ...m, status: "failed" } : m)),
      );
    }
  };

  const notifyTyping = () => {
    if (!group) return;
    const now = Date.now();
    if (now - typingSentAt.current < 1500) return;
    typingSentAt.current = now;
    ws.send({ type: "typing", groupId: group.id, isTyping: true });
  };

  const guard = async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      const result = await action();
      setError(null);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work.");
      throw cause;
    }
  };

  const mySos = useMemo(
    () => sosAlerts.find((alert) => alert.riderId === user?.id) ?? null,
    [sosAlerts, user],
  );

  const value = useMemo<Store>(
    () => ({
      user,
      authLoading,
      ready,
      connected,
      error,
      dismissError: () => setError(null),

      login: (email, password) => authenticate(() => authApi.login(email, password)),
      register: (name, email, password) =>
        authenticate(() => authApi.register(name, email, password)),
      logout: signOut,
      updateName: (name) =>
        guard(async () => {
          // The new token carries the new name, so chat and map pins follow.
          const updated = await authApi.updateName(name);
          session.save(updated.access_token, updated.user);
          setUser(updated.user);
          await refresh();
        }),

      groups,
      group,
      selectGroup,
      createGroup: (name) =>
        guard(async () => {
          const created = await groupsApi.create(name);
          selectGroup(created.id);
          await refresh();
          return created;
        }),
      joinGroup: (code) =>
        guard(async () => {
          const joined = await groupsApi.join(code);
          selectGroup(joined.id);
          await refresh();
          return joined;
        }),
      leaveGroup: (groupId) =>
        guard(async () => {
          await groupsApi.leave(groupId);
          localStorage.removeItem(ACTIVE_GROUP_KEY);
          setActiveGroupId(null);
          await refresh();
        }),

      members,
      locations,
      myLocation,
      locationError,
      locationStatus,
      sharingLocation,
      recenterToken,
      recenter: () => setRecenterToken((token) => token + 1),
      startLocation,
      stopLocation,

      ride,
      startRide: () =>
        guard(async () => {
          if (!group) return;
          await groupsApi.startRide(group.id);
          await refresh();
          startLocation();
        }),
      joinRide: () =>
        guard(async () => {
          if (!ride) return;
          await ridesApi.join(ride.id);
          await refresh();
          startLocation();
        }),
      endRideForEveryone: () =>
        guard(async () => {
          if (!ride) return;
          await ridesApi.end(ride.id);
          await refresh();
        }),
      leaveRide: () =>
        guard(async () => {
          if (!ride) return;
          await ridesApi.leave(ride.id);
          stopLocation();
          await refresh();
        }),

      messages,
      sendMessage,
      typingNames: Object.values(typing).map((entry) => entry.name),
      notifyTyping,

      sosAlerts,
      mySos,
      triggerSos: () =>
        guard(async () => {
          if (!group) throw new Error("Join a group before raising an SOS.");
          startLocation();
          const position = myLocation;
          if (!position)
            throw new Error("Waiting for a location fix — try again in a moment.");
          ws.send({
            type: "sos_trigger",
            groupId: group.id,
            latitude: position.latitude,
            longitude: position.longitude,
          });
        }),
      cancelSos: () =>
        guard(async () => {
          if (!group) return;
          ws.send({ type: "sos_cancel", groupId: group.id });
        }),

      refresh,
    }),
    [
      user,
      authLoading,
      ready,
      connected,
      error,
      signOut,
      groups,
      group,
      selectGroup,
      members,
      locations,
      myLocation,
      locationError,
      locationStatus,
      sharingLocation,
      recenterToken,
      startLocation,
      stopLocation,
      ride,
      messages,
      typing,
      sosAlerts,
      mySos,
      refresh,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useApp = () => {
  const store = useContext(Ctx);
  if (!store) throw new Error("AppProvider is missing");
  return store;
};
