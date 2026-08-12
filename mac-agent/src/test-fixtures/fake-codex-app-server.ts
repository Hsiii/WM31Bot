const encoder = new TextEncoder();

function send(value: unknown) {
  Bun.stdout.write(encoder.encode(`${JSON.stringify(value)}\n`));
}

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";

async function handle(line: string) {
  if (!line.trim()) return;
  const message = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: Record<string, unknown>;
  };
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "initialized") {
    // Notification only.
  } else if (message.method === "thread/start") {
    send({
      id: message.id,
      result: { thread: { id: "thread-native", sessionId: "thread-native" } },
    });
  } else if (message.method === "thread/name/set") {
    send({ id: message.id, result: {} });
  } else if (message.method === "turn/start") {
    send({
      id: message.id,
      result: {
        turn: { id: "turn-native", status: "inProgress", items: [] },
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        item: {
          id: "reasoning-1",
          type: "reasoning",
          summary: [{ text: "Inspecting the task." }],
          content: [],
        },
      },
    });
  } else if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: "turn-native" } });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        item: {
          id: "message-1",
          type: "agentMessage",
          phase: "commentary",
          text: "Applying the new direction.",
        },
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        item: {
          id: "message-2",
          type: "agentMessage",
          phase: "final_answer",
          text: "Finished after steering.",
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-native",
        turn: { id: "turn-native", status: "completed", items: [] },
      },
    });
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-native",
        turn: { id: "turn-native", status: "interrupted", items: [] },
      },
    });
  }
}

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    await handle(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
}
