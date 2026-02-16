import express from "express";
import https from "https";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import os from "os";
import QRCode from "qrcode";
import selfsigned from "selfsigned";
import type { SignalMessage } from "./src/types";

// ── Types ───────────────────────────────────────────────────────────────────

interface Room {
  sender: WebSocket | null;
  receivers: Set<WebSocket>;
  code: string;
}

interface SocketMeta {
  role: string | null;
  peerId?: string;
  roomName?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateRoomCode(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

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

const localIPs = getLocalIPs();

function getNetworkUrl(port: number | string): string {
  if (localIPs.length > 0) return `https://${localIPs[0]}:${port}`;
  return `https://localhost:${port}`;
}

function log(room: string, msg: string): void {
  const ts = new Date().toLocaleTimeString();
  console.log(`  [${ts}] [${room}] ${msg}`);
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
          ...localIPs.map((ip) => ({ type: 7 as const, ip })),
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

// ── Startup banner ──────────────────────────────────────────────────────────

async function printBanner(port: number): Promise<void> {
  const urls: [string, string][] = [["Local", `https://localhost:${port}`]];
  for (const addr of localIPs) {
    urls.push(["Network", `https://${addr}:${port}`]);
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

  const networkUrl = getNetworkUrl(port);
  try {
    const qrText = await QRCode.toString(networkUrl, { type: "utf8" });
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
}

// ── WebSocket signaling ─────────────────────────────────────────────────────

function setupSignaling(wss: WebSocketServer, rooms: Map<string, Room>): void {
  const socketMeta = new Map<WebSocket, SocketMeta>();

  function getRoom(id: string): Room {
    if (!rooms.has(id)) {
      rooms.set(id, {
        sender: null,
        receivers: new Set(),
        code: generateRoomCode(),
      });
    }
    return rooms.get(id)!;
  }

  function getMeta(ws: WebSocket): SocketMeta {
    return socketMeta.get(ws)!;
  }

  wss.on("connection", (ws: WebSocket) => {
    socketMeta.set(ws, { role: null });

    ws.on("message", (raw) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const { type } = msg;
      const meta = getMeta(ws);

      // ── Peer ID registration ───────────────────────────────────────────
      if (type === "register-id") {
        meta.peerId = msg.peerId;
        return;
      }

      // ── Join a room ────────────────────────────────────────────────────
      if (type === "join") {
        if (!msg.room || !msg.role) return;

        const room = getRoom(msg.room);

        // Receivers must provide the correct room code
        if (msg.role === "receiver" && msg.code !== room.code) {
          ws.send(
            JSON.stringify({
              type: "join-denied",
              reason: msg.code ? "Invalid room code" : "Room code required",
            }),
          );
          return;
        }

        meta.roomName = msg.room;
        meta.role = msg.role;

        if (msg.role === "sender") {
          if (room.sender && room.sender !== ws) {
            // Demote the old sender to receiver instead of kicking
            const oldMeta = getMeta(room.sender);
            oldMeta.role = "receiver";
            room.receivers.add(room.sender);
            room.sender.send(
              JSON.stringify({ type: "role-changed", newRole: "receiver" }),
            );
            log(msg.room, "Previous sender demoted to receiver");
          }
          room.sender = ws;
          log(msg.room, `Video feed started (code: ${room.code})`);
          // Send the room code back to the sender
          ws.send(JSON.stringify({ type: "room-code", code: room.code }));
          // Notify all receivers (including the demoted one) that a new sender is ready
          for (const r of room.receivers) {
            r.send(JSON.stringify({ type: "sender-ready" }));
          }
        } else {
          room.receivers.add(ws);
          log(
            msg.room,
            `Receiver joined (${room.receivers.size} viewer${room.receivers.size !== 1 ? "s" : ""})`,
          );
          if (room.sender) {
            ws.send(JSON.stringify({ type: "sender-ready" }));
          }
        }

        ws.send(JSON.stringify({ type: "joined", role: msg.role }));
        return;
      }

      // ── WebRTC signaling relay ─────────────────────────────────────────
      if (type === "offer" || type === "answer" || type === "ice-candidate") {
        if (!meta.roomName) return;
        const room = rooms.get(meta.roomName);
        if (!room) return;

        if (meta.role === "sender") {
          if (msg.to) {
            for (const r of room.receivers) {
              if (getMeta(r).peerId === msg.to) {
                r.send(JSON.stringify({ ...msg, from: meta.peerId }));
                break;
              }
            }
          } else {
            for (const r of room.receivers) {
              if (r.readyState === WebSocket.OPEN) {
                r.send(JSON.stringify({ ...msg, from: meta.peerId }));
              }
            }
          }
        } else {
          if (room.sender && room.sender.readyState === WebSocket.OPEN) {
            room.sender.send(JSON.stringify({ ...msg, from: meta.peerId }));
          }
        }
        return;
      }
    });

    ws.on("close", () => {
      const meta = getMeta(ws);
      const { roomName } = meta;
      socketMeta.delete(ws);

      if (!roomName) return;
      const room = rooms.get(roomName);
      if (!room) return;

      if (meta.role === "sender" && room.sender === ws) {
        room.sender = null;
        log(roomName, "Video feed stopped");
        for (const r of room.receivers) {
          if (r.readyState === WebSocket.OPEN) {
            r.send(JSON.stringify({ type: "sender-left" }));
          }
        }
      } else {
        room.receivers.delete(ws);
        log(
          roomName,
          `Receiver disconnected (${room.receivers.size} viewer${room.receivers.size !== 1 ? "s" : ""} remaining)`,
        );
        if (room.sender && room.sender.readyState === WebSocket.OPEN) {
          room.sender.send(
            JSON.stringify({ type: "receiver-left", peerId: meta.peerId }),
          );
        }
      }

      // O(1) room cleanup
      if (!room.sender && room.receivers.size === 0) {
        rooms.delete(roomName);
      }
    });
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { cert, key } = await ensureCerts();

  const app = express();
  const server = https.createServer({ cert, key }, app);
  const wss = new WebSocketServer({ server });
  const rooms = new Map<string, Room>();

  // ── Graceful shutdown ─────────────────────────────────────────────────

  function shutdown() {
    console.log("\n  Shutting down…");
    wss.clients.forEach((ws) => ws.close());
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Static files & API ────────────────────────────────────────────────

  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/info", async (_req, res) => {
    const addr = server.address();
    const port =
      addr && typeof addr !== "string"
        ? addr.port
        : Number(process.env.PORT) || 3000;
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

  // ── Signaling ─────────────────────────────────────────────────────────

  setupSignaling(wss, rooms);

  // ── Start ─────────────────────────────────────────────────────────────

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, "0.0.0.0", () => {
    printBanner(PORT);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
