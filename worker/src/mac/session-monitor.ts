type SessionState = "locked" | "unlocked";

export class SessionMonitor {
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private stopped = false;

  constructor(
    private readonly executablePath: string,
    private readonly onState: (state: SessionState) => void,
  ) {}

  start() {
    this.process = Bun.spawn([this.executablePath], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const stdout = this.process.stdout;
    if (!(stdout instanceof ReadableStream)) {
      throw new Error("Session monitor stdout is unavailable.");
    }

    void this.readStates(stdout);
    void this.process.exited.then((exitCode) => {
      if (!this.stopped) {
        throw new Error(`Session monitor exited with status ${exitCode}.`);
      }
    });
  }

  stop() {
    this.stopped = true;
    this.process?.kill();
    this.process = null;
  }

  private async readStates(stream: ReadableStream<Uint8Array>) {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffered += value;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        const state = line.trim();
        if (state === "locked" || state === "unlocked") {
          this.onState(state);
        }
      }
    }
  }
}
