// Castlefall client. No framework, no build step.

const $ = (sel) => document.querySelector(sel);

/** Tiny element builder: h("div", { class: "x", onclick }, "text", child) */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key in el && !key.startsWith("data-") && !key.startsWith("aria-")) el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const svg = (paths) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("class", "icon");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = paths;
  return el;
};
const ICONS = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`castlefall:${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`castlefall:${key}`, JSON.stringify(value));
    } catch {}
  },
};
const session = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem("castlefall:session"));
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      if (value) sessionStorage.setItem("castlefall:session", JSON.stringify(value));
      else sessionStorage.removeItem("castlefall:session");
    } catch {}
  },
};

// ---------------------------------------------------------------------------
// State

const state = {
  ws: null,
  room: null,
  name: null,
  connected: false,
  retries: 0,
  retryTimeout: null,

  version: "",
  players: [],
  spectators: 0,
  settings: { timerLength: 60, autokick: true },
  timerLengths: [30, 45, 60],
  wordlists: [],
  round: null,
  history: [],
  log: [],
  timer: null,

  wordHidden: store.get("wordHidden", false),
  sound: store.get("sound", true),
  notes: { crossed: new Set(), marks: {} },
  confirmStartUntil: 0,
};

const isPlayer = () => !!state.name && state.connected;
const inRound = () => !!state.round && state.round.players.includes(state.name);

// ---------------------------------------------------------------------------
// Connection

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${location.pathname.replace(/[^/]*$/, "")}ws`;
}

function connect(room, name) {
  disconnect();
  state.room = room;
  state.name = name;
  state.retries = 0;
  setHash(room);
  showGame();
  open();
}

function open() {
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  ws.onopen = () => send({ type: "join", room: state.room, name: state.name });
  ws.onmessage = (event) => {
    try {
      handle(JSON.parse(event.data));
    } catch (err) {
      console.error(err);
    }
  };
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.connected = false;
    state.ws = null;
    const delay = Math.min(10000, 500 * 2 ** state.retries++);
    state.retryTimeout = setTimeout(open, delay);
    render();
  };
}

function disconnect() {
  clearTimeout(state.retryTimeout);
  const ws = state.ws;
  state.ws = null;
  state.connected = false;
  if (ws) ws.close();
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
    return true;
  }
  toast("Not connected — hang on…");
  return false;
}

function handle(msg) {
  switch (msg.type) {
    case "welcome": {
      state.connected = true;
      state.retries = 0;
      state.version = msg.version;
      state.room = msg.room;
      state.name = msg.you;
      state.players = msg.players;
      state.spectators = msg.spectators;
      state.settings = msg.settings;
      state.timerLengths = msg.timerLengths;
      state.wordlists = msg.wordlists;
      state.round = msg.round;
      state.history = msg.history;
      state.log = msg.log;
      setTimer(msg.timer);
      loadNotes();
      session.set({ room: state.room, name: state.name });
      setHash(state.room);
      render();
      scrollLog(true);
      break;
    }
    case "roster":
      state.players = msg.players;
      state.spectators = msg.spectators;
      renderRound();
      renderRoster();
      renderStart();
      break;
    case "round":
      state.round = msg.round;
      if (msg.reveal && !state.history.some((r) => r.number === msg.reveal.number)) {
        state.history.unshift(msg.reveal);
      }
      state.confirmStartUntil = 0;
      setTimer(null);
      loadNotes();
      render();
      if (inRound()) {
        navigator.vibrate?.(60);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      break;
    case "log":
      addLog(msg.entry);
      break;
    case "timer":
      setTimer(msg.timer);
      if (msg.timer) navigator.vibrate?.([80, 60, 80]);
      break;
    case "settings":
      state.settings = msg.settings;
      renderSettings();
      break;
    case "error":
      if (msg.fatal) {
        disconnect();
        session.set(null);
        showJoin(msg.message);
      } else {
        addLog({ kind: "error", text: msg.message, at: Date.now() });
        toast(msg.message);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Screens & routing

function roomFromHash() {
  try {
    return decodeURIComponent(location.hash.slice(1)).trim().toLowerCase();
  } catch {
    return "";
  }
}

function setHash(room) {
  if (roomFromHash() !== room) history.replaceState(null, "", `#${encodeURIComponent(room)}`);
}

function randomRoom() {
  const words = ["tower", "moat", "keep", "gate", "crown", "banner", "throne", "drawbridge", "turret", "vault"];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(100 + Math.random() * 900)}`;
}

function showJoin(error) {
  $("#game-screen").hidden = true;
  $("#join-screen").hidden = false;
  $("#join-name").value = store.get("name", "");
  $("#join-room").value = roomFromHash() || state.room || randomRoom();
  $("#join-error").hidden = !error;
  $("#join-error").textContent = error || "";
  document.title = "Castlefall";
  ($("#join-name").value ? $("#join-room") : $("#join-name")).focus();
}

function showGame() {
  $("#join-screen").hidden = true;
  $("#game-screen").hidden = false;
}

function cleanRoom(value) {
  return value.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-") || "lobby";
}

$("#join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("#join-name").value.trim();
  if (!name) {
    $("#join-name").focus();
    $("#join-error").hidden = false;
    $("#join-error").textContent = "Pick a name so others know who you are.";
    return;
  }
  store.set("name", name);
  connect(cleanRoom($("#join-room").value), name);
});

$("#leave-room").addEventListener("click", () => {
  disconnect();
  session.set(null);
  history.replaceState(null, "", location.pathname);
  state.room = null;
  showJoin();
});

window.addEventListener("hashchange", () => {
  const room = roomFromHash();
  if (room && state.ws && room !== state.room) {
    state.room = room;
    send({ type: "join", room, name: state.name });
  }
});

// ---------------------------------------------------------------------------
// Local notes (crossed-out words, suspected teammates) — never sent anywhere

function notesKey() {
  return state.round ? `${state.room}:${state.round.number}` : null;
}

function loadNotes() {
  const saved = store.get("notes", null);
  const key = notesKey();
  if (saved && key && saved.key === key) {
    state.notes = { crossed: new Set(saved.crossed), marks: saved.marks };
  } else {
    state.notes = { crossed: new Set(), marks: {} };
  }
}

function saveNotes() {
  store.set("notes", { key: notesKey(), crossed: [...state.notes.crossed], marks: state.notes.marks });
}

// ---------------------------------------------------------------------------
// Rendering

function render() {
  renderHeader();
  renderRound();
  renderStart();
  renderHistory();
  renderSettings();
  renderRoster();
  renderLog();
  renderTimer();
}

function renderHeader() {
  $("#room-name").textContent = `#${state.room ?? ""}`;
  $("#conn-dot").classList.toggle("bad", !state.connected);
  const you = $("#you-label");
  you.replaceChildren(state.name ? h("span", {}, "Playing as ", h("strong", {}, state.name)) : "Watching");
  $("#version").textContent = state.version ? `v${state.version}` : "";
  document.title = state.round ? `Round ${state.round.number} · Castlefall` : "Castlefall";

  const banner = $("#status-banner");
  banner.hidden = state.connected;
  banner.textContent = state.version ? "Connection lost — reconnecting…" : "Connecting…";
}

function teamSplit(n) {
  if (n < 2) return "need more players";
  return `${Math.ceil(n / 2)} vs ${Math.floor(n / 2)}`;
}

function renderRound() {
  const area = $("#round-area");
  const round = state.round;

  if (!round) {
    area.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("h1", {}, "Waiting for the first round"),
        h(
          "p",
          {},
          "Share the room link with everyone playing, then start a round. Each player gets a secret word; find your team without giving it away.",
        ),
        h(
          "p",
          { style: "margin-top: 1rem" },
          h("button", { class: "btn btn-ghost btn-sm", onclick: shareRoom }, "Copy invite link"),
        ),
      ),
    );
    return;
  }

  const n = round.players.length;
  const list = state.wordlists.find((w) => w.id === round.wordlist);
  const shownWord = round.word && !state.wordHidden ? round.word : null;
  const connected = new Map(state.players.map((p) => [p.name, p.connected]));

  area.replaceChildren(
    h(
      "div",
      { class: "round-head" },
      h("h1", {}, `Round ${round.number}`),
      h("span", { class: "round-meta" }, `${n} ${n === 1 ? "player" : "players"} · ${teamSplit(n)} · started by ${round.starter}`),
    ),

    wordCard(round),

    h(
      "div",
      { class: "section-label" },
      h("h2", {}, `${round.words.length} words${list ? ` · ${prettyList(list.id)}` : ""}`),
      h("span", { class: "muted small" }, "Tap to cross out"),
    ),
    h(
      "ul",
      { class: "words" },
      round.words.map((word) =>
        h(
          "li",
          {},
          h(
            "button",
            {
              class: `word${word === shownWord ? " mine" : ""}${state.notes.crossed.has(word) ? " crossed" : ""}`,
              "aria-pressed": String(state.notes.crossed.has(word)),
              onclick: () => {
                const crossed = state.notes.crossed;
                crossed.has(word) ? crossed.delete(word) : crossed.add(word);
                saveNotes();
                renderRound();
              },
            },
            word,
          ),
        ),
      ),
    ),

    h(
      "div",
      { class: "section-label", style: "margin-top: 1.4rem" },
      h("h2", {}, "Players this round"),
      h("span", { class: "muted small" }, inRound() ? "Tap: ✓ teammate · ✗ rival" : ""),
    ),
    h(
      "ul",
      { class: "chips" },
      round.players.map((name) => {
        const me = name === state.name;
        const mark = state.notes.marks[name];
        const away = connected.get(name) === false || !connected.has(name);
        return h(
          "li",
          {},
          h(
            "button",
            {
              class: `chip${me ? " me" : ""}${mark ? ` ${mark}` : ""}${away ? " away" : ""}`,
              disabled: me,
              title: away ? "Not connected" : undefined,
              onclick: () => {
                const next = { undefined: "ally", ally: "rival", rival: undefined }[mark];
                if (next) state.notes.marks[name] = next;
                else delete state.notes.marks[name];
                saveNotes();
                renderRound();
              },
            },
            me ? null : h("span", { class: "mark", "aria-hidden": "true" }, mark === "ally" ? "✓" : mark === "rival" ? "✗" : "·"),
            name,
            me ? " (you)" : null,
          ),
        );
      }),
    ),
  );
}

function wordCard(round) {
  if (round.word) {
    const hidden = state.wordHidden;
    return h(
      "button",
      {
        class: `word-card${hidden ? " hidden-word" : ""}`,
        "aria-label": hidden ? "Show your word" : "Hide your word",
        onclick: () => {
          state.wordHidden = !state.wordHidden;
          store.set("wordHidden", state.wordHidden);
          renderRound();
        },
      },
      h("span", { class: "label" }, "Your word"),
      h("span", { class: "word-big" }, hidden ? "• • • • •" : round.word),
      h("span", { class: "tap" }, hidden ? "Tap to reveal" : "Tap to hide"),
    );
  }
  if (state.name) {
    return h(
      "div",
      { class: "word-card spectating" },
      h("span", { class: "label" }, "Sitting this one out"),
      h("span", { class: "word-big", style: "font-size: 1.4rem" }, "You joined mid-round"),
      h("span", { class: "tap" }, "You’ll get a word when the next round starts."),
    );
  }
  return h(
    "div",
    { class: "word-card spectating" },
    h("span", { class: "label" }, "Spectating"),
    h("span", { class: "word-big", style: "font-size: 1.4rem" }, "You’re watching this room"),
    h("button", { class: "btn btn-primary btn-sm", onclick: () => setSpectating(false) }, "Join as a player"),
  );
}

function prettyList(id) {
  return id.replace(/[-_]/g, " ");
}

function renderStart() {
  const select = $("#start-list");
  // Prefer: what's selected now, this device's last pick, the room's last list, then the friendliest list.
  const current = [select.value, store.get("list", ""), state.round?.wordlist, "things"].find((id) =>
    state.wordlists.some((w) => w.id === id),
  );
  select.replaceChildren(
    ...state.wordlists.map((w) => h("option", { value: w.id }, `${prettyList(w.id)} (${w.size})`)),
  );
  if (current) select.value = current;

  const disabled = !isPlayer();
  for (const el of $("#start-form").querySelectorAll("button, input, select")) el.disabled = disabled;
  wheel.classList.toggle("disabled", disabled);
  wheel.tabIndex = disabled ? -1 : 0;
  syncWheel();

  const confirming = Date.now() < state.confirmStartUntil;
  const next = (state.round?.number ?? 0) + 1;
  $("#start-label").textContent = confirming
    ? `Tap again to start round ${next}`
    : state.round
      ? `Start round ${next}`
      : "Start first round";
  $("#start-btn").classList.toggle("btn-accent", confirming);
  $("#start-btn").classList.toggle("btn-primary", !confirming);

  const players = state.players.length;
  $("#start-hint").textContent = !state.name
    ? "Join as a player to start rounds."
    : state.round
      ? "Starting a new round reveals everyone’s words from this one."
      : players < 4
        ? `${players} ${players === 1 ? "player" : "players"} here. Castlefall is best with 6–10.`
        : `${players} players here. Everyone in the room gets a word.`;
}

// Word count wheel: a snap-scrolling column of numbers; whichever sits in the middle is the count.
const COUNT_MIN = 2;
const COUNT_MAX = 100;
const wheel = $("#start-count");
let wordCount = Math.min(COUNT_MAX, Math.max(COUNT_MIN, Number(store.get("count", 18)) || 18));
for (let n = COUNT_MIN; n <= COUNT_MAX; n++) wheel.append(h("div", {}, String(n)));
wheel.setAttribute("aria-valuemin", COUNT_MIN);
wheel.setAttribute("aria-valuemax", COUNT_MAX);

function markWheel() {
  [...wheel.children].forEach((el, i) => el.classList.toggle("on", i === wordCount - COUNT_MIN));
  wheel.setAttribute("aria-valuenow", wordCount);
}

/** Scroll the wheel to the current count. Does nothing while the wheel is hidden or already there. */
function syncWheel(smooth = false) {
  const row = wheel.firstElementChild.offsetHeight;
  if (!row) return;
  const index = wordCount - COUNT_MIN;
  if (Math.round(wheel.scrollTop / row) !== index) {
    wheel.scrollTo({ top: index * row, behavior: smooth ? "smooth" : "instant" });
  }
}

function setCount(n) {
  wordCount = Math.min(COUNT_MAX, Math.max(COUNT_MIN, n));
  store.set("count", wordCount);
  markWheel();
}

markWheel();
wheel.addEventListener("scroll", () => {
  const row = wheel.firstElementChild.offsetHeight;
  if (!row) return;
  const n = COUNT_MIN + Math.round(wheel.scrollTop / row);
  if (n !== wordCount) setCount(n);
});
wheel.addEventListener("click", (event) => {
  const index = [...wheel.children].indexOf(event.target);
  if (index < 0) return;
  if (index === wordCount - COUNT_MIN) editCount();
  else wheel.scrollTo({ top: index * event.target.offsetHeight, behavior: "smooth" });
});
wheel.addEventListener("keydown", (event) => {
  if (/^\d$/.test(event.key)) {
    event.preventDefault();
    return editCount(event.key);
  }
  const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
  if (!step) return;
  event.preventDefault();
  setCount(wordCount + step);
  syncWheel();
});

// Typing a count: an input laid over the middle row of the wheel.
const countInput = $("#count-input");

function editCount(initial) {
  countInput.value = initial ?? wordCount;
  countInput.hidden = false;
  countInput.focus();
  if (initial == null) countInput.select();
}

function closeCountInput(commit) {
  if (countInput.hidden) return;
  const n = parseInt(countInput.value, 10);
  countInput.hidden = true;
  if (commit && n) {
    setCount(n);
    syncWheel();
  }
}

countInput.addEventListener("input", () => {
  countInput.value = countInput.value.replace(/\D/g, "").slice(0, 3);
});
countInput.addEventListener("blur", () => closeCountInput(true));
countInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== "Escape") return;
  event.preventDefault();
  closeCountInput(event.key === "Enter");
  wheel.focus();
});
$("#start-list").addEventListener("change", (event) => store.set("list", event.target.value));

$("#start-form").addEventListener("submit", (event) => {
  event.preventDefault();
  // A round in progress ends when the next one starts, so ask for a second tap.
  if (state.round && Date.now() >= state.confirmStartUntil) {
    state.confirmStartUntil = Date.now() + 3000;
    renderStart();
    setTimeout(renderStart, 3100);
    return;
  }
  state.confirmStartUntil = 0;
  send({
    type: "start",
    round: state.round?.number ?? 0,
    wordlist: $("#start-list").value,
    wordcount: wordCount,
  });
  renderStart();
});

function teamsView(round) {
  const words = [...new Set(round.players.map((p) => p.word))];
  const myTeam = round.players.find((p) => p.name === state.name)?.word;
  return h(
    "div",
    { class: "teams" },
    words.map((word) => {
      const members = round.players.filter((p) => p.word === word);
      return h(
        "div",
        { class: "team" },
        word === myTeam ? h("div", { class: "yours" }, "Your team") : null,
        h("div", { class: "team-word" }, word),
        h(
          "ul",
          {},
          members.map((p) => h("li", { class: p.name === state.name ? "me" : null }, p.name)),
        ),
      );
    }),
  );
}

function renderHistory() {
  const [latest, ...older] = state.history;
  const showLatest = latest && state.round && latest.number === state.round.number - 1;

  $("#reveal-area").replaceChildren(
    ...(showLatest
      ? [h(
          "section",
          { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, `Round ${latest.number} — the teams were`)),
          teamsView(latest),
        )]
      : []),
  );

  const rest = showLatest ? older : state.history;
  const wasOpen = $("#history-area details")?.open;
  $("#history-area").replaceChildren(
    ...(rest.length
      ? [h(
          "details",
          { class: "card history", open: wasOpen },
          h("summary", {}, h("h2", {}, `Earlier rounds (${rest.length})`)),
          h(
            "div",
            { class: "history-list" },
            rest.map((round) =>
              h("div", { class: "history-item" }, h("h3", {}, `Round ${round.number}`), teamsView(round)),
            ),
          ),
        )]
      : []),
  );
}

function renderSettings() {
  const select = $("#timer-length");
  select.replaceChildren(
    ...state.timerLengths.map((s) => h("option", { value: s }, s < 60 || s % 60 ? `${s} sec` : `${s / 60} min`)),
  );
  select.value = state.settings.timerLength;
  select.disabled = !isPlayer();
  $("#timer-start").disabled = !isPlayer();
  $("#spectate").checked = !state.name;
  $("#spectate").disabled = !state.connected;
  $("#autokick").checked = state.settings.autokick;
  $("#autokick").disabled = !isPlayer();
  $("#sound").checked = state.sound;
}

$("#timer-length").addEventListener("change", (e) => send({ type: "settings", timerLength: Number(e.target.value) }));
/** Switch between playing and watching by rejoining the room with or without a name. */
function setSpectating(spectating) {
  const name = spectating ? null : store.get("name", "");
  if (!spectating && !name) return showJoin();
  if (!send({ type: "join", room: state.room, name })) renderSettings();
}

$("#spectate").addEventListener("change", (e) => setSpectating(e.target.checked));
$("#autokick").addEventListener("change", (e) => send({ type: "settings", autokick: e.target.checked }));
$("#sound").addEventListener("change", (e) => {
  state.sound = e.target.checked;
  store.set("sound", state.sound);
});
$("#timer-start").addEventListener("click", () => send({ type: "timer" }));
$("#timer-stop").addEventListener("click", () => send({ type: "timer", cancel: true }));

function renderRoster() {
  const players = state.players;
  $("#room-count").textContent = `${players.length} ${players.length === 1 ? "player" : "players"}`;
  $("#roster").replaceChildren(
    ...players.map((p) =>
      h(
        "li",
        { class: p.connected ? null : "away" },
        h("span", { class: "dot", "aria-hidden": "true" }),
        h("span", { class: "rname" }, p.name),
        p.name === state.name ? h("span", { class: "tag" }, "you") : null,
        !p.connected ? h("span", { class: "tag" }, "offline") : null,
        isPlayer()
          ? h(
              "button",
              {
                class: "kick",
                title: `Remove ${p.name}`,
                "aria-label": `Remove ${p.name} from the room`,
                onclick: () => {
                  const self = p.name === state.name;
                  if (confirm(self ? "Leave the room?" : `Remove ${p.name} from the room?`)) {
                    send({ type: "kick", name: p.name });
                  }
                },
              },
              svg(ICONS.x),
            )
          : null,
      ),
    ),
  );
  const s = state.spectators;
  $("#spectator-count").textContent = s ? `+ ${s} watching` : "";
}

// ---------------------------------------------------------------------------
// Activity log & chat

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function logItem(entry) {
  const time = h("time", {}, timeFmt.format(new Date(entry.at)));
  switch (entry.kind) {
    case "chat":
      return h("li", {}, time, h("span", { class: "text" }, h("span", { class: "who" }, entry.name), " ", entry.text));
    case "round":
      return h("li", {}, time, h("span", { class: "round-entry" }, entry.text));
    case "timer":
      return h("li", {}, time, h("span", { class: "timer-entry" }, entry.text));
    case "error":
      return h("li", {}, time, h("span", { class: "err" }, entry.text));
    default:
      return h("li", {}, time, h("span", { class: "sys" }, entry.text));
  }
}

function renderLog() {
  const log = $("#log");
  log.replaceChildren(
    ...(state.log.length ? state.log.map(logItem) : [h("li", { class: "log-empty" }, "Nothing yet. Say hi!")]),
  );
}

function addLog(entry) {
  const log = $("#log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  state.log.push(entry);
  if (state.log.length > 200) state.log.shift();
  if (state.log.length === 1) log.replaceChildren();
  log.append(logItem(entry));
  scrollLog(atBottom);
}

function scrollLog(force) {
  if (force) requestAnimationFrame(() => ($("#log").scrollTop = $("#log").scrollHeight));
}

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  if (!state.name) return toast("Join as a player to chat.");
  if (send({ type: "chat", text })) {
    input.value = "";
    scrollLog(true);
  }
});

// ---------------------------------------------------------------------------
// Shared timer

let timerFrame = null;
let lastBeep = null;
let audio = null;

function setTimer(timer) {
  state.timer = timer ? { ...timer, endsAt: performance.now() + timer.remaining } : null;
  lastBeep = null;
  renderTimer();
}

function beep(freq, duration) {
  if (!state.sound) return;
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duration);
  } catch {}
}
// Browsers only allow audio after a user gesture.
document.addEventListener("pointerdown", () => {
  if (state.sound && !audio) {
    try {
      audio = new AudioContext();
    } catch {}
  }
}, { once: true });

function renderTimer() {
  cancelAnimationFrame(timerFrame);
  const banner = $("#timer-banner");
  const timer = state.timer;
  if (!timer) {
    banner.hidden = true;
    return;
  }
  const remaining = timer.endsAt - performance.now();
  if (remaining <= -5000) {
    state.timer = null;
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $("#timer-stop").hidden = !isPlayer() || remaining <= 0;

  const seconds = Math.ceil(remaining / 1000);
  if (remaining > 0) {
    $("#timer-num").textContent = seconds;
    $("#timer-label").textContent = `${timer.by} started the timer`;
    $("#timer-fill").style.transform = `scaleX(${remaining / (timer.length * 1000)})`;
    banner.classList.toggle("warn", seconds <= 10);
    banner.classList.remove("done");
    if (seconds <= 3 && lastBeep !== seconds) {
      lastBeep = seconds;
      beep(660, 0.12);
    }
  } else {
    $("#timer-num").textContent = "0";
    $("#timer-label").textContent = "Time’s up!";
    if (!banner.classList.contains("done")) {
      banner.classList.add("done");
      beep(880, 0.6);
      navigator.vibrate?.([200, 100, 200]);
    }
  }
  timerFrame = requestAnimationFrame(renderTimer);
}

// ---------------------------------------------------------------------------
// Sharing & toasts

let toastTimeout = null;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => (el.hidden = true), 2600);
}

async function shareRoom() {
  const url = `${location.origin}${location.pathname}#${encodeURIComponent(state.room)}`;
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try {
      await navigator.share({ title: "Join my Castlefall game", url });
      return;
    } catch {}
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied");
  } catch {
    prompt("Copy this link:", url);
  }
}
$("#share-room").addEventListener("click", shareRoom);

// ---------------------------------------------------------------------------
// Boot

{
  const saved = session.get();
  const hashRoom = roomFromHash();
  if (saved && (!hashRoom || hashRoom === saved.room)) {
    connect(saved.room, saved.name);
  } else {
    showJoin();
  }
}
