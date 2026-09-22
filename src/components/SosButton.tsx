import { useCallback, useEffect, useRef, useState } from "react";

// A floating SOS button. At rest it tucks itself half off the edge of the app
// so it never covers the screen; a tap slides it fully out, a second tap asks
// for confirmation. It can be dragged anywhere and flies to whichever corner
// it was dropped nearest, and that corner is remembered for next time.
type Corner = "tl" | "tr" | "bl" | "br";
type Point = { x: number; y: number };

const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];
const STORAGE_KEY = "ridemate.sos.corner";
const SIZE = 64;
const EDGE = 14; // gap from the edge once it is out
const TOP = 76; // clears the topbar
const BOTTOM = 178; // clears the bottom nav and the ride card over the map
const TAP_SLOP = 8; // px of travel still counted as a tap, not a drag
const TUCK_MS = 4000; // how long it stays out before tucking back in

const isLeft = (corner: Corner) => corner === "tl" || corner === "bl";
const isTop = (corner: Corner) => corner === "tl" || corner === "tr";

function readCorner(): Corner {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (CORNERS as string[]).includes(saved)) return saved as Corner;
  } catch {
    /* private mode / blocked storage: fall back to the default corner */
  }
  return "bl";
}

// The button belongs to the centred app column, not the whole window.
function column() {
  const width = Math.min(window.innerWidth, 560);
  const left = (window.innerWidth - width) / 2;
  return { left, right: left + width };
}

/** Where a fully visible button may sit. */
function bounds() {
  const { left, right } = column();
  return {
    left: left + EDGE,
    right: right - EDGE - SIZE,
    top: TOP,
    bottom: Math.max(TOP, window.innerHeight - BOTTOM - SIZE),
  };
}

function restingPoint(corner: Corner, out: boolean): Point {
  const b = bounds();
  const { left, right } = column();
  const x = out
    ? isLeft(corner)
      ? b.left
      : b.right
    : // Tucked: half the circle hangs past the edge of the column.
      isLeft(corner)
      ? left - SIZE / 2
      : right - SIZE / 2;
  return { x, y: isTop(corner) ? b.top : b.bottom };
}

function nearestCorner(point: Point): Corner {
  return CORNERS.reduce((best, corner) => {
    const a = restingPoint(corner, true);
    const b = restingPoint(best, true);
    const da = (a.x - point.x) ** 2 + (a.y - point.y) ** 2;
    const db = (b.x - point.x) ** 2 + (b.y - point.y) ** 2;
    return da < db ? corner : best;
  }, CORNERS[0]);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function SosButton({
  active,
  groupName,
  onTrigger,
  onCancel,
}: {
  active: boolean;
  groupName: string;
  onTrigger: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [drag, setDrag] = useState<Point | null>(null);
  const [out, setOut] = useState(false);
  const [open, setOpen] = useState(false);
  const [, force] = useState(0);
  const grab = useRef<{
    dx: number;
    dy: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  // Resting spots come from the viewport, so recompute them on resize.
  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Slide back to the edge on its own, unless an SOS is actually running --
  // a live alert stays in plain sight until the rider stands it down.
  useEffect(() => {
    if (!out || open || drag || active) return;
    const timer = window.setTimeout(() => setOut(false), TUCK_MS);
    return () => window.clearTimeout(timer);
  }, [out, open, drag, active]);

  useEffect(() => {
    if (active) setOut(true);
  }, [active]);

  const settle = useCallback((next: Corner) => {
    setCorner(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* the position simply is not remembered next time */
    }
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    grab.current = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const held = grab.current;
    if (!held) return;
    // Measure travel from where the finger went down, so a slow drag still
    // counts and a shaky tap still opens the panel instead of relocating.
    if (Math.hypot(event.clientX - held.startX, event.clientY - held.startY) > TAP_SLOP)
      held.moved = true;
    if (!held.moved) return;
    const b = bounds();
    setDrag({
      x: clamp(event.clientX - held.dx, b.left, b.right),
      y: clamp(event.clientY - held.dy, b.top, b.bottom),
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const held = grab.current;
    grab.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (held?.moved && drag) {
      settle(nearestCorner(drag));
      setOut(active); // dropped: tuck back in unless an SOS is live
    } else if (held) {
      // First tap brings it out of the edge, the next one asks to send.
      if (out) setOpen(true);
      else setOut(true);
    }
    setDrag(null);
  };

  const point = drag ?? restingPoint(corner, out || Boolean(drag));
  const state = [
    "sos",
    isLeft(corner) ? "sos-left" : "sos-right",
    out || drag ? "sos-out" : "sos-tucked",
    active ? "sos-live" : "",
    drag ? "sos-held" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button
        className={state}
        aria-label={active ? "SOS active" : out ? "Send an SOS" : "Show the SOS button"}
        aria-expanded={out}
        style={{ left: point.x, top: point.y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span>SOS</span>
      </button>

      {open && (
        <div className="sos-sheet" onClick={() => setOpen(false)}>
          <div className="sos-panel" onClick={(event) => event.stopPropagation()}>
            {active ? (
              <>
                <h2>SOS is active</h2>
                <p>{groupName} can see your live location until you stand down.</p>
                <button
                  className="sos-go"
                  onClick={() => {
                    setOpen(false);
                    onCancel();
                  }}
                >
                  Stand down
                </button>
              </>
            ) : (
              <>
                <h2>Send an SOS?</h2>
                <p>
                  Everyone in {groupName} gets an alert with your current location,
                  straight away.
                </p>
                <button
                  className="sos-go"
                  disabled={sending}
                  onClick={async () => {
                    // Raising it may have to wait on a GPS fix, so say so
                    // rather than leaving the rider tapping a dead button.
                    setSending(true);
                    try {
                      await onTrigger();
                      setOpen(false);
                    } catch {
                      // The store puts the reason in the shared error banner.
                    } finally {
                      setSending(false);
                    }
                  }}
                >
                  {sending ? "Finding your location…" : "Send SOS now"}
                </button>
              </>
            )}
            <button className="sos-dismiss" onClick={() => setOpen(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
    </>
  );
}
