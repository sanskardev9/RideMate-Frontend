import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useApp } from "../store/appStore";
import type { RiderLocation } from "../types";
import { distanceMeters, formatDistance } from "../utils/geo";
import { isStale, shortAge } from "../utils/time";

/** Shown until the first rider location arrives; no ride data is implied by it. */
const FALLBACK_VIEW: { center: L.LatLngExpression; zoom: number } = { center: [20, 0], zoom: 2 };
/** Pins closer together than this on screen are gathered into one bubble. */
const CLUSTER_PX = 34;
/** How far a scattered pin sits from the middle of its cluster. */
const SCATTER_PX = 30;

type Placed = { rider: RiderLocation; point: L.Point };
type Cluster = { key: string; members: Placed[]; centre: L.Point };

/**
 * Riders bunched together — at a light, a chai stop, the start of a ride —
 * land within a few pixels of each other and their pins cover each other up.
 * Rather than nudging every pin permanently out of place, gather them into
 * one bubble carrying the count. Tapping it scatters that group so each rider
 * can be read, with a hairline back to the real spot; tapping the map puts
 * them back. Only the group you asked about is ever disturbed.
 */
function clusterRiders(map: L.Map, riders: RiderLocation[]): Cluster[] {
  const placed: Placed[] = riders.map((rider) => ({
    rider,
    point: map.latLngToLayerPoint([rider.latitude, rider.longitude]),
  }));

  const groups: Placed[][] = [];
  for (const entry of placed) {
    const group = groups.find((candidate) =>
      candidate.some((other) => other.point.distanceTo(entry.point) < CLUSTER_PX),
    );
    if (group) group.push(entry);
    else groups.push([entry]);
  }

  return groups.map((members) => ({
    // Stable while the same riders are together, so an open cluster stays
    // open as they inch along.
    key: members
      .map((entry) => entry.rider.userId)
      .sort()
      .join("|"),
    members,
    centre: L.point(
      members.reduce((sum, entry) => sum + entry.point.x, 0) / members.length,
      members.reduce((sum, entry) => sum + entry.point.y, 0) / members.length,
    ),
  }));
}

export function LiveMap() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | undefined>(undefined);
  /** Markers by id: `rider:<userId>` or `cluster:<key>`. */
  const markers = useRef(new Map<string, L.Marker>());
  const leaders = useRef(new Map<string, L.Polyline>());
  const hasFitted = useRef(false);
  // Bumped on zoom so the pixel-based clustering is redone for the new scale.
  const [viewVersion, setViewVersion] = useState(0);
  // A pin goes stale with nothing arriving, so age is re-checked on a timer.
  const [staleTick, setStaleTick] = useState(0);
  // The one cluster the rider has opened up, if any.
  const [openCluster, setOpenCluster] = useState<string | null>(null);

  const { locations, myLocation, startLocation, locationStatus, recenterToken, ride, user } =
    useApp();
  // Set when the rider asks to be centred, cleared once it has happened --
  // a fix may still be seconds away when the button is pressed.
  const pendingRecenter = useRef(false);
  // Read inside the setup effect, which must not re-run when this changes.
  const canAutoStart = useRef(locationStatus === "granted");
  canAutoStart.current = locationStatus === "granted";
  const cartoKey = import.meta.env.VITE_CARTO_KEY;

  // Other riders appear only while a ride is running. The server already
  // withholds them, but enforcing it here too means a stale response can never
  // put somebody on the map who is not sharing.
  const riders = useMemo(() => {
    const others = ride?.joined
      ? locations.filter((entry) => entry.userId !== myLocation?.userId)
      : [];
    return [...others, ...(myLocation ? [myLocation] : [])];
  }, [locations, myLocation, ride]);

  useEffect(() => {
    if (!container.current || map.current) return;
    const created = L.map(container.current, { zoomControl: false }).setView(
      FALLBACK_VIEW.center,
      FALLBACK_VIEW.zoom,
    );
    map.current = created;
    L.tileLayer(
      `https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png${cartoKey ? `?key=${cartoKey}` : ""}`,
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 20,
      },
    ).addTo(created);
    L.control.zoom({ position: "bottomright" }).addTo(created);
    created.on("zoomend", () => setViewVersion((version) => version + 1));
    // Tapping the map itself puts an opened cluster back together.
    created.on("click", () => setOpenCluster(null));
    // Only resume a permission already given. Firing the browser's prompt on
    // page load, with no explanation, is the surest way to get a refusal --
    // and a refusal cannot be undone from the page.
    if (canAutoStart.current) startLocation();

    const pins = markers.current;
    const lines = leaders.current;
    return () => {
      created.remove();
      map.current = undefined;
      pins.clear();
      lines.clear();
      hasFitted.current = false;
    };
  }, [startLocation, cartoKey]);

  useEffect(() => {
    if (recenterToken) pendingRecenter.current = true;
  }, [recenterToken]);

  // Asked to recentre: frame the whole group if others are sharing, and fall
  // back to just you when nobody else is — which is every moment off a ride.
  useEffect(() => {
    const current = map.current;
    if (!pendingRecenter.current || !current) return;
    const points = riders.map(
      (rider) => [rider.latitude, rider.longitude] as L.LatLngTuple,
    );
    // A fix may still be seconds away; stay armed until one arrives.
    if (!points.length) return;
    pendingRecenter.current = false;

    if (points.length > 1)
      current.fitBounds(L.latLngBounds(points), {
        padding: [56, 56],
        maxZoom: 16,
        animate: true,
      });
    else current.setView(points[0], Math.max(current.getZoom(), 16), { animate: true });
  }, [recenterToken, riders]);

  useEffect(() => {
    const current = map.current;
    if (!current) return;

    const clusters = clusterRiders(current, riders);
    const seen = new Set<string>();

    /** Adds or moves a marker, reusing the one already on the map. */
    const upsert = (
      id: string,
      position: L.LatLng,
      icon: L.DivIcon,
      label: string,
      detail: string | null,
      onClick?: () => void,
    ) => {
      seen.add(id);
      const existing = markers.current.get(id);
      if (existing) {
        existing.setLatLng(position);
        existing.setIcon(icon);
        existing.setTooltipContent(label);
        if (detail) existing.setPopupContent(detail);
        return existing;
      }
      const marker = L.marker(position, { icon })
        .addTo(current)
        .bindTooltip(label, {
          permanent: true,
          direction: "bottom",
          offset: [0, 15],
          className: "pin-label",
        });
      if (detail) marker.bindPopup(detail, { className: "pin-popup", closeButton: false });
      if (onClick) marker.on("click", onClick);
      markers.current.set(id, marker);
      return marker;
    };

    for (const cluster of clusters) {
      const scattered = cluster.members.length > 1 && openCluster === cluster.key;

      // A bunch of riders, left gathered: one bubble with the count on it.
      if (cluster.members.length > 1 && !scattered) {
        const nearest = myLocation
          ? Math.min(
              ...cluster.members
                .filter((entry) => entry.rider.userId !== myLocation.userId)
                .map((entry) => distanceMeters(myLocation, entry.rider)),
            )
          : Infinity;
        const hasMe = cluster.members.some(
          (entry) => entry.rider.userId === (myLocation?.userId ?? user?.id),
        );
        const id = `cluster:${cluster.key}`;
        upsert(
          id,
          current.layerPointToLatLng(cluster.centre),
          L.divIcon({
            className: "rider-cluster",
            html: `<span class="${hasMe ? "me" : ""}">${cluster.members.length}</span>`,
            iconSize: [42, 42],
            iconAnchor: [21, 21],
          }),
          `<span>${cluster.members.length} riders together${
            Number.isFinite(nearest) ? ` · ${formatDistance(nearest)}` : ""
          }</span>`,
          null,
          () => setOpenCluster(cluster.key),
        );
        continue;
      }

      cluster.members.forEach((entry, index) => {
        const { rider } = entry;
        // Scattered: fan the pins evenly around where they actually are.
        const position = scattered
          ? current.layerPointToLatLng(
              L.point(
                cluster.centre.x +
                  (SCATTER_PX + (cluster.members.length - 2) * 5) *
                    Math.cos(-Math.PI / 2 + (2 * Math.PI * index) / cluster.members.length),
                cluster.centre.y +
                  (SCATTER_PX + (cluster.members.length - 2) * 5) *
                    Math.sin(-Math.PI / 2 + (2 * Math.PI * index) / cluster.members.length),
              ),
            )
          : current.layerPointToLatLng(entry.point);

        const stale = !rider.online || isStale(rider.timestamp);
        const isMe = rider.userId === (myLocation?.userId ?? user?.id);
        const away =
          myLocation && !isMe ? formatDistance(distanceMeters(myLocation, rider)) : null;

        // The distance rides on the pin itself: one label per rider, so the
        // map reads the same with three riders or fifteen.
        const label = `<span class="${stale ? "stale" : ""}${isMe ? " me" : ""}">${
          isMe
            ? "You"
            : `${rider.name.split(" ")[0]}${away ? ` · ${away}` : ""}${
                stale ? ` · ${shortAge(rider.timestamp)}` : ""
              }`
        }</span>`;
        // Everything else is one tap away, rather than crowding the map.
        const detail = `<strong>${rider.name}</strong><br/>${
          stale ? `Last seen ${shortAge(rider.timestamp)} ago` : "Live"
        } · ${new Date(rider.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}${away ? `<br/>${away} from you` : ""}`;

        upsert(
          `rider:${rider.userId}`,
          position,
          L.divIcon({
            className: "rider-pin",
            html: `<span class="${isMe ? "me" : ""}${stale ? " stale" : ""}">${
              rider.name.charAt(0).toUpperCase() || "?"
            }</span>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
          }),
          label,
          detail,
        );

        // A hairline back to the real position, so a scattered pin is not
        // mistaken for where the rider is.
        const leaderId = rider.userId;
        const leader = leaders.current.get(leaderId);
        if (scattered) {
          const path: L.LatLngExpression[] = [
            current.layerPointToLatLng(entry.point),
            position,
          ];
          if (leader) leader.setLatLngs(path);
          else
            leaders.current.set(
              leaderId,
              L.polyline(path, {
                className: "rider-leader",
                weight: 1.5,
                opacity: 0.5,
                interactive: false,
              }).addTo(current),
            );
        } else if (leader) {
          leader.remove();
          leaders.current.delete(leaderId);
        }
      });
    }

    // Drop anything that has gone: riders who stopped sharing, and clusters
    // that have split up or been opened.
    for (const [id, marker] of markers.current)
      if (!seen.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    const present = new Set(riders.map((rider) => rider.userId));
    for (const [userId, leader] of leaders.current)
      if (!present.has(userId)) {
        leader.remove();
        leaders.current.delete(userId);
      }

    // Frame the group once, then leave the view under the rider's control.
    if (!hasFitted.current && riders.length) {
      const bounds = L.latLngBounds(
        riders.map((rider) => [rider.latitude, rider.longitude] as L.LatLngTuple),
      );
      current.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
      hasFitted.current = true;
    }
  }, [riders, user, myLocation, viewVersion, staleTick, openCluster]);

  useEffect(() => {
    const timer = window.setInterval(() => setStaleTick((n) => n + 1), 10000);
    return () => window.clearInterval(timer);
  }, []);

  return <div ref={container} className="map" />;
}
