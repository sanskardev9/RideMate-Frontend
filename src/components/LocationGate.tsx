import { useEffect } from "react";
import { useApp } from "../store/appStore";

/**
 * A page cannot grant itself geolocation — only the browser's own prompt can,
 * and once someone denies it the browser refuses to ask again. So this
 * explains why we want a position before triggering the real prompt, and when
 * it has already been blocked it shows how to turn it back on.
 */

/**
 * Every browser hides this in a different place, and on iOS there are two
 * separate switches: one for the app in iOS Settings, and one for this site
 * inside the browser. Sending someone to the wrong menu is worse than saying
 * nothing, so each case is named specifically.
 */
const ua = () => navigator.userAgent;
const isIos = () => /iPad|iPhone|iPod/.test(ua());
// Every iOS browser is WebKit underneath, but their menus differ completely.
const iosBrowser = () =>
  /CriOS/.test(ua()) ? "Chrome" : /FxiOS/.test(ua()) ? "Firefox" : /EdgiOS/.test(ua()) ? "Edge" : "Safari";

function reEnableSteps() {
  if (isIos()) {
    const app = iosBrowser();
    if (app === "Safari")
      return [
        "Open iOS Settings, then Privacy & Security, then Location Services",
        "Turn it on, and set Safari Websites to While Using the App",
        "Back in Safari, tap AA on the left of the address bar",
        "Choose Website Settings and set Location to Ask or Allow",
        "Return here and reload",
      ];
    return [
      `Open iOS Settings, scroll to ${app}, tap Location`,
      "Choose While Using the App",
      `In ${app}, tap the ••• menu, then Settings, then Content Settings`,
      "Open Location and allow it for this site",
      "Return here and reload",
    ];
  }
  if (/Android/.test(ua()))
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

  // Keep the sheet open: if the browser has already blocked us the request
  // fails instantly, and the sheet turns into the instructions in place
  // rather than making someone hunt for a second button.
  const allow = () => startLocation();

  useEffect(() => {
    if (locationStatus === "granted") onClose();
  }, [locationStatus, onClose]);

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
