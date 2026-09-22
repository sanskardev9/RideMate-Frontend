export type User = {
  id: string;
  name: string;
  email: string;
  avatar?: string | null;
};

export type Member = User & {
  online: boolean;
  lastLocationAt: string | null;
};

export type RiderLocation = {
  userId: string;
  name: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: string;
  online: boolean;
  rideId: string | null;
};

export type MessageStatus = "sending" | "sent" | "failed";

export type Message = {
  id: string;
  senderId: string;
  sender: string;
  text: string;
  timestamp: string;
  status: MessageStatus;
  /** Set on optimistic messages so the server echo can replace them. */
  clientId?: string;
};

export type Group = {
  id: string;
  name: string;
  inviteCode: string;
  ownerId: string | null;
  memberCount: number;
  activeRideId: string | null;
  rideStartedAt: string | null;
};

export type Ride = {
  id: string;
  groupId: string;
  groupName: string;
  startedBy: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  distanceKm: number;
  riderCount: number;
  /** Whether the signed-in rider is still on this ride. */
  joined: boolean;
};

/** One ride in a group's history. */
export type RideSummary = {
  id: string;
  startedBy: string | null;
  startedByName: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  distanceKm: number;
  riderCount: number;
  /** Whether the signed-in rider was on this ride. */
  joined: boolean;
};

export type SosAlert = {
  id: string;
  groupId: string;
  riderId: string;
  riderName: string;
  latitude: number;
  longitude: number;
  active: boolean;
  createdAt: string;
};

export type SocketEvent = { type: string; [key: string]: unknown };
