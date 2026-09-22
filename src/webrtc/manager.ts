import { ws } from "../websocket/manager";
import { session } from "../api/client";

/**
 * Voice calls between riders: one to one, or the whole group at once.
 *
 * The topology is a mesh — every rider holds a peer connection to every
 * other — which keeps the server out of the media path entirely. That costs
 * each phone one upload per listener, so it is right for the handful of
 * riders in a group and wrong for a crowd; MAX_PEERS draws that line.
 *
 * Only the person already in the call ever sends an offer, and only to
 * somebody who has just announced they joined. That single rule is what
 * keeps two riders from offering each other at the same moment.
 */
const list = (value: string | undefined) => (value || "").split(",").filter(Boolean);

/**
 * STUN alone only works when both riders' networks let a direct path form.
 * On mobile data that is often not the case, and the call needs a TURN relay
 * to fall back to -- which, unlike STUN, takes credentials.
 */
const iceServers: RTCIceServer[] = [
  ...list(import.meta.env.VITE_STUN_SERVERS).map((urls) => ({ urls })),
  ...list(import.meta.env.VITE_TURN_SERVERS).map((urls) => ({
    urls,
    username: import.meta.env.VITE_TURN_USERNAME || undefined,
    credential: import.meta.env.VITE_TURN_CREDENTIAL || undefined,
  })),
];

/** Beyond this a mesh asks more of a phone's uplink than it can give. */
const MAX_PEERS = 5;

export type CallKind = "direct" | "group";
export type CallPhase = "idle" | "ringing" | "calling" | "active";

export type CallPeer = {
  userId: string;
  name: string;
  /** False until the audio is actually flowing. */
  connected: boolean;
};

export type CallState = {
  phase: CallPhase;
  kind: CallKind;
  callId: string | null;
  groupId: string | null;
  /** Who you are talking to: a rider's name, or the group's. */
  title: string;
  /** Set while an invitation is on screen, before it is answered. */
  invitedBy: { userId: string; name: string } | null;
  peers: CallPeer[];
  micMuted: boolean;
  startedAt: number | null;
  error: string | null;
};

const IDLE: CallState = {
  phase: "idle",
  kind: "group",
  callId: null,
  groupId: null,
  title: "",
  invitedBy: null,
  peers: [],
  micMuted: false,
  startedAt: null,
  error: null,
};

type Listener = (state: CallState) => void;

class CallManager {
  private state: CallState = IDLE;
  private listeners = new Set<Listener>();
  private peers = new Map<string, RTCPeerConnection>();
  private names = new Map<string, string>();
  private outputs = new Map<string, HTMLAudioElement>();
  /** Candidates that arrived before the description they belong to. */
  private earlyCandidates = new Map<string, RTCIceCandidateInit[]>();
  /** Riders we rang directly: they must be told if we give up before they answer. */
  private invited = new Set<string>();
  private local?: MediaStream;
  private wired = false;

  subscribe(listener: Listener) {
    this.wire();
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }

  private refreshPeers() {
    const peers: CallPeer[] = [...this.peers.entries()].map(([userId, pc]) => ({
      userId,
      name: this.names.get(userId) ?? "Rider",
      connected: pc.connectionState === "connected",
    }));
    const active = peers.some((peer) => peer.connected);
    this.publish({
      peers,
      phase: active ? "active" : this.state.phase === "active" ? "calling" : this.state.phase,
      startedAt: active && !this.state.startedAt ? Date.now() : this.state.startedAt,
    });
  }

  private wire() {
    if (this.wired) return;
    this.wired = true;
    ws.subscribe((event) => void this.onSignal(event as Record<string, unknown>));
  }

  // ---------------------------------------------------------------- outgoing

  /** Ring one rider. */
  callRider(groupId: string, userId: string, name: string) {
    return this.begin("direct", groupId, name, () => {
      this.names.set(userId, name);
      this.invited.add(userId);
      ws.send({
        type: "call_invite",
        callId: this.state.callId,
        groupId,
        kind: "direct",
        to: userId,
      });
    });
  }

  /** Ring everyone in the group. */
  callGroup(groupId: string, groupName: string) {
    return this.begin("group", groupId, groupName, () => {
      ws.send({ type: "call_invite", callId: this.state.callId, groupId, kind: "group" });
    });
  }

  private async begin(
    kind: CallKind,
    groupId: string,
    title: string,
    invite: () => void,
  ) {
    if (this.state.phase !== "idle") return;
    const callId = crypto.randomUUID();
    this.publish({
      phase: "calling",
      kind,
      callId,
      groupId,
      title,
      invitedBy: null,
      peers: [],
      micMuted: false,
      startedAt: null,
      error: null,
    });
    try {
      await this.openMicrophone();
    } catch {
      this.publish({ ...IDLE, error: "RideMate needs microphone access to make a call." });
      return;
    }
    // Hung up while the microphone was being granted.
    if (this.state.callId !== callId) return;
    invite();
  }

  /** Answer the invitation on screen. */
  async accept() {
    const { callId, groupId, invitedBy, kind } = this.state;
    if (this.state.phase !== "ringing" || !callId || !groupId || !invitedBy) return;
    try {
      await this.openMicrophone();
    } catch {
      this.decline();
      this.publish({ error: "RideMate needs microphone access to take a call." });
      return;
    }
    this.publish({ phase: "calling", invitedBy: null });
    // Everyone already in the call answers this by offering to us.
    ws.send({
      type: "call_join",
      callId,
      groupId,
      kind,
      ...(kind === "direct" ? { to: invitedBy.userId } : {}),
    });
  }

  decline() {
    const { callId, invitedBy } = this.state;
    if (invitedBy && callId)
      ws.send({ type: "call_rejected", callId, to: invitedBy.userId });
    this.teardown();
  }

  /** Leave the call. Others carry on without you. */
  hangUp() {
    const { callId, groupId, kind } = this.state;
    if (callId && groupId) {
      if (kind === "direct")
        // Everyone we are connected to, plus anyone still being rung, who
        // would otherwise go on ringing after we gave up.
        new Set([...this.peers.keys(), ...this.invited]).forEach((userId) =>
          ws.send({ type: "call_leave", callId, groupId, to: userId }),
        );
      else ws.send({ type: "call_leave", callId, groupId, kind });
    }
    this.teardown();
  }

  toggleMic() {
    const muted = !this.state.micMuted;
    this.local?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    this.publish({ micMuted: muted });
  }

  dismissError() {
    this.publish({ error: null });
  }

  // ---------------------------------------------------------------- incoming

  private async onSignal(event: Record<string, unknown>) {
    const type = String(event.type ?? "");
    if (!type.startsWith("call_") && type !== "ice_candidate") return;
    const from = event.from === undefined ? null : String(event.from);
    const callId = event.callId === undefined ? null : String(event.callId);
    const me = session.user()?.id;
    if (from && me && from === me) return; // our own broadcast, echoed back

    switch (type) {
      case "call_invite": {
        if (!from || !callId) return;
        // Already busy: let them know rather than leaving the phone ringing.
        if (this.state.phase !== "idle") {
          if (callId !== this.state.callId)
            ws.send({ type: "call_rejected", callId, to: from, reason: "busy" });
          return;
        }
        this.names.set(from, String(event.fromName ?? "Rider"));
        this.publish({
          phase: "ringing",
          kind: event.kind === "direct" ? "direct" : "group",
          callId,
          groupId: event.groupId === undefined ? null : String(event.groupId),
          title: String(event.fromName ?? "Rider"),
          invitedBy: { userId: from, name: String(event.fromName ?? "Rider") },
          peers: [],
          micMuted: false,
          startedAt: null,
          error: null,
        });
        return;
      }

      case "call_join": {
        // Somebody joined the call we are on: we offer, they answer.
        if (!from || callId !== this.state.callId || !this.local) return;
        if (this.peers.size >= MAX_PEERS) return;
        this.names.set(from, String(event.fromName ?? "Rider"));
        const pc = this.connectionFor(from);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send({ type: "call_offer", callId, to: from, offer });
        return;
      }

      case "call_offer": {
        if (!from || callId !== this.state.callId || !this.local) return;
        this.names.set(from, String(event.fromName ?? this.names.get(from) ?? "Rider"));
        const pc = this.connectionFor(from);
        await pc.setRemoteDescription(event.offer as RTCSessionDescriptionInit);
        await this.drainCandidates(from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send({ type: "call_answer", callId, to: from, answer });
        return;
      }

      case "call_answer": {
        if (!from || callId !== this.state.callId) return;
        const pc = this.peers.get(from);
        if (!pc) return;
        await pc.setRemoteDescription(event.answer as RTCSessionDescriptionInit);
        await this.drainCandidates(from, pc);
        return;
      }

      case "ice_candidate": {
        if (!from || callId !== this.state.callId) return;
        const candidate = event.candidate as RTCIceCandidateInit;
        const pc = this.peers.get(from);
        // A candidate can beat its description here; hold it until it lands.
        if (!pc || !pc.remoteDescription) {
          const waiting = this.earlyCandidates.get(from) ?? [];
          waiting.push(candidate);
          this.earlyCandidates.set(from, waiting);
          return;
        }
        await pc.addIceCandidate(candidate).catch(() => undefined);
        return;
      }

      case "call_rejected": {
        if (callId !== this.state.callId) return;
        if (this.state.kind === "direct") {
          const reason =
            event.reason === "busy"
              ? `${this.names.get(String(from)) ?? "They"} is on another call.`
              : "Call declined.";
          this.teardown();
          this.publish({ error: reason });
        }
        return;
      }

      case "call_unreachable": {
        if (callId !== this.state.callId) return;
        this.teardown();
        this.publish({ error: "That rider is offline." });
        return;
      }

      case "call_leave":
      case "call_ended": {
        if (!from || callId !== this.state.callId) return;
        this.dropPeer(from);
        // A direct call is over when the other side goes; a group call ends
        // for you when the last other rider has left.
        if (this.state.kind === "direct" || this.peers.size === 0) this.teardown();
        else this.refreshPeers();
        return;
      }
    }
  }

  // ------------------------------------------------------------------ plumbing

  private async openMicrophone() {
    if (this.local) return this.local;
    // Voice only: a rider does not need to look at anything, and audio keeps
    // working on a connection that video would drown.
    this.local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    return this.local;
  }

  private connectionFor(userId: string) {
    const existing = this.peers.get(userId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers });
    this.peers.set(userId, pc);
    this.local?.getTracks().forEach((track) => pc.addTrack(track, this.local!));

    pc.onicecandidate = (event) => {
      if (event.candidate)
        ws.send({
          type: "ice_candidate",
          callId: this.state.callId,
          to: userId,
          candidate: event.candidate.toJSON(),
        });
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      let output = this.outputs.get(userId);
      if (!output) {
        // Audio needs an element to come out of; it is never shown.
        output = new Audio();
        output.autoplay = true;
        output.setAttribute("playsinline", "");
        this.outputs.set(userId, output);
      }
      output.srcObject = stream;
      void output.play().catch(() => undefined);
      this.refreshPeers();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.dropPeer(userId);
        if (this.state.kind === "direct" || this.peers.size === 0) this.teardown();
        else this.refreshPeers();
        return;
      }
      this.refreshPeers();
    };

    this.refreshPeers();
    return pc;
  }

  private async drainCandidates(userId: string, pc: RTCPeerConnection) {
    const waiting = this.earlyCandidates.get(userId);
    if (!waiting) return;
    this.earlyCandidates.delete(userId);
    for (const candidate of waiting) await pc.addIceCandidate(candidate).catch(() => undefined);
  }

  private dropPeer(userId: string) {
    this.peers.get(userId)?.close();
    this.peers.delete(userId);
    this.earlyCandidates.delete(userId);
    const output = this.outputs.get(userId);
    if (output) {
      output.srcObject = null;
      this.outputs.delete(userId);
    }
  }

  private teardown() {
    [...this.peers.keys()].forEach((userId) => this.dropPeer(userId));
    this.local?.getTracks().forEach((track) => track.stop());
    this.local = undefined;
    this.names.clear();
    this.invited.clear();
    this.publish({ ...IDLE });
  }
}

export const calls = new CallManager();
