import express from "express";
import https from "https";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import os from "os";
import QRCode from "qrcode";
import selfsigned from "selfsigned";

// ── Types ───────────────────────────────────────────────────────────────────

interface Room {
  sender: SignalSocket | null;
  receivers: Set<SignalSocket>;
}

interface SignalSocket extends WebSocket {
  _role?: string;
  _peerId?: string;
}

interface SignalMessage {
  type: string;
  room?: string;
  role?: string;
  peerId?: string;
  to?: string;
  from?: string;
  [key: string]: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getLocalIPs(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const cfg of iface) {
      if (cfg.family === "IPv4" && !cfg.internal) ips.push(cfg.address);
    }
  }
  return ips;
}

function getNetworkUrl(port: number | string): string {
  const ips = getLocalIPs();
  if (ips.length > 0) return `https://${ips[0]}:${port}`;
  return `https://localhost:${port}`;
}

// ── Auto-generate self-signed TLS cert ──────────────────────────────────────

const CERT_DIR = path.join(__dirname, ".certs");
const CERT_PATH = path.join(CERT_DIR, "cert.pem");
const KEY_PATH = path.join(CERT_DIR, "key.pem");

async function ensureCerts(): Promise<{
  cert: string | Buffer;
  key: string | Buffer;
}> {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
  }

  console.log("  Generating self-signed certificate…");
  const attrs = [{ name: "commonName", value: "tiny-stream" }];
  const opts = {
    days: 365,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName" as const,
        altNames: [
          { type: 2 as const, value: "localhost" },
          { type: 7 as const, ip: "127.0.0.1" },
          ...getLocalIPs().map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  };
  const pems = await selfsigned.generate(attrs, opts);

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(KEY_PATH, pems.private);
  console.log(`  Certificate saved to ${CERT_DIR}\n`);

  return { cert: pems.cert, key: pems.private };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { cert, key } = await ensureCerts();

  const app = express();
  const server = https.createServer({ cert, key }, app);
  const wss = new WebSocketServer({ server });

  // ── Graceful shutdown ─────────────────────────────────────────────────

  function shutdown() {
    console.log("\n  Shutting down…");
    wss.clients.forEach((ws) => ws.close());
    wss.close();
    server.close(() => process.exit(0));
    // Force exit if connections linger
    setTimeout(() => process.exit(0), 3000);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Serve static files from public/
  app.use(express.static(path.join(__dirname, "public")));

  // ── API: server info + QR SVG ─────────────────────────────────────────

  app.get("/api/info", async (_req, res) => {
    const port = server.address()
      ? (server.address() as { port: number }).port
      : process.env.PORT || 3000;
    const networkUrl = getNetworkUrl(port);
    try {
      const qrSvg = await QRCode.toString(networkUrl, {
        type: "svg",
        margin: 1,
        color: { dark: "#e4e4e7", light: "#00000000" },
      });
      res.json({ networkUrl, qrSvg });
    } catch {
      res.json({ networkUrl, qrSvg: null });
    }
  });

  // ── WebSocket signaling ───────────────────────────────────────────────

  const rooms = new Map<string, Room>();

  function getRoom(id: string): Room {
    if (!rooms.has(id)) {
      rooms.set(id, { sender: null, receivers: new Set() });
    }
    return rooms.get(id)!;
  }

  function log(room: string, msg: string): void {
    const ts = new Date().toLocaleTimeString();
    console.log(`  [${ts}] [${room}] ${msg}`);
  }

  wss.on("connection", (ws: SignalSocket) => {
    let currentRoom: Room | null = null;
    let currentRoomName: string | null = null;
    let role: string | null = null;

    ws.on("message", (raw) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const { type } = msg;

      // ── Join a room ────────────────────────────────────────────────────
      if (type === "join") {
        const room = getRoom(msg.room!);
        currentRoom = room;
        currentRoomName = msg.room!;
        role = msg.role!;

        if (role === "sender") {
          if (room.sender && room.sender !== ws) {
            // Demote the old sender to receiver instead of kicking
            const oldSender = room.sender;
            oldSender._role = "receiver";
            room.receivers.add(oldSender);
            oldSender.send(
              JSON.stringify({ type: "role-changed", newRole: "receiver" }),
            );
            log(currentRoomName, "Previous sender demoted to receiver");
          }
          room.sender = ws;
          ws._role = "sender";
          log(currentRoomName, "Video feed started");
          // Notify all receivers (including the demoted one) that a new sender is ready
          for (const r of room.receivers) {
            r.send(JSON.stringify({ type: "sender-ready" }));
          }
        } else {
          room.receivers.add(ws);
          ws._role = "receiver";
          log(
            currentRoomName,
            `Receiver joined (${room.receivers.size} viewer${room.receivers.size !== 1 ? "s" : ""})`,
          );
          if (room.sender) {
            ws.send(JSON.stringify({ type: "sender-ready" }));
          }
        }

        ws.send(JSON.stringify({ type: "joined", role }));
        return;
      }

      // ── WebRTC signaling relay ─────────────────────────────────────────
      if (type === "offer" || type === "answer" || type === "ice-candidate") {
        if (!currentRoom) return;

        const effectiveRole = ws._role || role;

        if (effectiveRole === "sender") {
          if (msg.to) {
            for (const r of currentRoom.receivers) {
              if (r._peerId === msg.to) {
                r.send(JSON.stringify({ ...msg, from: ws._peerId }));
                break;
              }
            }
          } else {
            for (const r of currentRoom.receivers) {
              if (r.readyState === WebSocket.OPEN) {
                r.send(JSON.stringify({ ...msg, from: ws._peerId }));
              }
            }
          }
        } else {
          if (
            currentRoom.sender &&
            currentRoom.sender.readyState === WebSocket.OPEN
          ) {
            currentRoom.sender.send(
              JSON.stringify({ ...msg, from: ws._peerId }),
            );
          }
        }
        return;
      }

      // ── Peer ID registration ───────────────────────────────────────────
      if (type === "register-id") {
        ws._peerId = msg.peerId;
        return;
      }
    });

    ws.on("close", () => {
      if (!currentRoom) return;

      // Use the live role from ws._role (may have been demoted)
      const effectiveRole = ws._role || role;

      if (effectiveRole === "sender" && currentRoom.sender === ws) {
        currentRoom.sender = null;
        log(currentRoomName!, "Video feed stopped");
        for (const r of currentRoom.receivers) {
          if (r.readyState === WebSocket.OPEN) {
            r.send(JSON.stringify({ type: "sender-left" }));
          }
        }
      } else {
        currentRoom.receivers.delete(ws);
        log(
          currentRoomName!,
          `Receiver disconnected (${currentRoom.receivers.size} viewer${currentRoom.receivers.size !== 1 ? "s" : ""} remaining)`,
        );
        if (
          currentRoom.sender &&
          currentRoom.sender.readyState === WebSocket.OPEN
        ) {
          currentRoom.sender.send(
            JSON.stringify({ type: "receiver-left", peerId: ws._peerId }),
          );
        }
      }

      // Clean up empty rooms
      if (!currentRoom.sender && currentRoom.receivers.size === 0) {
        for (const [id, r] of rooms) {
          if (r === currentRoom) {
            rooms.delete(id);
            break;
          }
        }
      }
    });
  });

  // ── Start server ──────────────────────────────────────────────────────

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, "0.0.0.0", async () => {
    const addresses = getLocalIPs();

    const localUrl = `https://localhost:${PORT}`;
    const urls: [string, string][] = [["Local", localUrl]];
    for (const addr of addresses) {
      urls.push(["Network", `https://${addr}:${PORT}`]);
    }

    const contentWidth =
      Math.max(
        "tiny-stream is running!".length,
        ...urls.map(([label, url]) => `${label}:   ${url}`.length),
      ) + 4;

    const line = "═".repeat(contentWidth + 2);
    const pad = (str: string) =>
      str + " ".repeat(Math.max(0, contentWidth - str.length));

    console.log("");
    console.log(`  ╔${line}╗`);
    console.log(`  ║ ${pad("  tiny-stream is running!")} ║`);
    console.log(`  ╠${line}╣`);
    for (const [label, url] of urls) {
      const prefix = label === "Local" ? "Local:  " : "Network:";
      console.log(`  ║ ${pad(` ${prefix} ${url}`)} ║`);
    }
    console.log(`  ╚${line}╝`);

    // Print QR code for the network URL in the terminal
    const networkUrl = getNetworkUrl(PORT);
    try {
      const qrText = await QRCode.toString(networkUrl, {
        type: "utf8",
      });
      console.log("");
      console.log("  Scan to connect:");
      console.log("");
      for (const qrLine of qrText.split("\n")) {
        console.log(`    ${qrLine}`);
      }
    } catch {
      // QR generation failed — not critical
    }

    console.log("");
    console.log("  Open the Network URL on any device in your home network.");
    console.log("  First visit: accept the self-signed certificate warning.\n");
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
