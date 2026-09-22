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
  sosApi,
  toLocation,
  toMessage,
  toSosAlert,
} from "../api/client";
import { ws } from "../websocket/manager";
import { startAlarm, stopAlarm, unlockAlarm } from "../audio/alarm";
import {
  backgroundKeepAliveSupported,
  holdScreenAwake,
  keepAliveState,
  letScreenSleep,
  onKeepAliveChange,
  startBackgroundKeepAlive,
  stopBackgroundKeepAlive,
} from "../location/keepAlive";
import type { KeepAliveState } from "../location/keepAlive";
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
/** Slowest we will post a position over HTTP while the socket is down. */
const REST_LOCATION_INTERVAL_MS = 5000;
/** How often to ask for a fix outright while tracking in the background. */
const BACKGROUND_FIX_INTERVAL_MS = 20000;
const TRACKING_MODE_KEY = "ridemate_tracking_mode";

/**
 * How hard the app works to keep reporting a position.
 *  - `screen`: hold a wake lock so a mounted phone does not sleep mid-ride.
 *  - `background`: also keep the tab alive when the rider switches apps.
 *    Android only, and best effort even there -- see location/keepAlive.ts.
 *  - `off`: report only while the app is open and awake.
 */
export type TrackingMode = "off" | "screen" | "background";

const readTrackingMode = (): TrackingMode => {
  const saved = localStorage.getItem(TRACKING_MODE_KEY);
  return saved === "off" || saved === "background" || saved === "screen" ? saved : "screen";
};

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
  trackingMode: TrackingMode;
  setTrackingMode: (mode: TrackingMode) => void;
  /** False on iOS, where a backgrounded page is suspended whatever we do. */
  backgroundTrackingSupported: boolean;
  /** Whether background tracking is actually running right now. */
  backgroundTracking: KeepAliveState;
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
  alarmSounding: boolean;
  silenceAlarm: () => void;

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
  // Alerts the rider has silenced. Kept by id, so a fresh SOS sounds again
  // even while an older one is still muted.
  const [silenced, setSilenced] = useState<string[]>([]);
  const [typing, setTyping] = useState<Record<string, { name: string; at: number }>>({});
  const [sharingLocation, setSharingLocation] = useState(false);
  const [trackingMode, setTrackingModeState] = useState<TrackingMode>(readTrackingMode);
  const [backgroundTracking, setBackgroundTracking] = useState(keepAliveState);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>("idle");
  const [recenterToken, setRecenterToken] = useState(0);

  const watchId = useRef<number | null>(null);
  const typingSentAt = useRef(0);
  // Read inside the geolocation callback, which outlives a single render.
  const groupIdRef = useRef<string | null>(activeGroupId);
  // Read inside the geolocation callback, which outlives a single render.
  const ridingRef = useRef(false);
  // The freshest fix, readable from an action that was created before it came
  // in -- an SOS raised seconds after opening the app must not miss it.
  const myLocationRef = useRef<RiderLocation | null>(null);
  // Throttles the HTTP fallback for position updates.
  const lastPostAt = useRef(0);

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
    myLocationRef.current = next;
    setLocationError(null);
    // Your position only leaves the device while you are on a ride. Off a
    // ride it stays here, shown to you and to nobody else.
    if (!groupId || !ridingRef.current) return;
    const sent = ws.send({
      type: "location_update",
      groupId,
      latitude: next.latitude,
      longitude: next.longitude,
      accuracy: next.accuracy,
    });
    if (sent) return;

    // The socket is down -- which is the normal state of affairs for a minute
    // after the app comes back from the background. Post over HTTP instead so
    // the group's map does not sit on a position from before the gap, but do
    // not hammer it: one update every few seconds is plenty.
    const now = Date.now();
    if (now - lastPostAt.current < REST_LOCATION_INTERVAL_MS) return;
    lastPostAt.current = now;
    void groupsApi
      .shareLocation(groupId, next.latitude, next.longitude, next.accuracy)
      .catch(() => undefined);
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
    myLocationRef.current = null;
  }, []);

  /**
   * One fix, awaited. The watch that startLocation sets up can be several
   * seconds from its first callback, and an SOS must not fail meanwhile and
   * ask the rider to press the button again.
   */
  const fixNow = useCallback(
    () =>
      new Promise<RiderLocation>((resolve, reject) => {
        if (!("geolocation" in navigator))
          return reject(new Error("This browser cannot share a location."));
        if (!window.isSecureContext)
          return reject(new Error("Location sharing needs a secure (https) connection."));
        navigator.geolocation.getCurrentPosition(
          (position) => {
            publishLocation(position);
            const fix = myLocationRef.current;
            if (fix) resolve(fix);
            else reject(new Error("Could not read your location."));
          },
          (cause) =>
            reject(
              new Error(
                cause.code === cause.PERMISSION_DENIED
                  ? "Location is blocked for this site. Allow it to raise an SOS."
                  : "No GPS fix yet — move somewhere with a clearer view of the sky.",
              ),
            ),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
        );
      }),
    [publishLocation],
  );

  useEffect(() => () => stopLocation(), [stopLocation]);

  const riding = Boolean(ride && ride.joined && !ride.endedAt);

  useEffect(() => {
    ridingRef.current = riding;
    // Off a ride nobody is sharing, so hold no positions but your own.
    if (!riding) setLocations((current) => (current.length ? [] : current));
  }, [riding]);

  // Keep reporting for as long as the ride lasts: hold the screen awake, and
  // in background mode keep the tab alive once the rider switches away.
  useEffect(() => {
    if (!riding || trackingMode === "off") return;
    holdScreenAwake();
    if (trackingMode === "background") startBackgroundKeepAlive();
    return () => {
      letScreenSleep();
      stopBackgroundKeepAlive();
    };
  }, [riding, trackingMode]);

  useEffect(() => onKeepAliveChange(setBackgroundTracking), []);

  // A watch that has been suspended in the background can come back without
  // firing, so in background mode ask for a fix outright on a timer as well.
  useEffect(() => {
    if (!riding || trackingMode !== "background") return;
    const timer = window.setInterval(() => {
      navigator.geolocation?.getCurrentPosition(publishLocation, () => undefined, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 10000,
      });
    }, BACKGROUND_FIX_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [riding, trackingMode, publishLocation]);

  // Coming back to the app after it was away: the socket is usually dead, the
  // watch may have stalled, and everything on screen is as old as the gap.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      ws.resume();
      if (watchId.current !== null) startLocation();
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [startLocation, refresh]);

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

  // A browser will not let audio start until the page has been interacted
  // with, so claim that permission on the first gesture -- long before an
  // alert arrives, when there is no time to ask.
  useEffect(() => {
    const unlock = () => unlockAlarm();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const unsilenced = sosAlerts.filter((alert) => !silenced.includes(alert.id)).length;

  // The siren runs on every rider's device -- whoever raised it and everyone
  // else in the group -- until the last alert is cancelled or silenced.
  useEffect(() => {
    if (unsilenced) startAlarm();
    else stopAlarm();
  }, [unsilenced]);

  // Never leave a siren running behind a closing app.
  useEffect(() => stopAlarm, []);

  // Once the group is clear, forget what was silenced so the next SOS sounds.
  useEffect(() => {
    if (!sosAlerts.length) setSilenced((current) => (current.length ? [] : current));
  }, [sosAlerts.length]);

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
      trackingMode,
      setTrackingMode: (mode) => {
        localStorage.setItem(TRACKING_MODE_KEY, mode);
        setTrackingModeState(mode);
      },
      backgroundTrackingSupported: backgroundKeepAliveSupported(),
      backgroundTracking,
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
          // An SOS is a position sent to the riders you are out with, so it
          // only means anything while a ride is running.
          if (!ridingRef.current)
            throw new Error("Start or join a ride before raising an SOS.");
          // Keep the watch running so the alert's position stays current, but
          // wait on a one-shot fix if none has arrived yet.
          startLocation();
          const position = myLocationRef.current ?? (await fixNow());
          const sent = ws.send({
            type: "sos_trigger",
            groupId: group.id,
            latitude: position.latitude,
            longitude: position.longitude,
          });
          if (sent) return;
          // No socket: raise it over HTTP instead, and show it locally since
          // the broadcast that normally feeds it back cannot reach us.
          const alert = await sosApi.trigger(
            group.id,
            position.latitude,
            position.longitude,
          );
          setSosAlerts((current) => [
            alert,
            ...current.filter((entry) => entry.id !== alert.id),
          ]);
        }),
      cancelSos: () =>
        guard(async () => {
          if (!group) return;
          if (ws.send({ type: "sos_cancel", groupId: group.id })) return;
          const alert = await sosApi.cancel(group.id);
          setSosAlerts((current) => current.filter((entry) => entry.id !== alert.id));
        }),
      alarmSounding: unsilenced > 0,
      silenceAlarm: () => setSilenced(sosAlerts.map((alert) => alert.id)),

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
      trackingMode,
      backgroundTracking,
      recenterToken,
      startLocation,
      stopLocation,
      ride,
      messages,
      typing,
      sosAlerts,
      mySos,
      unsilenced,
      fixNow,
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
