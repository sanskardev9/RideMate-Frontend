import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useApp } from "../store/appStore";
import { SosButton } from "./SosButton";
import { CallDock } from "./CallDock";

const nav = [
  ["/map", "◉", "Map"],
  ["/ride", "⌁", "Ride"],
  ["/chat", "◌", "Chat"],
  ["/groups", "◫", "Groups"],
  ["/profile", "◯", "Profile"],
] as const;

export function Layout({ children }: { children: React.ReactNode }) {
  const {
    sosAlerts,
    mySos,
    triggerSos,
    cancelSos,
    connected,
    error,
    dismissError,
    group,
    ride,
    refresh,
    alarmSounding,
    silenceAlarm,
  } = useApp();
  const location = useLocation();
  const lastPath = useRef(location.pathname);

  // Re-read the group's members, locations, chat and ride stats whenever the
  // rider moves between tabs. Live events keep the open tab current, but a tab
  // that was not open missed them, so it needs a fresh pull on arrival.
  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    void refresh();
  }, [location.pathname, refresh]);

  const othersInTrouble = sosAlerts.filter((alert) => alert.id !== mySos?.id);

  return (
    <main className="shell">
      <header className="topbar">
        <NavLink to="/map" className="brand">
          <i>RM</i>
          <span>RIDEMATE</span>
        </NavLink>
        <span className="status">
          <b />
          {connected ? "LIVE" : "OFFLINE"}
        </span>
      </header>

      {error && (
        <div className="notice">
          {error} <button onClick={dismissError}>Dismiss</button>
        </div>
      )}

      {mySos && (
        <div className="alert">
          <span className="alert-dot" />
          <div>
            <b>SOS active</b>
            <small>Your group can see your live location</small>
          </div>
          {alarmSounding && (
            <button className="alert-mute" onClick={silenceAlarm}>
              Mute
            </button>
          )}
          <button onClick={() => void cancelSos()}>Stand down</button>
        </div>
      )}

      {othersInTrouble.map((alert, index) => (
        <div className="alert" key={alert.id}>
          <span className="alert-dot" />
          <div>
            <b>{alert.riderName} raised an SOS</b>
            <small>Their pin is live on the map</small>
          </div>
          {/* One silence control is enough, however many alerts are up. */}
          {alarmSounding && !mySos && index === 0 && (
            <button className="alert-mute" onClick={silenceAlarm}>
              Mute
            </button>
          )}
        </div>
      ))}

      <section className="content">{children}</section>

      {/* An SOS carries your live position to the group you are riding with,
          so it only exists while you are actually on a ride. */}
      {location.pathname !== "/profile" && group && (ride?.joined || mySos) && (
        <SosButton
          active={Boolean(mySos)}
          groupName={group.name}
          onTrigger={triggerSos}
          onCancel={() => void cancelSos()}
        />
      )}

      <CallDock />

      <nav className="bottomnav">
        {nav.map(([to, icon, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : "")}>
            <i>{icon}</i>
            {label}
          </NavLink>
        ))}
      </nav>
    </main>
  );
}
