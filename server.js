// Castlefall server: static files + a WebSocket game server on one port.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const VERSION = "2.0.0";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const WORDLIST_DIR = path.join(ROOT, "wordlists");

const LIMITS = {
  name: 24,
  room: 40,
  chat: 300,
  log: 80,
  history: 12,
  minWords: 2,
  defaultWords: 18,
  startCooldownMs: 2000,
  emptyRoomTtlMs: 30 * 60 * 1000,
  heartbeatMs: 30 * 1000,
};
const TIMER_LENGTHS = [30, 45, 60, 90, 120];

// ---------------------------------------------------------------------------
// Word lists

export function loadWordlists(dir = WORDLIST_DIR) {
  const lists = new Map();
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".txt")) continue;
    const words = [
      ...new Set(
        fs
          .readFileSync(path.join(dir, file), "utf8")
          .split(/\r?\n/)
          .map((w) => w.trim())
          .filter(Boolean),
      ),
    ];
    if (words.length >= LIMITS.minWords) lists.set(file.slice(0, -4), words);
  }
  return lists;
}

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Rooms

class Room {
  constructor(id, wordlists) {
    this.id = id;
    this.wordlists = wordlists;
    /** name -> socket, or null while disconnected */
    this.players = new Map();
    this.spectators = new Set();
    this.settings = { timerLength: 60, autokick: true };
    this.round = null;
    this.history = [];
    this.log = [];
    this.timer = null;
    this.decks = new Map();
    this.lastStart = 0;
    this.cleanupTimeout = null;
  }

  get roundNumber() {
    return this.round ? this.round.number : 0;
  }

  sockets() {
    return [...[...this.players.values()].filter(Boolean), ...this.spectators];
  }

  isEmpty() {
    return this.sockets().length === 0;
  }

  playerList() {
    return [...this.players.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, ws]) => ({ name, connected: !!ws }));
  }

  roster() {
    return { type: "roster", players: this.playerList(), spectators: this.spectators.size };
  }

  draw(listName, count) {
    let deck = this.decks.get(listName) || [];
    if (deck.length < count) deck = shuffle(this.wordlists.get(listName));
    this.decks.set(listName, deck.slice(count));
    return deck.slice(0, count);
  }

  startRound(starter, { round, wordlist, wordcount }) {
    if (round !== this.roundNumber) {
      throw new Error("Someone else just started a round.");
    }
    if (Date.now() - this.lastStart < LIMITS.startCooldownMs) {
      throw new Error("Slow down — a round was just started.");
    }
    const list = this.wordlists.get(wordlist);
    if (!list) throw new Error(`Unknown word list “${wordlist}”.`);
    const count = Math.max(
      LIMITS.minWords,
      Math.min(list.length, Number.parseInt(wordcount, 10) || LIMITS.defaultWords),
    );

    if (this.round) this.history.unshift(this.reveal());
    this.history.length = Math.min(this.history.length, LIMITS.history);

    const words = this.draw(wordlist, count);
    const [wordA, wordB] = shuffle(words).slice(0, 2);
    const names = shuffle([...this.players.keys()]);
    const half = Math.floor(names.length / 2);
    const assigned = new Map(names.map((name, i) => [name, i < half ? wordA : wordB]));

    this.lastStart = Date.now();
    this.timer = null;
    this.round = {
      number: this.roundNumber + 1,
      starter,
      startedAt: this.lastStart,
      wordlist,
      words,
      assigned,
      players: [...assigned.keys()].sort((a, b) => a.localeCompare(b)),
    };
  }

  /** The round as seen by one viewer: their own word only, their own shuffle. */
  roundFor(name) {
    const r = this.round;
    if (!r) return null;
    return {
      number: r.number,
      starter: r.starter,
      age: Date.now() - r.startedAt,
      wordlist: r.wordlist,
      words: shuffle(r.words),
      players: r.players,
      word: (name && r.assigned.get(name)) || null,
    };
  }

  /** Everything about the current round, for after it ends. */
  reveal() {
    const r = this.round;
    return {
      number: r.number,
      starter: r.starter,
      wordlist: r.wordlist,
      words: r.words,
      players: r.players.map((name) => ({ name, word: r.assigned.get(name) })),
    };
  }

  timerState() {
    if (!this.timer) return null;
    const remaining = this.timer.endsAt - Date.now();
    if (remaining <= -5000) return null;
    return { by: this.timer.by, length: this.timer.length, remaining };
  }
}

// ---------------------------------------------------------------------------
// Game server

export function createGame({ wordlists = loadWordlists() } = {}) {
  const rooms = new Map();

  const send = (ws, msg) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (room, msg) => {
    const data = JSON.stringify(msg);
    for (const ws of room.sockets()) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const addLog = (room, kind, text, extra = {}) => {
    const entry = { kind, text, at: Date.now(), ...extra };
    room.log.push(entry);
    if (room.log.length > LIMITS.log) room.log.shift();
    broadcast(room, { type: "log", entry });
  };

  const getRoom = (id) => {
    let room = rooms.get(id);
    if (!room) {
      room = new Room(id, wordlists);
      rooms.set(id, room);
    }
    clearTimeout(room.cleanupTimeout);
    return room;
  };

  const maybeCleanup = (room) => {
    if (!room.isEmpty()) return;
    clearTimeout(room.cleanupTimeout);
    room.cleanupTimeout = setTimeout(() => {
      if (room.isEmpty()) rooms.delete(room.id);
    }, LIMITS.emptyRoomTtlMs);
    room.cleanupTimeout.unref?.();
  };

  function leave(ws) {
    const meta = ws.meta;
    if (!meta.room) return;
    const room = rooms.get(meta.room);
    meta.room = null;
    if (!room) return;
    if (meta.name) {
      if (room.players.get(meta.name) === ws) {
        if (room.settings.autokick) room.players.delete(meta.name);
        else room.players.set(meta.name, null);
        addLog(room, "presence", `${meta.name} left`);
      }
    } else {
      room.spectators.delete(ws);
    }
    meta.name = null;
    broadcast(room, room.roster());
    maybeCleanup(room);
  }

  const handlers = {
    join(ws, msg) {
      const roomId = String(msg.room ?? "").trim().toLowerCase().replace(/^#/, "").slice(0, LIMITS.room) || "lobby";
      const name = String(msg.name ?? "").trim().replace(/\s+/g, " ").slice(0, LIMITS.name) || null;

      leave(ws);
      const room = getRoom(roomId);
      ws.meta.room = roomId;
      ws.meta.name = name;

      if (name) {
        const previous = room.players.get(name);
        if (previous && previous !== ws) {
          previous.meta.room = null;
          previous.meta.name = null;
          send(previous, {
            type: "error",
            fatal: true,
            message: `Someone else joined room “${roomId}” as ${name}.`,
          });
        }
        room.players.set(name, ws);
        addLog(room, "presence", `${name} joined`);
      } else {
        room.spectators.add(ws);
      }

      send(ws, {
        type: "welcome",
        version: VERSION,
        room: roomId,
        you: name,
        players: room.playerList(),
        spectators: room.spectators.size,
        settings: room.settings,
        timerLengths: TIMER_LENGTHS,
        wordlists: [...wordlists].map(([id, words]) => ({ id, size: words.length })),
        round: room.roundFor(name),
        history: room.history,
        log: room.log,
        timer: room.timerState(),
      });
      broadcast(room, room.roster());
    },

    start(ws, msg, room, name) {
      try {
        room.startRound(name, msg);
      } catch (err) {
        return send(ws, { type: "error", message: err.message });
      }
      const reveal = room.roundNumber > 1 ? room.history[0] : null;
      for (const [playerName, sock] of room.players) {
        send(sock, { type: "round", round: room.roundFor(playerName), reveal });
      }
      for (const sock of room.spectators) send(sock, { type: "round", round: room.roundFor(null), reveal });
      addLog(room, "round", `${name} started round ${room.roundNumber}`);
    },

    kick(ws, msg, room, name) {
      const target = String(msg.name ?? "");
      if (!room.players.has(target)) return;
      const sock = room.players.get(target);
      room.players.delete(target);
      if (sock) {
        sock.meta.room = null;
        sock.meta.name = null;
        send(sock, { type: "error", fatal: true, message: `${name} removed you from the room.` });
      }
      addLog(room, "presence", target === name ? `${name} left` : `${name} removed ${target}`);
      broadcast(room, room.roster());
    },

    chat(ws, msg, room, name) {
      const text = String(msg.text ?? "").trim().slice(0, LIMITS.chat);
      if (text) addLog(room, "chat", text, { name });
    },

    timer(ws, msg, room, name) {
      if (msg.cancel) {
        if (!room.timer) return;
        room.timer = null;
        broadcast(room, { type: "timer", timer: null });
        return addLog(room, "timer", `${name} stopped the timer`);
      }
      const length = room.settings.timerLength;
      room.timer = { by: name, length, endsAt: Date.now() + length * 1000 };
      broadcast(room, { type: "timer", timer: room.timerState() });
      addLog(room, "timer", `${name} started a ${length}s timer`);
    },

    settings(ws, msg, room, name) {
      const s = room.settings;
      if (TIMER_LENGTHS.includes(Number(msg.timerLength)) && Number(msg.timerLength) !== s.timerLength) {
        s.timerLength = Number(msg.timerLength);
        addLog(room, "setting", `${name} set the timer to ${s.timerLength}s`);
      }
      if (typeof msg.autokick === "boolean" && msg.autokick !== s.autokick) {
        s.autokick = msg.autokick;
        addLog(room, "setting", `${name} turned ${s.autokick ? "on" : "off"} auto-removing disconnected players`);
      }
      broadcast(room, { type: "settings", settings: s });
    },
  };

  function onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string" || !Object.hasOwn(handlers, msg.type)) return;
    if (msg.type === "join") return handlers.join(ws, msg);

    // Everything else requires being a named player in a room.
    const { room: roomId, name } = ws.meta;
    const room = roomId && rooms.get(roomId);
    if (!room || !name || room.players.get(name) !== ws) {
      return send(ws, { type: "error", message: "Join the room as a player to do that." });
    }
    handlers[msg.type](ws, msg, room, name);
  }

  function attach(wss) {
    wss.on("connection", (ws) => {
      ws.meta = { room: null, name: null };
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));
      ws.on("message", (data) => onMessage(ws, data.toString()));
      ws.on("close", () => leave(ws));
    });
    const heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, LIMITS.heartbeatMs);
    heartbeat.unref?.();
    wss.on("close", () => clearInterval(heartbeat));
  }

  return { attach, rooms };
}

// ---------------------------------------------------------------------------
// HTTP

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest"]);
/** file path -> { etag, raw, br, gzip }, rebuilt when the file changes */
const staticCache = new Map();

function loadStatic(file, callback) {
  fs.stat(file, (statErr, stat) => {
    if (statErr || !stat.isFile()) return callback(statErr || new Error("Not a file"));
    const etag = `"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
    const cached = staticCache.get(file);
    if (cached?.etag === etag) return callback(null, cached);
    fs.readFile(file, (readErr, raw) => {
      if (readErr) return callback(readErr);
      const entry = { etag, raw };
      if (COMPRESSIBLE.has(path.extname(file))) {
        entry.br = zlib.brotliCompressSync(raw);
        entry.gzip = zlib.gzipSync(raw);
      }
      staticCache.set(file, entry);
      callback(null, entry);
    });
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  loadStatic(file, (err, entry) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    // Browsers revalidate every load, so an unchanged file costs one small 304.
    const headers = { "cache-control": "no-cache", etag: entry.etag, vary: "accept-encoding" };
    if (req.headers["if-none-match"] === entry.etag) {
      res.writeHead(304, headers).end();
      return;
    }
    const accepts = String(req.headers["accept-encoding"] || "");
    const encoding = entry.br && /\bbr\b/.test(accepts) ? "br" : entry.gzip && /\bgzip\b/.test(accepts) ? "gzip" : null;
    if (encoding) headers["content-encoding"] = encoding;
    headers["content-type"] = MIME[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, headers);
    res.end(encoding ? entry[encoding] : entry.raw);
  });
}

export function createServer(options) {
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
  const game = createGame(options);
  game.attach(wss);
  server.on("close", () => wss.close());
  return { server, wss, game };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8372;
  const host = process.env.HOST || "0.0.0.0";
  const { server } = createServer();
  server.listen(port, host, () => {
    console.log(`Castlefall ${VERSION} running at http://localhost:${port}`);
  });
}
