/* Native browser UI. Diagnostics payloads are always inserted as text, never HTML. */
const $ = (id) => document.getElementById(id);
const defaults = {
  speechStartMs: 100,
  silenceMs: 700,
  transcriptionTimeoutMs: 8000,
  feedbackDelayMs: 2000,
  feedbackEnabled: true,
  speechSpeed: 1,
};
const fields = [
  [
    "speechStartMs",
    "Speech detection",
    40,
    500,
    20,
    "ms",
    "Sustained voice needed to pause playback.",
  ],
  [
    "silenceMs",
    "End-of-speech silence",
    200,
    2000,
    20,
    "ms",
    "How long to wait before submitting audio.",
  ],
  [
    "transcriptionTimeoutMs",
    "Whisper deadline",
    1000,
    30000,
    500,
    "ms",
    "Recognition is also bounded by audio age.",
  ],
  [
    "feedbackDelayMs",
    "Thinking cue delay",
    500,
    10000,
    500,
    "ms",
    "Wait before playing a single thinking cue.",
  ],
  [
    "speechSpeed",
    "Speaking speed",
    0.7,
    1.4,
    0.05,
    "×",
    "VOICEVOX speed for the next answer.",
  ],
];
let demo = new URLSearchParams(location.search).has("demo");
let data = {
  now: Date.now(),
  revision: 0,
  settings: defaults,
  defaults,
  events: [],
  sessions: [],
};
let selectedSession = "",
  selectedTurn = "",
  paused = false,
  dirty = false,
  settingsReady = false,
  baseRevision = 0,
  authorized = false,
  requestPending = false;
const element = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const ms = (value) =>
  Number.isFinite(value) ? Math.round(value).toLocaleString() : "—";
const short = (id) => (id ? id.slice(0, 8) : "—");
const time = (at) =>
  new Date(at).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
function notice(text, error = false) {
  $("notice").hidden = !text;
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
}
function connection(text, live = false) {
  $("connection").replaceChildren(element("i"), document.createTextNode(text));
  $("connection").classList.toggle("live", live);
}
function buildControls() {
  for (const [name, label, min, max, step, unit, hint] of fields) {
    const control = element("div", "control"),
      heading = element("div", "control-heading"),
      title = element("label", "", label);
    title.htmlFor = `setting-${name}`;
    const input = element("input");
    Object.assign(input, {
      type: "number",
      name,
      id: `setting-${name}`,
      min,
      max,
      step,
      value: defaults[name],
    });
    input.setAttribute("aria-label", `${label} (${unit})`);
    const range = element("input");
    Object.assign(range, {
      type: "range",
      min,
      max,
      step,
      value: defaults[name],
    });
    range.dataset.setting = name;
    range.setAttribute("aria-label", `${label} slider`);
    input.addEventListener("input", () => {
      range.value = input.value;
      markDirty();
    });
    range.addEventListener("input", () => {
      input.value = range.value;
      markDirty();
    });
    heading.append(title, input);
    const labels = element("div", "range-labels");
    labels.append(
      element("span", "", `${min.toLocaleString()} ${unit}`),
      element("span", "", `${max.toLocaleString()} ${unit}`),
    );
    control.append(heading, element("small", "", hint), range, labels);
    $("controls").append(control);
  }
  $("settings-form").elements.feedbackEnabled.addEventListener(
    "change",
    markDirty,
  );
}
function markDirty() {
  dirty = true;
  $("settings-status").textContent = "Unsaved changes";
  $("apply").disabled = !authorized && !demo;
}
function fillSettings(settings, revision = data.revision) {
  for (const [name] of fields) {
    $(`setting-${name}`).value = settings[name];
    document.querySelector(`[data-setting="${name}"]`).value = settings[name];
  }
  $("settings-form").elements.feedbackEnabled.checked =
    settings.feedbackEnabled;
  baseRevision = revision;
  dirty = false;
  settingsReady = true;
  $("settings-status").textContent = "No pending changes";
  $("apply").disabled = true;
}
function readSettings() {
  return Object.fromEntries([
    ...fields.map(([name]) => [name, Number($(`setting-${name}`).value)]),
    ["feedbackEnabled", $("settings-form").elements.feedbackEnabled.checked],
  ]);
}
async function api(path, method = "GET", body) {
  const response = await fetch(`/api/voice-debug/${path}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(
      payload.error ?? `Request failed (${response.status})`,
    );
    error.status = response.status;
    throw error;
  }
  return payload;
}
function turns() {
  const groups = new Map();
  for (const event of data.events) {
    if (event.sessionId !== selectedSession || !event.turnId) continue;
    let group = groups.get(event.turnId);
    if (!group) {
      group = { id: event.turnId, events: [] };
      groups.set(event.turnId, group);
    }
    group.events.push(event);
  }
  return [...groups.values()]
    .filter((group) =>
      group.events.some((event) => event.type === "utterance.queued"),
    )
    .map((group) => {
      const first = (type) => group.events.find((event) => event.type === type);
      const errors = group.events.find(
        (event) =>
          event.type.endsWith(".error") && event.detail !== "cancelled",
      );
      const decision =
        first("decision")?.detail ??
        (first("utterance.dropped")
          ? `ignore: ${first("utterance.dropped").detail}`
          : "");
      const outcome = errors
        ? "error"
        : first("turn.cancel") || decision.startsWith("stop")
          ? "cancel"
          : decision.startsWith("ignore")
            ? "ignore"
            : decision
              ? "answer"
              : "pending";
      const queued = first("utterance.queued"),
        audio = group.events.find(
          (event) => event.type === "audio.start" && event.kind === "reply",
        );
      return {
        ...group,
        first,
        decision,
        outcome,
        at: queued.at,
        transcript: first("whisper.finish")?.text,
        answer: first("codex.finish")?.text,
        firstAudio: audio ? audio.at - queued.at : undefined,
        userId: queued.userId,
      };
    })
    .sort((a, b) => b.at - a.at);
}
function render() {
  const focusedTurn = document.activeElement?.dataset?.turnId;
  const options = data.sessions
    .map((session) => `${session.id}:${session.closedAt ?? ""}`)
    .join("|");
  if ($("session").dataset.options !== options) {
    const choices = data.sessions
      .slice()
      .reverse()
      .map((session) => {
        const option = element(
          "option",
          "",
          `${demo ? "General" : session.channelId} · ${short(session.id)}${session.closedAt ? " · ended" : ""}`,
        );
        option.value = session.id;
        return option;
      });
    if (!choices.length) {
      const option = element("option", "", "Waiting for a voice session");
      option.value = "";
      choices.push(option);
    }
    $("session").replaceChildren(...choices);
    $("session").dataset.options = options;
  }
  if (!data.sessions.some((s) => s.id === selectedSession))
    selectedSession =
      data.sessions.findLast((s) => !s.closedAt)?.id ??
      data.sessions.at(-1)?.id ??
      "";
  $("session").value = selectedSession;
  const session = data.sessions.find((s) => s.id === selectedSession);
  $("session-status").textContent =
    session?.connection?.toUpperCase() ?? "OFFLINE";
  $("speaker-status").textContent = session?.speakers.length
    ? `${session.speakers.length} speaking · ${session.speakers.map(short).join(", ")}`
    : "No active speakers";
  $("queue-status").textContent =
    `${session?.queueDepth ?? 0} utterances queued`;
  $("playback-status").textContent = `Playback ${session?.playback ?? "idle"}`;
  $("stop").disabled = !session?.activeTurn;
  const groups = turns();
  const latest = groups[0];
  for (const [id, value] of [
    ["first", latest?.firstAudio],
    ["stt", latest?.first("whisper.finish")?.durationMs],
    ["codex", latest?.first("codex.first_delta")?.durationMs],
    ["tts", latest?.first("tts.finish")?.durationMs],
  ])
    $("metric-" + id).replaceChildren(
      document.createTextNode(ms(value)),
      element("small", "", "ms"),
    );
  const activeEvents = data.events.filter(
    (e) => e.sessionId === selectedSession && e.turnId === session?.activeTurn,
  );
  const synthesizing =
    activeEvents.filter((e) => e.type === "tts.start").length >
    activeEvents.filter(
      (e) => e.type === "tts.finish" || e.type === "tts.error",
    ).length;
  const stages = [
    [
      "Capture",
      Boolean(session?.speakers.length),
      session?.speakers.length ? "Receiving speech" : "Listening for speech",
    ],
    [
      "Whisper",
      Boolean(session?.transcribing),
      session?.transcribing ? "Recognizing utterance" : "Ready for audio",
    ],
    [
      "Codex",
      Boolean(session?.activeTurn) &&
        !activeEvents.some(
          (e) => e.type === "codex.finish" || e.type === "codex.error",
        ),
      "Streaming short replies",
    ],
    [
      "VOICEVOX",
      synthesizing || session?.playback === "playing",
      session?.playback === "paused"
        ? "Paused for speaker"
        : synthesizing
          ? "Synthesizing sentence"
          : "Playback " + (session?.playback ?? "idle"),
    ],
  ];
  $("pipeline").replaceChildren(
    ...stages.map(([label, active, description]) => {
      const stage = element("div", "stage" + (active ? " active" : ""));
      const title = element("div", "stage-title");
      title.append(element("i", "stage-dot"), document.createTextNode(label));
      stage.append(title, element("p", "", description));
      return stage;
    }),
  );
  $("turn-count").textContent = groups.length;
  const filtered = groups
    .filter(
      (g) => $("filter").value === "all" || g.outcome === $("filter").value,
    )
    .slice(0, 30);
  if (!groups.some((group) => group.id === selectedTurn))
    selectedTurn = groups[0]?.id ?? "";
  $("turns").replaceChildren(
    ...filtered.map((group) => {
      const row = element("tr", group.id === selectedTurn ? "selected" : "");
      const transcript = element("td"),
        button = element("button", "turn-link");
      button.dataset.turnId = group.id;
      button.append(
        element(
          "strong",
          "",
          group.transcript ??
            (group.first("whisper.error")
              ? "Recognition failed"
              : "Transcribing…"),
        ),
        element(
          "small",
          "",
          `${demo ? group.userId : short(group.userId)} / ${short(group.id)}`,
        ),
      );
      button.addEventListener("click", () => {
        selectedTurn = group.id;
        render();
      });
      transcript.append(button);
      const outcome = element("td");
      outcome.append(
        element(
          "span",
          `badge ${group.outcome}`,
          {
            answer: "Answer",
            ignore: "Ignored",
            cancel: "Stopped",
            error: "Error",
            pending: "Pending",
          }[group.outcome],
        ),
      );
      row.append(
        transcript,
        outcome,
        element(
          "td",
          "mono muted",
          group.firstAudio !== undefined ? `${ms(group.firstAudio)} ms` : "—",
        ),
        element("td", "mono muted", time(group.at)),
      );
      return row;
    }),
  );
  if (focusedTurn) {
    const button = Array.from(document.querySelectorAll(".turn-link")).find(
      (node) => node.dataset.turnId === focusedTurn,
    );
    button?.focus({ preventScroll: true });
  }
  $("empty").hidden = filtered.length > 0;
  $("empty").querySelector("h3").textContent = groups.length
    ? "No matching turns"
    : "Waiting for the first word";
  inspect(groups.find((g) => g.id === selectedTurn));
  $("revision").textContent = `r${data.revision}`;
  if (!settingsReady || (!dirty && baseRevision !== data.revision))
    fillSettings(data.settings);
  $("last-update").textContent =
    `${demo ? "Sample trace" : "Updated"} ${time(data.now)}${paused ? " · updates paused" : ""}`;
  $("export").disabled = !data.events.length;
  $("clear").disabled = !data.events.length || (!authorized && !demo);
}
function inspect(group) {
  $("selected-id").textContent = group ? short(group.id) : "No turn selected";
  $("selected-status").textContent = group?.outcome.toUpperCase() ?? "—";
  $("transcript").textContent = group?.transcript ?? "No transcript available.";
  $("answer").textContent =
    group?.answer ??
    (group?.events
      .filter((event) => event.type === "tts.start")
      .map((event) => event.text)
      .join(" ") ||
      undefined) ??
    (group?.outcome === "ignore"
      ? "No model request. See the host routing decision below."
      : group?.outcome === "error"
        ? "This turn failed. See the event log."
        : "Waiting for a model reply.");
  $("decision").textContent = group?.decision ?? "No decision yet.";
  const events = group?.events ?? [];
  $("event-count").textContent = events.length;
  const origin = events[0]?.at ?? 0;
  $("event-log").replaceChildren(
    ...events.map((event) => {
      const row = element("li");
      row.append(
        element("time", "", `+${ms(event.at - origin)}`),
        element("span", "event-name", event.type),
        element(
          "span",
          "event-note",
          event.detail ??
            event.text ??
            (event.durationMs !== undefined
              ? `${ms(event.durationMs)} ms`
              : event.audioMs !== undefined
                ? `${ms(event.audioMs)} ms audio`
                : ""),
        ),
      );
      return row;
    }),
  );
  const spans = [];
  const capture = events.find((e) => e.type === "capture.start"),
    queued = events.find((e) => e.type === "utterance.queued");
  if (capture && queued)
    spans.push({
      label: "Capture + silence",
      kind: "capture",
      start: capture.at,
      duration: Math.max(0, queued.at - capture.at),
    });
  for (const event of events) {
    let label, kind;
    if (event.type === "whisper.start") {
      label = "Recognition queue";
      kind = "capture";
    }
    if (event.type === "whisper.finish" || event.type === "whisper.error") {
      label = "Whisper";
      kind = "whisper";
    }
    if (event.type === "turn.start") {
      label = "Prior turn wait";
      kind = "capture";
    }
    if (event.type === "codex.finish" || event.type === "codex.error") {
      label = "Codex";
      kind = "codex";
    }
    if (event.type === "tts.finish" || event.type === "tts.error") {
      label = "Synthesis";
      kind = "tts";
    }
    if (event.type === "audio.start" && event.kind === "reply") {
      label = "Playback queue";
      kind = "audio";
    }
    if (event.type === "audio.finish" && event.kind === "reply") {
      label = "Playback";
      kind = "audio";
    }
    if (label && Number.isFinite(event.durationMs))
      spans.push({
        label,
        kind,
        start: event.at - event.durationMs,
        duration: event.durationMs,
      });
  }
  const end = Math.max(origin + 1, ...spans.map((s) => s.start + s.duration));
  const total = Math.max(1, end - origin);
  $("waterfall").replaceChildren(
    ...spans.map((span) => {
      const row = element("div", "span-row"),
        track = element("div", "span-track"),
        bar = element("div", `span-bar ${span.kind}`);
      bar.style.left = `${Math.max(0, ((span.start - origin) / total) * 100)}%`;
      bar.style.width = `${Math.min(100, Math.max(0, (span.duration / total) * 100))}%`;
      bar.title = `${span.label}: ${ms(span.duration)} ms`;
      track.append(bar);
      row.append(
        element("span", "span-label", span.label),
        track,
        element("span", "span-value", `${ms(span.duration)} ms`),
      );
      return row;
    }),
  );
  if (!spans.length)
    $("waterfall").append(
      element("p", "muted", "Timing spans appear as stages finish."),
    );
}
async function poll() {
  if (demo || paused || requestPending) return;
  requestPending = true;
  try {
    data = await api("snapshot");
    authorized = true;
    $("login-panel").hidden = true;
    $("logout").hidden = false;
    connection("Live", true);
    if (!dirty) notice("");
    render();
  } catch (error) {
    connection(error.status === 401 ? "Not connected" : "Disconnected");
    authorized = false;
    if (error.status === 401 || error.status === 503) {
      $("login-panel").hidden = false;
      $("login-error").textContent = error.status === 503 ? error.message : "";
    } else notice(error.message, true);
    $("apply").disabled = true;
  } finally {
    requestPending = false;
  }
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("login", "POST", { token: $("token").value });
    $("token").value = "";
    await poll();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
});
$("session").addEventListener("change", () => {
  selectedSession = $("session").value;
  selectedTurn = "";
  render();
});
$("filter").addEventListener("change", render);
$("pause").addEventListener("click", () => {
  paused = !paused;
  $("pause").textContent = paused ? "Resume updates" : "Pause updates";
  if (paused) connection("Updates paused");
  else if (demo) connection("Demo");
  else poll();
  render();
});
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("apply").disabled = true;
  try {
    const settings = readSettings();
    if (demo) {
      data.settings = settings;
      data.revision++;
      fillSettings(settings);
      $("settings-status").textContent = "Applied to demo only";
    } else {
      const result = await api("settings", "PATCH", {
        settings,
        revision: baseRevision,
      });
      data.settings = result.settings;
      data.revision = result.revision;
      fillSettings(result.settings);
      $("settings-status").textContent = "Applied to the next capture / answer";
    }
    render();
  } catch (error) {
    $("settings-status").textContent = error.message;
    $("apply").disabled = false;
  }
});
$("reset").addEventListener("click", () => {
  fillSettings(data.defaults);
  markDirty();
});
$("stop").addEventListener("click", async () => {
  if (demo) {
    notice("Demo only: a live Stop reply cancels the active answer.");
    return;
  }
  try {
    const result = await api("stop", "POST", { sessionId: selectedSession });
    notice(
      result.ok
        ? "Stop sent to the active voice session."
        : "That session has already ended.",
    );
    await poll();
  } catch (error) {
    notice(error.message, true);
  }
});
$("clear").addEventListener("click", async () => {
  if (demo) {
    data.events = [];
    render();
    return;
  }
  try {
    await api("clear", "POST");
    selectedTurn = "";
    await poll();
  } catch (error) {
    notice(error.message, true);
  }
});
$("export").addEventListener("click", () => {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          ...data,
          events: data.events.filter((e) => e.sessionId === selectedSession),
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const a = element("a");
  a.href = url;
  a.download = `voice-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("logout").addEventListener("click", async () => {
  try {
    await api("logout", "POST");
    location.reload();
  } catch (error) {
    notice(error.message, true);
  }
});
$("demo-toggle").addEventListener("click", () => {
  location.href = demo ? "/voice-debug" : "/voice-debug?demo=1";
});
function sampleData() {
  const now = Date.now(),
    sessionId = "demo-session";
  let id = 0;
  const events = [];
  const add = (turnId, base, offset, type, details = {}) =>
    events.push({
      id: ++id,
      sessionId,
      turnId,
      userId: "Alice",
      at: base + offset,
      type,
      ...details,
    });
  const completed = (turnId, base, heard, reply) => {
    add(turnId, base, 0, "capture.start");
    add(turnId, base, 1720, "utterance.queued", {
      audioMs: 1320,
      queueDepth: 1,
    });
    add(turnId, base, 1721, "capture.end");
    add(turnId, base, 1722, "whisper.start", { durationMs: 2, queueDepth: 0 });
    add(turnId, base, 2110, "whisper.finish", { text: heard, durationMs: 388 });
    add(turnId, base, 2111, "decision", {
      detail: "answer: idle conversation",
    });
    add(turnId, base, 2112, "turn.start", { durationMs: 1 });
    add(turnId, base, 2113, "codex.start");
    add(turnId, base, 2490, "codex.first_delta", { durationMs: 377 });
    add(turnId, base, 2580, "tts.start", { text: reply });
    add(turnId, base, 2773, "codex.finish", { text: reply, durationMs: 660 });
    add(turnId, base, 3060, "tts.finish", {
      text: reply,
      durationMs: 480,
      audioMs: 2280,
    });
    add(turnId, base, 3061, "audio.queued", { kind: "reply" });
    add(turnId, base, 3096, "audio.start", { kind: "reply", durationMs: 35 });
    add(turnId, base, 5376, "audio.finish", {
      kind: "reply",
      durationMs: 2280,
      detail: "played",
    });
    add(turnId, base, 5377, "turn.finish");
  };
  completed(
    "turn-a803c2",
    now - 90000,
    "你聽得到嗎？",
    "うん、聞こえてるよ。一緒に話そう！",
  );
  const interrupted = now - 60000;
  add("turn-d9e1b4", interrupted, 0, "utterance.queued");
  add("turn-d9e1b4", interrupted, 4, "whisper.start", { durationMs: 4 });
  add("turn-d9e1b4", interrupted, 410, "whisper.finish", {
    text: "Did you see that, Bob?",
    durationMs: 406,
  });
  add("turn-d9e1b4", interrupted, 411, "decision", {
    detail: "ignore: side conversation while answering",
  });
  completed(
    "turn-f74b91",
    now - 15000,
    "今日は何を話そうか？",
    "今日は週末の予定を話そうか。何か楽しみなことはある？",
  );
  return {
    now,
    revision: 3,
    settings: { ...defaults },
    defaults,
    retentionMs: 1800000,
    sessions: [
      {
        id: sessionId,
        guildId: "demo-guild",
        channelId: "General",
        openedAt: now - 120000,
        speakers: [],
        connection: "ready",
        playback: "idle",
        queueDepth: 0,
      },
    ],
    events,
  };
}
buildControls();
if (demo) {
  data = sampleData();
  $("demo-toggle").textContent = "Connect live";
  notice(
    "DEMO · Sample traces for exploring the interface. Changes here do not affect the bot.",
  );
  connection("Demo");
  render();
} else {
  fillSettings(defaults);
  render();
  poll();
  setInterval(poll, 1000);
}
