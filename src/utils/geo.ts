/** Straight-line distances between riders — good enough at ride scale. */
const EARTH_RADIUS_M = 6371000;

type Coords = { latitude: number; longitude: number };

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: Coords, b: Coords): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Riders care about "how far ahead is she", not about precision: metres up
 * close, one decimal into the first few kilometres, whole kilometres beyond.
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 950) return `${Math.max(0, Math.round(meters / 10) * 10)} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** The widest gap between any two riders — how strung out the group is. */
export function groupSpreadMeters(riders: Coords[]): number {
  let widest = 0;
  for (let i = 0; i < riders.length; i += 1)
    for (let j = i + 1; j < riders.length; j += 1)
      widest = Math.max(widest, distanceMeters(riders[i], riders[j]));
  return widest;
}
