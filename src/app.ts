// ── tiny-stream client ──────────────────────────────────────────────────────
// Handles both sender & receiver roles via WebRTC + WebSocket signaling.

(() => {
  "use strict";

  // ── Elements ────────────────────────────────────────────────────────────
  const $landing = document.getElementById("landing")!;
  const $sender = document.getElementById("sender")!;
  const $receiver = document.getElementById("receiver")!;
  const $roomInput = document.getElementById("roomInput") as HTMLInputElement;
  const $btnSend = document.getElementById("btnSend")!;
  const $btnReceive = document.getElementById("btnReceive")!;
  const $localVideo = document.getElementById("localVideo") as HTMLVideoElement;
  const $remoteVideo = document.getElementById(
    "remoteVideo",
  ) as HTMLVideoElement;
  const $senderStatus = document.getElementById("senderStatus")!;
  const $receiverStatus = document.getElementById("receiverStatus")!;
  const $senderRoom = document.getElementById("senderRoom")!;
  const $receiverRoom = document.getElementById("receiverRoom")!;
  const $btnStopSend = document.getElementById("btnStopSend")!;
  const $btnStopRecv = document.getElementById("btnStopRecv")!;
  const $cameraSelect = document.getElementById(
    "cameraSelect",
  ) as HTMLSelectElement;

  // ── Types ───────────────────────────────────────────────────────────────

  interface SignalMessage {
    type: string;
    sdp?: string | null;
    candidate?: RTCIceCandidateInit;
    from?: string;
    to?: string;
    peerId?: string;
    newRole?: string;
    room?: string;
    role?: string;
  }

  // ── State ───────────────────────────────────────────────────────────────
  let ws: WebSocket | null = null;
  let localStream: MediaStream | null = null;
  let role: "sender" | "receiver" | null = null;
  let roomName = "home";

  // crypto.randomUUID() requires a secure context (HTTPS); fall back for plain HTTP
  const peerId: string =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });

  // Sender keeps one RTCPeerConnection per receiver
  const peerConnections = new Map<string, RTCPeerConnection>();

  // Receiver keeps a single RTCPeerConnection to the sender
  let receiverPC: RTCPeerConnection | null = null;

  // Free STUN servers for NAT traversal (local network usually doesn't need them,
  // but they don't hurt and help if you ever go cross-network)
  const rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  // ── Helpers ─────────────────────────────────────────────────────────────

  function show(el: HTMLElement): void {
    el.classList.remove("hidden");
  }
  function hide(el: HTMLElement): void {
    el.classList.add("hidden");
  }

  function wsUrl(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  }

  function send(msg: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ── Camera enumeration ──────────────────────────────────────────────────

  async function enumerateCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");
    $cameraSelect.innerHTML = "";
    cameras.forEach((cam, i) => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${i + 1}`;
      $cameraSelect.appendChild(opt);
    });
    return cameras;
  }

  async function getStream(deviceId?: string): Promise<MediaStream> {
    const constraints: MediaStreamConstraints = {
      video: deviceId
        ? {
            deviceId: { exact: deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  // ── WebSocket connection ────────────────────────────────────────────────

  function connectWS(onOpen: () => void): void {
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      send({ type: "register-id", peerId });
      onOpen();
    };

    ws.onmessage = (evt: MessageEvent) => {
      const msg: SignalMessage = JSON.parse(evt.data);
      handleSignal(msg);
    };

    ws.onclose = () => {
      if (role === "receiver") {
        $receiverStatus.textContent = "Connection lost. Refresh to retry.";
      }
    };
  }

  // ── Signaling handler ──────────────────────────────────────────────────

  function handleSignal(msg: SignalMessage): void {
    switch (msg.type) {
      case "joined":
        break;

      // ── Sender-side signals ────────────────────────────────────────────
      case "sender-ready":
        // Receiver got this: sender is available → start WebRTC
        if (role === "receiver") startReceiving();
        break;

      case "offer":
        // Receiver gets an offer from sender
        if (role === "receiver") handleOffer(msg);
        break;

      case "ice-candidate":
        handleIceCandidate(msg);
        break;

      case "answer":
        // Sender gets an answer from a receiver
        if (role === "sender") {
          if (msg.sdp === null && msg.from) {
            // Receiver is nudging us to send an offer
            sendOfferTo(msg.from);
          } else {
            handleAnswer(msg);
          }
        }
        break;

      case "receiver-left":
        // Sender: clean up that peer connection
        if (
          role === "sender" &&
          msg.peerId &&
          peerConnections.has(msg.peerId)
        ) {
          peerConnections.get(msg.peerId)!.close();
          peerConnections.delete(msg.peerId);
          updateSenderStatus();
        }
        break;

      case "sender-left":
        if (role === "receiver") {
          $receiverStatus.textContent =
            "Sender disconnected. Waiting for sender…";
          $remoteVideo.srcObject = null;
          if (receiverPC) {
            receiverPC.close();
            receiverPC = null;
          }
        }
        break;

      case "role-changed":
        if (msg.newRole === "receiver") switchToReceiver();
        break;
    }
  }

  // ── Sender logic ───────────────────────────────────────────────────────

  async function startSending(): Promise<void> {
    role = "sender";
    roomName = $roomInput.value.trim() || "home";
    hide($landing);
    show($sender);
    $senderRoom.textContent = `Room: ${roomName}`;

    try {
      localStream = await getStream();
      $localVideo.srcObject = localStream;
      $senderStatus.textContent = "Camera ready. Waiting for viewers…";
      await enumerateCameras();

      // Select current camera in dropdown
      const currentTrack = localStream.getVideoTracks()[0];
      const settings = currentTrack.getSettings();
      if (settings.deviceId) $cameraSelect.value = settings.deviceId;
    } catch (err) {
      $senderStatus.textContent = `Camera error: ${(err as Error).message}`;
      return;
    }

    connectWS(() => {
      send({ type: "join", room: roomName, role: "sender" });
    });
  }

  function createPeerConnectionForReceiver(
    receiverPeerId: string,
  ): RTCPeerConnection {
    const pc = new RTCPeerConnection(rtcConfig);

    // Add all local tracks
    for (const track of localStream!.getTracks()) {
      pc.addTrack(track, localStream!);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        send({
          type: "ice-candidate",
          candidate: e.candidate,
          to: receiverPeerId,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      updateSenderStatus();
    };

    peerConnections.set(receiverPeerId, pc);
    return pc;
  }

  async function sendOfferTo(receiverPeerId: string): Promise<void> {
    const pc = createPeerConnectionForReceiver(receiverPeerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "offer", sdp: offer.sdp, to: receiverPeerId });
    updateSenderStatus();
  }

  function handleAnswer(msg: SignalMessage): void {
    const pc = peerConnections.get(msg.from!);
    if (pc) {
      pc.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: msg.sdp! }),
      );
    }
  }

  function updateSenderStatus(): void {
    const connected = [...peerConnections.values()].filter(
      (pc) => pc.connectionState === "connected",
    ).length;
    if (peerConnections.size === 0) {
      $senderStatus.textContent = "Camera ready. Waiting for viewers…";
    } else {
      $senderStatus.textContent = `Streaming to ${connected} viewer${connected !== 1 ? "s" : ""}`;
    }
  }

  // ── Receiver logic ─────────────────────────────────────────────────────

  async function startAsReceiver(): Promise<void> {
    role = "receiver";
    roomName = $roomInput.value.trim() || "home";
    hide($landing);
    show($receiver);
    $receiverRoom.textContent = `Room: ${roomName}`;
    $receiverStatus.textContent = "Connecting…";

    connectWS(() => {
      send({ type: "join", room: roomName, role: "receiver" });
      $receiverStatus.textContent = "Waiting for sender…";
    });
  }

  function startReceiving(): void {
    // If already connected, clean up first
    if (receiverPC) {
      receiverPC.close();
      receiverPC = null;
    }

    // We don't initiate the offer as receiver — the sender will upon learning
    // we joined. But if the sender is already present, the server sends us
    // "sender-ready" and the sender needs to know our peerId.
    // We send a "ready" nudge so the sender creates an offer for us.
    send({ type: "answer", sdp: null, from: peerId }); // Nudge
    $receiverStatus.textContent = "Sender found! Connecting…";
  }

  async function handleOffer(msg: SignalMessage): Promise<void> {
    if (receiverPC) {
      receiverPC.close();
    }

    receiverPC = new RTCPeerConnection(rtcConfig);

    receiverPC.ontrack = (e) => {
      $remoteVideo.srcObject = e.streams[0];
      $receiverStatus.textContent = "Receiving live video ●";
      $receiverStatus.classList.add("live");
    };

    receiverPC.onicecandidate = (e) => {
      if (e.candidate) {
        send({ type: "ice-candidate", candidate: e.candidate, to: msg.from });
      }
    };

    receiverPC.onconnectionstatechange = () => {
      if (
        receiverPC!.connectionState === "disconnected" ||
        receiverPC!.connectionState === "failed"
      ) {
        $receiverStatus.textContent = "Connection lost. Waiting for sender…";
        $receiverStatus.classList.remove("live");
      }
    };

    await receiverPC.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp: msg.sdp! }),
    );
    const answer = await receiverPC.createAnswer();
    await receiverPC.setLocalDescription(answer);
    send({ type: "answer", sdp: answer.sdp, to: msg.from });
  }

  // ── ICE candidates (both sides) ────────────────────────────────────────

  function handleIceCandidate(msg: SignalMessage): void {
    if (role === "sender" && msg.from) {
      const pc = peerConnections.get(msg.from);
      if (pc) pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } else if (role === "receiver" && receiverPC) {
      receiverPC.addIceCandidate(new RTCIceCandidate(msg.candidate));
    }
  }

  // ── Role switching (sender demoted to receiver) ────────────────────────

  function switchToReceiver(): void {
    // Tear down sender state
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    for (const pc of peerConnections.values()) pc.close();
    peerConnections.clear();

    // Switch role
    role = "receiver";

    // Switch UI
    hide($sender);
    show($receiver);
    $receiverRoom.textContent = `Room: ${roomName}`;
    $receiverStatus.textContent = "You were switched to viewer. Connecting…";
    $receiverStatus.classList.remove("live");
    $remoteVideo.srcObject = null;

    // The server already moved us to the receivers set and will send
    // "sender-ready" right after, which triggers startReceiving()
  }

  // ── Camera switching ───────────────────────────────────────────────────

  $cameraSelect.addEventListener("change", async () => {
    if (!role || role !== "sender") return;
    const deviceId = $cameraSelect.value;

    try {
      const newStream = await getStream(deviceId);
      const newTrack = newStream.getVideoTracks()[0];

      // Replace track in all peer connections
      for (const pc of peerConnections.values()) {
        const senders = pc.getSenders();
        const videoSender = senders.find(
          (s) => s.track && s.track.kind === "video",
        );
        if (videoSender) {
          await videoSender.replaceTrack(newTrack);
        }
      }

      // Stop old tracks
      localStream!.getTracks().forEach((t) => t.stop());
      localStream = newStream;
      $localVideo.srcObject = localStream;
    } catch (err) {
      $senderStatus.textContent = `Camera switch error: ${(err as Error).message}`;
    }
  });

  // ── Stop buttons ───────────────────────────────────────────────────────

  function stopEverything(): void {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    for (const pc of peerConnections.values()) pc.close();
    peerConnections.clear();
    if (receiverPC) {
      receiverPC.close();
      receiverPC = null;
    }
    if (ws) ws.close();
    ws = null;
    role = null;

    hide($sender);
    hide($receiver);
    show($landing);
  }

  $btnStopSend.addEventListener("click", stopEverything);
  $btnStopRecv.addEventListener("click", stopEverything);

  // ── Boot ───────────────────────────────────────────────────────────────

  $btnSend.addEventListener("click", startSending);
  $btnReceive.addEventListener("click", startAsReceiver);

  // Persist room name
  const saved = localStorage.getItem("tiny-stream-room");
  if (saved) $roomInput.value = saved;
  $roomInput.addEventListener("input", () => {
    localStorage.setItem("tiny-stream-room", $roomInput.value);
  });

  // ── Fetch & display QR code on landing page ────────────────────────────

  (async () => {
    try {
      const res = await fetch("/api/info");
      const { networkUrl, qrSvg } = await res.json();
      if (qrSvg) {
        const $qrSection = document.getElementById("qrSection")!;
        const $qrCode = document.getElementById("qrCode")!;
        const $qrUrl = document.getElementById("qrUrl")!;
        $qrCode.innerHTML = qrSvg;
        $qrUrl.textContent = networkUrl;
        $qrSection.classList.remove("hidden");
      }
    } catch {
      // Not critical
    }
  })();
})();
