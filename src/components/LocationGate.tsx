import { useApp } from "../store/appStore";

/**
 * A page cannot grant itself geolocation — only the browser's own prompt can,
 * and once someone denies it the browser refuses to ask again. So this
 * explains why we want a position before triggering the real prompt, and when
 * it has already been blocked it shows how to turn it back on.
 */

const isApple = () => /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
const isAndroid = () => /Android/.test(navigator.userAgent);
const isTouch = () => /iPad|iPhone|iPod|Android/.test(navigator.userAgent);

function reEnableSteps() {
  if (isApple() && isTouch())
    return [
      "Tap the AA button on the left of the address bar",
      "Choose Website Settings",
      "Set Location to Allow, then reload",
    ];
  if (isAndroid())
    return [
      "Tap the icon on the left of the address bar",
      "Open Permissions, then Location",
      "Switch it to Allow, then reload",
    ];
  return [
    "Click the icon on the left of the address bar",
    "Find Location in the list",
    "Set it to Allow, then reload",
  ];
}

export function LocationGate({ onClose }: { onClose: () => void }) {
  const { locationStatus, locationError, startLocation, group } = useApp();

  const allow = () => {
    startLocation();
    onClose();
  };

  const body = () => {
    if (locationStatus === "insecure")
      return {
        title: "Needs a secure connection",
        lead: "Browsers only share a location over https. This page is on a plain http address, so the prompt never appears.",
        steps: [
          "Open the app on its https address instead",
          "Or run it on localhost, which counts as secure",
        ],
        action: null,
      };

    if (locationStatus === "unsupported")
      return {
        title: "Location is not available",
        lead: "This browser does not offer location sharing, so your pin cannot be placed on the map.",
        steps: [],
        action: null,
      };

    if (locationStatus === "denied")
      return {
        title: "Location is blocked",
        lead: "You have turned location off for RideMate. Browsers will not ask again, so it has to be switched back on by hand.",
        steps: reEnableSteps(),
        action: null,
      };

    return {
      title: "Share your live location",
      lead: `${group ? group.name : "Your group"} sees your pin on the map while you are riding, and you see theirs. It stops the moment you end the ride.`,
      steps: [],
      action: "Allow location",
    };
  };

  const { title, lead, steps, action } = body();

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="location-gate-title"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="sheet-grip" aria-hidden="true" />
        <div className="sheet-icon" aria-hidden="true">
          ⌖
        </div>
        <h2 id="location-gate-title">{title}</h2>
        <p className="muted">{lead}</p>

        {steps.length > 0 && (
          <ol className="sheet-steps">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}

        {locationError && locationStatus !== "denied" && <p className="error">{locationError}</p>}

        {action ? (
          <button className="primary" onClick={allow}>
            {action}
          </button>
        ) : (
          <button className="primary" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        )}
        <button className="textbtn" onClick={onClose}>
          Not now
        </button>
      </section>
    </div>
  );
}
