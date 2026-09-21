import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useApp } from "../store/appStore";
import type { RiderLocation } from "../types";

/** Shown until the first rider location arrives; no ride data is implied by it. */
const FALLBACK_VIEW: { center: L.LatLngExpression; zoom: number } = { center: [20, 0], zoom: 2 };
/** Pins closer than this on screen are treated as sitting on the same spot. */
const OVERLAP_PX = 30;
/** How far each pin of a stack is pushed from the middle of the stack. */
const SPREAD_PX = 22;

type Placement = { position: L.LatLng; anchor: L.LatLng | null; stackSize: number };

/**
 * Riders parked together land on identical coordinates, so their pins hide each
 * other. Fan a stack out around its centre — in screen pixels, so the spread
 * looks the same at every zoom level — and remember the true spot so the pin
 * can be tied back to it with a leader line.
 */
function placeRiders(map: L.Map, riders: RiderLocation[]): Map<string, Placement> {
  const points = riders.map((rider) => ({
    rider,
    point: map.latLngToLayerPoint([rider.latitude, rider.longitude]),
  }));

  const stacks: (typeof points)[] = [];
  for (const entry of points) {
    const stack = stacks.find((candidate) =>
      candidate.some((other) => other.point.distanceTo(entry.point) < OVERLAP_PX),
    );
    if (stack) stack.push(entry);
    else stacks.push([entry]);
  }

  const placements = new Map<string, Placement>();
  for (const stack of stacks) {
    if (stack.length === 1) {
      const [only] = stack;
      placements.set(only.rider.userId, {
        position: map.layerPointToLatLng(only.point),
        anchor: null,
        stackSize: 1,
      });
      continue;
    }

    const centreX = stack.reduce((sum, entry) => sum + entry.point.x, 0) / stack.length;
    const centreY = stack.reduce((sum, entry) => sum + entry.point.y, 0) / stack.length;
    // Two riders sit left and right of centre; more riders form a ring.
    const radius = SPREAD_PX + (stack.length - 2) * 4;

    stack.forEach((entry, index) => {
      const angle = Math.PI + (2 * Math.PI * index) / stack.length;
      placements.set(entry.rider.userId, {
        position: map.layerPointToLatLng(
          L.point(centreX + radius * Math.cos(angle), centreY + radius * Math.sin(angle)),
        ),
        anchor: map.layerPointToLatLng(entry.point),
        stackSize: stack.length,
      });
    });
  }
  return placements;
}

export function LiveMap() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | undefined>(undefined);
  const markers = useRef(new Map<string, L.Marker>());
  const leaders = useRef(new Map<string, L.Polyline>());
  const hasFitted = useRef(false);
  // Bumped on zoom so the pixel-based spread is recalculated for the new scale.
  const [viewVersion, setViewVersion] = useState(0);

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

  useEffect(() => {
    if (!pendingRecenter.current || !map.current || !myLocation) return;
    pendingRecenter.current = false;
    map.current.setView(
      [myLocation.latitude, myLocation.longitude],
      Math.max(map.current.getZoom(), 16),
      { animate: true },
    );
  }, [recenterToken, myLocation]);

  useEffect(() => {
    const current = map.current;
    if (!current) return;

    const placements = placeRiders(current, riders);
    const seen = new Set<string>();

    for (const rider of riders) {
      seen.add(rider.userId);
      const placement = placements.get(rider.userId);
      if (!placement) continue;

      const sharedSpot =
        placement.stackSize > 1
          ? `<br/>Same spot as ${placement.stackSize - 1} other rider${placement.stackSize > 2 ? "s" : ""}`
          : "";
      const tooltip = `<strong>${rider.name}</strong><br/>${
        rider.online ? "Online" : "Offline"
      } · ${new Date(rider.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}${sharedSpot}`;

      const existing = markers.current.get(rider.userId);
      if (existing) {
        existing.setLatLng(placement.position);
        existing.setTooltipContent(tooltip);
      } else {
        const icon = L.divIcon({
          className: "rider-pin",
          html: `<span class="${rider.userId === user?.id ? "me" : ""}">${
            rider.name.charAt(0).toUpperCase() || "?"
          }</span>`,
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        });
        markers.current.set(
          rider.userId,
          L.marker(placement.position, { icon })
            .addTo(current)
            .bindTooltip(tooltip, { direction: "top" }),
        );
      }

      // A hairline back to the real position, so a nudged pin is not misread.
      const leader = leaders.current.get(rider.userId);
      if (placement.anchor) {
        const path: L.LatLngExpression[] = [placement.anchor, placement.position];
        if (leader) leader.setLatLngs(path);
        else
          leaders.current.set(
            rider.userId,
            L.polyline(path, {
              className: "rider-leader",
              weight: 1.5,
              opacity: 0.5,
              interactive: false,
            }).addTo(current),
          );
      } else if (leader) {
        leader.remove();
        leaders.current.delete(rider.userId);
      }
    }

    // Drop riders who stopped sharing, so the map never shows a stale pin.
    for (const [userId, marker] of markers.current)
      if (!seen.has(userId)) {
        marker.remove();
        markers.current.delete(userId);
        leaders.current.get(userId)?.remove();
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
  }, [riders, user, viewVersion]);

  return <div ref={container} className="map" />;
}
