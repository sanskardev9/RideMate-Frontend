import type { SocketEvent } from "../types";
import { session } from "../api/client";

type Listener = (event: SocketEvent) => void;
type StatusListener = (connected: boolean) => void;

const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_MS = 25_000;

class WebSocketManager {
  private socket?: WebSocket;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private retry = 0;
  private reconnectTimer?: number;
  private heartbeatTimer?: number;
  private closedByUs = false;

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    const base = import.meta.env.VITE_WS_BASE_URL;
    const token = session.token();
    if (!base || !token || this.socket) return;

    this.closedByUs = false;
    const socket = new WebSocket(
      `${base.replace(/\/$/, "")}/ws?token=${encodeURIComponent(token)}`,
    );
    this.socket = socket;

    socket.onopen = () => {
      this.retry = 0;
      this.notifyStatus(true);
      this.heartbeatTimer = window.setInterval(
        () => this.send({ type: "ping" }),
        HEARTBEAT_MS,
      );
    };

    socket.onmessage = (raw) => {
      let event: SocketEvent;
      try {
        event = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (event.type === "pong") return;
      this.listeners.forEach((listener) => listener(event));
    };

    socket.onclose = () => {
      window.clearInterval(this.heartbeatTimer);
      this.socket = undefined;
      this.notifyStatus(false);
      if (this.closedByUs || !session.token()) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.retry++);
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    };

    socket.onerror = () => socket.close();
  }

  send(event: SocketEvent) {
    if (!this.connected) return false;
    this.socket!.send(JSON.stringify(event));
    return true;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onStatusChange(listener: StatusListener) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private notifyStatus(connected: boolean) {
    this.statusListeners.forEach((listener) => listener(connected));
  }

  disconnect() {
    this.closedByUs = true;
    this.retry = 0;
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.heartbeatTimer);
    this.socket?.close();
    this.socket = undefined;
  }
}

export const ws = new WebSocketManager();
