import { useEffect, useState } from "react";
import { calls, type CallState } from "../webrtc/manager";
import { startRingtone, stopRingtone } from "../audio/ringtone";

const clockFrom = (startedAt: number) => {
  const total = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * Everything a call looks like: the invitation when one arrives, and the bar
 * that sits above the nav while one is running. Mounted once, in the layout,
 * so a call survives moving between tabs.
 */
export function CallDock() {
  const [call, setCall] = useState<CallState | null>(null);
  const [, tick] = useState(0);

  useEffect(() => calls.subscribe(setCall), []);

  // Only the invitation rings; once answered the call speaks for itself.
  useEffect(() => {
    if (call?.phase === "ringing") startRingtone();
    else stopRingtone();
    return stopRingtone;
  }, [call?.phase]);

  // Keeps the call timer moving.
  useEffect(() => {
    if (!call?.startedAt) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [call?.startedAt]);

  if (!call) return null;

  const note = call.error && (
    <div className="callnote">
      {call.error}
      <button onClick={() => calls.dismissError()}>Dismiss</button>
    </div>
  );

  if (call.phase === "idle") return note || null;

  if (call.phase === "ringing")
    return (
      <div className="call-sheet">
        <div className="call-panel">
          <span className="call-avatar">{call.invitedBy?.name.charAt(0).toUpperCase()}</span>
          <h2>{call.invitedBy?.name}</h2>
          <p>{call.kind === "group" ? "is calling the group" : "is calling you"}</p>
          <div className="call-answer">
            <button className="call-decline" onClick={() => calls.decline()}>
              Decline
            </button>
            <button className="call-accept" onClick={() => void calls.accept()}>
              Answer
            </button>
          </div>
        </div>
      </div>
    );

  const connected = call.peers.filter((peer) => peer.connected);
  const status =
    call.phase === "calling"
      ? call.peers.length
        ? "Connecting…"
        : "Ringing…"
      : call.startedAt
        ? clockFrom(call.startedAt)
        : "Connected";

  return (
    <>
      {note}
      <div className="callbar">
        <span className={`call-dot${connected.length ? " on" : ""}`} />
        <div>
          <b>
            {call.kind === "group"
              ? `Group call · ${connected.length + 1} on the line`
              : call.peers[0]?.name || call.title}
          </b>
          <small>{status}</small>
        </div>
        <button
          className={`call-mute${call.micMuted ? " muted" : ""}`}
          onClick={() => calls.toggleMic()}
        >
          {call.micMuted ? "Unmute" : "Mute"}
        </button>
        <button className="call-end" onClick={() => calls.hangUp()}>
          End
        </button>
      </div>
    </>
  );
}
