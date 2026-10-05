import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createServer } from "../server.js";

let server;
let url;

before(async () => {
  ({ server } = createServer());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${server.address().port}/ws`;
});

after(() => new Promise((resolve) => server.close(resolve)));

/** A test client that queues messages so tests can await specific types. */
async function client(room, name) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  await new Promise((resolve) => ws.on("open", resolve));
  const next = (type) => {
    const i = queue.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ type, resolve }));
  };
  const send = (msg) => ws.send(JSON.stringify(msg));
  send({ type: "join", room, name });
  const welcome = await next("welcome");
  return { ws, next, send, welcome, drain: () => (queue.length = 0) };
}

test("players get split into two teams with different words", async () => {
  const names = ["ana", "bo", "cy", "di", "ed", "fi"];
  const clients = await Promise.all(names.map((n) => client("teams", n)));
  const wordlist = clients[0].welcome.wordlists[0].id;

  clients[0].send({ type: "start", round: 0, wordlist, wordcount: 12 });
  const rounds = await Promise.all(clients.map((c) => c.next("round")));

  const words = rounds.map((m) => m.round.word);
  const distinct = [...new Set(words)];
  assert.equal(distinct.length, 2);
  assert.equal(words.filter((w) => w === distinct[0]).length, 3);
  for (const { round } of rounds) {
    assert.equal(round.number, 1);
    assert.equal(round.words.length, 12);
    assert.ok(round.words.includes(round.word));
    assert.deepEqual(round.players, [...names].sort());
  }

  // Starting the next round reveals the previous one.
  await new Promise((r) => setTimeout(r, 2100));
  clients[1].send({ type: "start", round: 1, wordlist, wordcount: 12 });
  const next = await clients[0].next("round");
  assert.equal(next.round.number, 2);
  assert.equal(next.reveal.number, 1);
  assert.equal(next.reveal.players.find((p) => p.name === "ana").word, words[0]);

  clients.forEach((c) => c.ws.close());
});

test("stale or too-fast starts are rejected", async () => {
  const a = await client("stale", "a");
  const wordlist = a.welcome.wordlists[0].id;
  a.send({ type: "start", round: 5, wordlist });
  assert.match((await a.next("error")).message, /someone else/i);
  a.send({ type: "start", round: 0, wordlist });
  await a.next("round");
  a.send({ type: "start", round: 1, wordlist });
  assert.match((await a.next("error")).message, /slow down/i);
  a.ws.close();
});

test("spectators see the words but get no word of their own", async () => {
  const p = await client("watch", "player");
  const s = await client("watch", null);
  p.send({ type: "start", round: 0, wordlist: p.welcome.wordlists[0].id });
  const { round } = await s.next("round");
  assert.equal(round.word, null);
  assert.ok(round.words.length > 0);

  s.send({ type: "chat", text: "hi" });
  assert.match((await s.next("error")).message, /join the room as a player/i);
  p.ws.close();
  s.ws.close();
});

test("rejoining with the same name takes over the seat and keeps the word", async () => {
  const a = await client("rejoin", "alex");
  const b = await client("rejoin", "blair");
  a.send({ type: "start", round: 0, wordlist: a.welcome.wordlists[0].id });
  const word = (await b.next("round")).round.word;

  const b2 = await client("rejoin", "blair");
  assert.equal(b2.welcome.round.word, word);
  const err = await b.next("error");
  assert.equal(err.fatal, true);
  [a, b, b2].forEach((c) => c.ws.close());
});

test("chat, timer, settings and kick are broadcast", async () => {
  const a = await client("social", "a");
  const b = await client("social", "b");

  a.send({ type: "chat", text: "  hello  " });
  let log;
  do log = await b.next("log");
  while (log.entry.kind !== "chat");
  assert.deepEqual([log.entry.name, log.entry.text], ["a", "hello"]);

  a.send({ type: "settings", timerLength: 45, autokick: false });
  const { settings } = await b.next("settings");
  assert.deepEqual(settings, { timerLength: 45, autokick: false });

  a.send({ type: "timer" });
  const { timer } = await b.next("timer");
  assert.equal(timer.by, "a");
  assert.equal(timer.length, 45);

  b.drain();
  a.send({ type: "kick", name: "b" });
  const kicked = await b.next("error");
  assert.equal(kicked.fatal, true);
  const roster = await a.next("roster");
  assert.deepEqual(roster.players.map((p) => p.name), ["a"]);
  a.ws.close();
  b.ws.close();
});

test("serves the app and blocks path traversal", async () => {
  const base = url.replace("ws://", "http://").replace("/ws", "");
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Castlefall/);
  const evil = await fetch(`${base}/..%2fserver.js`);
  assert.notEqual(evil.status, 200);
});
