export interface SignalMessage {
  type: string;
  sdp?: string | null;
  candidate?: RTCIceCandidateInit;
  from?: string;
  to?: string;
  peerId?: string;
  newRole?: string;
  room?: string;
  role?: string;
  reason?: string;
  [key: string]: unknown;
}
