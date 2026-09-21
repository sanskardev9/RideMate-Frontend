import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useApp } from "../store/appStore";

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
    refresh,
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

  const confirmSos = () => {
    if (!group) return;
    if (
      window.confirm(`Send an SOS alert and your current location to ${group.name}?`)
    )
      void triggerSos();
  };

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
          SOS ACTIVE · Your group can see your live location
          <button onClick={() => void cancelSos()}>Cancel</button>
        </div>
      )}

      {othersInTrouble.map((alert) => (
        <div className="alert" key={alert.id}>
          {alert.riderName} raised an SOS
        </div>
      ))}

      <section className="content">{children}</section>

      {location.pathname !== "/profile" && group && (
        <button className="sos" aria-label="Trigger SOS" onClick={confirmSos}>
          SOS
          <small>Alert</small>
        </button>
      )}

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
