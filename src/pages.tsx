import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LiveMap } from "./components/LiveMap";
import { useApp } from "./store/appStore";

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const pad = (value: number) => String(value).padStart(2, "0");

/** Stopwatch format: mm:ss for a short ride, hh:mm:ss once it passes an hour. */
const duration = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const body = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return hours > 0 ? `${pad(hours)}:${body}` : body;
};

/**
 * Counts up every second while a ride is running, so the duration is live
 * instead of frozen at whatever the last refresh reported.
 */
function useElapsed(startedAt?: string, endedAt?: string | null, reported = 0) {
  const [now, setNow] = useState(() => Date.now());
  const running = Boolean(startedAt) && !endedAt;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!startedAt || !running) return reported;
  return Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
}

const EyeIcon = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {off ? (
      <>
        <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a17.6 17.6 0 0 1-2.2 3.2M6.6 6.6A17.6 17.6 0 0 0 2 12s3 8 10 8a9.1 9.1 0 0 0 5.4-1.6" />
        <path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" />
        <path d="m2 2 20 20" />
      </>
    ) : (
      <>
        <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    )}
  </svg>
);

export function Auth({ register = false }: { register?: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const { login, register: signup, authLoading } = useApp();
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      if (register) await signup(name, email, password);
      else await login(email, password);
      navigate("/map");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not continue. Please try again.");
    }
  }

  return (
    <div className="auth">
      <div className="auth-mark">RM</div>
      <p className="eyebrow">RIDE TOGETHER. STAY TOGETHER.</p>
      <h1>{register ? "Create your account" : "Welcome back"}</h1>
      <p className="muted">
        {register ? "Your next adventure starts here." : "Your crew is already on the road."}
      </p>
      <form onSubmit={submit}>
        {register && (
          <label>
            Name
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <label>
          Email
          <input
            required
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <div className="pwfield">
            <input
              required
              minLength={8}
              type={showPassword ? "text" : "password"}
              autoComplete={register ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                // Clearing the field also re-hides it, so retyping never
                // starts out in plain text unexpectedly.
                if (!e.target.value) setShowPassword(false);
              }}
            />
            {password.length > 0 && (
              <button
                type="button"
                className="pweye"
                onClick={() => setShowPassword((shown) => !shown)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
              >
                <EyeIcon off={showPassword} />
              </button>
            )}
          </div>
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={authLoading}>
          {authLoading ? "Connecting…" : register ? "Create account" : "Sign in"}
        </button>
      </form>
      <p className="switch">
        {register ? "Already part of RideMate?" : "New to RideMate?"}{" "}
        <Link to={register ? "/login" : "/register"}>
          {register ? "Sign in" : "Create account"}
        </Link>
      </p>
    </div>
  );
}

export function MapPage() {
  const { group, ride, locations, myLocation, locationError, startLocation } = useApp();
  const onlineRiders = new Set(
    locations.filter((entry) => entry.online).map((entry) => entry.userId),
  );
  if (myLocation) onlineRiders.add(myLocation.userId);

  if (!group)
    return (
      <div className="page">
        <p className="eyebrow">ACTIVE RIDE</p>
        <h1>No group yet</h1>
        <p className="muted">
          Create a group or join one with an invite code to start sharing your location.
        </p>
        <div className="actions">
          <Link className="primary" to="/groups" style={{ display: "grid", placeItems: "center" }}>
            Go to groups
          </Link>
        </div>
      </div>
    );

  return (
    <>
      <div className="maphead">
        <div>
          <p className="eyebrow">{ride ? "ACTIVE RIDE" : "NO RIDE RUNNING"}</p>
          <h1>{group.name}</h1>
          <p className="muted">
            {onlineRiders.size === 1
              ? "1 rider sharing live location"
              : `${onlineRiders.size} riders sharing live location`}
          </p>
        </div>
        <button className="round" onClick={startLocation} aria-label="Share my location">
          ⌖
        </button>
      </div>
      {locationError && (
        <div className="notice">
          {locationError} <button onClick={startLocation}>Retry</button>
        </div>
      )}
      <LiveMap />
      <Link className="map-card" to="/ride">
        {ride && <span className="pulse" />}
        <div>
          <b>
            {!ride ? "Start a ride" : ride.joined ? "Ride in progress" : "Join the ride"}
          </b>
          <small>
            {ride
              ? `${ride.riderCount} riding · ${ride.distanceKm.toFixed(1)} km`
              : "Nobody is riding right now"}
          </small>
        </div>
        <span>›</span>
      </Link>
    </>
  );
}

export function ChatPage() {
  const { group, messages, sendMessage, typingNames, notifyTyping, user } = useApp();
  const [text, setText] = useState("");

  if (!group)
    return (
      <div className="page">
        <p className="eyebrow">GROUP CHANNEL</p>
        <h1>No group yet</h1>
        <p className="muted">Join a group to start talking to your crew.</p>
      </div>
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    await sendMessage(trimmed);
  };

  const typingLabel =
    typingNames.length === 1
      ? `${typingNames[0]} is typing…`
      : typingNames.length > 1
        ? `${typingNames.length} riders are typing…`
        : "";

  return (
    <div className="chat">
      <Link className="chat-head" to={`/groups/${group.id}`}>
        <div>
          <p className="eyebrow">GROUP CHANNEL</p>
          <h1>{group.name}</h1>
        </div>
        <span className="chevron" aria-hidden="true">
          ›
        </span>
      </Link>
      <p className="typing">{typingLabel || " "}</p>
      <div className="messages">
        {messages.length === 0 && (
          <p className="muted">No messages yet. Say hello to your crew.</p>
        )}
        {messages.map((message) => {
          const mine = message.senderId === user?.id;
          return (
            <article key={message.id} className={mine ? "mine" : ""}>
              <b>{mine ? "You" : message.sender}</b>
              <p>{message.text}</p>
              <small>
                {clock(message.timestamp)}
                {message.status === "sending" && " · Sending"}
                {message.status === "failed" && " · Failed"}
              </small>
            </article>
          );
        })}
      </div>
      <form className="composer" onSubmit={submit}>
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            notifyTyping();
          }}
          placeholder={`Message ${group.name}`}
        />
        <button aria-label="Send message">↑</button>
      </form>
    </div>
  );
}

export function GroupsPage() {
  const { groups, group, selectGroup, createGroup, joinGroup } = useApp();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"view" | "join" | "create">("view");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  /** Tapping a group makes it the active one and opens its chat. */
  const openChat = (groupId: string) => {
    selectGroup(groupId);
    navigate("/chat");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setFormError("");
    try {
      if (mode === "create") await createGroup(trimmed);
      else await joinGroup(trimmed);
      setValue("");
      setMode("view");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <p className="eyebrow">YOUR CREW</p>
      <h1>Groups</h1>

      {groups.length === 0 && (
        <p className="muted">
          You are not in a group yet. Create one, or join with an invite code from a friend.
        </p>
      )}

      {groups.map((entry) => (
        <section
          className="group-card"
          key={entry.id}
          onClick={() => openChat(entry.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => event.key === "Enter" && openChat(entry.id)}
        >
          <div className="group-icon">⌁</div>
          <div>
            <b>{entry.name}</b>
            <small>
              {entry.memberCount} {entry.memberCount === 1 ? "member" : "members"}
              {entry.activeRideId ? " · Riding now" : ""}
            </small>
          </div>
          {entry.id === group?.id && <span className="green">●</span>}
          <span className="chevron">›</span>
        </section>
      ))}

      {mode === "view" ? (
        <div className="actions">
          <button className="primary" onClick={() => setMode("create")}>
            Create a group
          </button>
          <button className="secondary" onClick={() => setMode("join")}>
            Join with invite code
          </button>
        </div>
      ) : (
        <form className="panel" onSubmit={submit}>
          <h2>{mode === "create" ? "Create a group" : "Join a group"}</h2>
          <input
            autoFocus
            placeholder={mode === "create" ? "Group name" : "Invite code"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {formError && <p className="error">{formError}</p>}
          <button className="primary" disabled={busy}>
            {busy ? "Working…" : "Continue"}
          </button>
          <button
            type="button"
            className="textbtn"
            onClick={() => {
              setMode("view");
              setFormError("");
            }}
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

/** Everything specific to one group: its code, its members, leaving it. */
export function GroupInfoPage() {
  const { groupId } = useParams();
  const { groups, group, members, ride, selectGroup, leaveGroup, user } = useApp();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const target = groups.find((entry) => entry.id === groupId) ?? null;

  // Member and presence data in the store follows the active group.
  useEffect(() => {
    if (target && target.id !== group?.id) selectGroup(target.id);
  }, [target, group, selectGroup]);

  if (!target)
    return (
      <div className="page">
        <p className="eyebrow">GROUP INFO</p>
        <h1>Group unavailable</h1>
        <p className="muted">You are not a member of this group, or it no longer exists.</p>
        <Link className="secondary linkbtn" to="/groups">
          Back to groups
        </Link>
      </div>
    );

  const showingMembers = target.id === group?.id ? members : [];

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(target.inviteCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const leave = async () => {
    if (!window.confirm(`Leave ${target.name}?`)) return;
    setBusy(true);
    try {
      await leaveGroup(target.id);
      navigate("/groups");
    } catch {
      // The store surfaces the failure in the shared error banner.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <Link className="backlink" to="/chat">
        ‹ Back to chat
      </Link>
      <p className="eyebrow">GROUP INFO</p>
      <h1>{target.name}</h1>
      <p className="muted">
        {target.memberCount} {target.memberCount === 1 ? "member" : "members"} ·{" "}
        {ride && target.activeRideId ? "Riding now" : "No ride running"}
      </p>

      <section className="panel">
        <b>Invite code</b>
        <p className="muted">Share this with a rider so they can join {target.name}.</p>
        <button className="secondary codebtn" onClick={copyCode}>
          <span className="code">{target.inviteCode}</span>
          <small>{copied ? "Copied" : "Tap to copy"}</small>
        </button>
      </section>

      <h2>Members</h2>
      {showingMembers.length === 0 && <p className="muted">Loading members…</p>}
      {showingMembers.map((member) => (
        <div className="member" key={member.id}>
          <span className="avatar">{member.name.charAt(0).toUpperCase()}</span>
          <div>
            <b>
              {member.name}
              {member.id === user?.id && " (you)"}
              {member.id === target.ownerId && " · Owner"}
            </b>
            <small>
              {member.online
                ? "Online · sharing location"
                : member.lastLocationAt
                  ? `Last seen ${clock(member.lastLocationAt)}`
                  : "Offline"}
            </small>
          </div>
          <i className={member.online ? "online" : ""} />
        </div>
      ))}

      <button className="secondary danger" disabled={busy} onClick={leave}>
        {busy ? "Leaving…" : `Leave ${target.name}`}
      </button>
    </div>
  );
}

export function RidePage() {
  const { group, ride, members, startRide, joinRide, endRideForEveryone, leaveRide, user } =
    useApp();
  const [busy, setBusy] = useState(false);
  const elapsed = useElapsed(ride?.startedAt, ride?.endedAt, ride?.durationSeconds);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      // The store surfaces the failure in the shared error banner.
    } finally {
      setBusy(false);
    }
  };

  if (!group)
    return (
      <div className="page">
        <p className="eyebrow">CURRENT SESSION</p>
        <h1>No group yet</h1>
        <p className="muted">Join a group before starting a ride.</p>
      </div>
    );

  if (!ride)
    return (
      <div className="page">
        <p className="eyebrow">CURRENT SESSION</p>
        <h1>{group.name}</h1>
        <section className="ride-hero">
          <span>⌁</span>
          <p>
            {group.memberCount} {group.memberCount === 1 ? "member" : "members"}
          </p>
          <b>No ride running</b>
        </section>
        <section className="panel">
          <b>Start riding together</b>
          <p className="muted">
            Starting a ride shares live locations with everyone in {group.name} until it ends.
          </p>
          <button className="primary" disabled={busy} onClick={() => run(startRide)}>
            {busy ? "Starting…" : "Start a ride"}
          </button>
        </section>
      </div>
    );

  if (!ride.joined)
    return (
      <div className="page">
        <p className="eyebrow">CURRENT SESSION</p>
        <h1>{ride.groupName}</h1>
        <section className="ride-hero">
          <span>⌁</span>
          <p>Started {clock(ride.startedAt)}</p>
          <b>{group.name} is riding</b>
        </section>
        <div className="stats">
          <div>
            <b>{String(ride.riderCount).padStart(2, "0")}</b>
            <small>Riders</small>
          </div>
          <div>
            <b>{ride.distanceKm.toFixed(1)}</b>
            <small>km together</small>
          </div>
          <div>
            <b>{duration(elapsed)}</b>
            <small>Duration</small>
          </div>
        </div>
        <section className="panel">
          <b>You are not on this ride</b>
          <p className="muted">
            Join it to share your live location with {group.name}. A group rides together, so
            there is only ever one ride at a time — join this one instead of starting another.
          </p>
          <button className="primary" disabled={busy} onClick={() => run(joinRide)}>
            {busy ? "Joining…" : "Join this ride"}
          </button>
        </section>
      </div>
    );

  const canEndForEveryone = ride.startedBy === user?.id || group.ownerId === user?.id;
  const onlineCount = members.filter((member) => member.online).length;

  return (
    <div className="page">
      <p className="eyebrow">CURRENT SESSION</p>
      <h1>{ride.groupName}</h1>
      <section className="ride-hero">
        <span>⌁</span>
        <p>Started {clock(ride.startedAt)}</p>
        <b>Ride in progress</b>
      </section>
      <div className="stats">
        <div>
          <b>{String(ride.riderCount).padStart(2, "0")}</b>
          <small>Riders</small>
        </div>
        <div>
          <b>{ride.distanceKm.toFixed(1)}</b>
          <small>km together</small>
        </div>
        <div>
          <b>{duration(elapsed)}</b>
          <small>Duration</small>
        </div>
      </div>
      <section className="panel">
        <b>{group.name}</b>
        <p className="muted">
          {onlineCount} of {group.memberCount} riders are sharing a live location right now.
        </p>
        <button className="secondary" disabled={busy} onClick={() => run(leaveRide)}>
          {busy ? "Working…" : "End ride for me"}
        </button>
        {canEndForEveryone && (
          <button className="secondary" disabled={busy} onClick={() => run(endRideForEveryone)}>
            End ride for everyone
          </button>
        )}
      </section>
    </div>
  );
}

export function ProfilePage() {
  const { user, logout, groups, connected, updateName } = useApp();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const startEditing = () => {
    setName(user?.name ?? "");
    setFormError("");
    setEditing(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === user?.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      await updateName(trimmed);
      setEditing(false);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not save your name.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <p className="eyebrow">ACCOUNT</p>
      <div className="profile">
        <span className="avatar large">{user?.name.charAt(0).toUpperCase()}</span>
        {editing ? (
          <form className="namebox" onSubmit={save}>
            <input
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Your name"
            />
            {formError && <p className="error">{formError}</p>}
            <div className="namebox-actions">
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="textbtn"
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <h1>{user?.name}</h1>
            <button className="textbtn editname" onClick={startEditing}>
              Edit name
            </button>
          </>
        )}
        <p className="muted">{user?.email}</p>
      </div>
      <section className="panel">
        <b>Safety & privacy</b>
        <p className="muted">
          Live location is shared only with groups you belong to, and only while you are sharing.
        </p>
        <small>
          {groups.length} {groups.length === 1 ? "group" : "groups"} ·{" "}
          {connected ? "Connected to live updates" : "Reconnecting…"}
        </small>
      </section>
      <button className="secondary" onClick={logout}>
        Sign out
      </button>
    </div>
  );
}
