import { expect, test } from "bun:test";

const dockerfile = await Bun.file(
  new URL("./Dockerfile.worker", import.meta.url),
).text();
const hostedDockerfile = await Bun.file(
  new URL("./Dockerfile", import.meta.url),
).text();
const workerCompose = await Bun.file(
  new URL("./compose.worker.yaml", import.meta.url),
).text();
const sandboxBroker = await Bun.file(
  new URL("./mac-agent/src/sandbox-broker.ts", import.meta.url),
).text();
const sandboxRequirements = await Bun.file(
  new URL("./mac-agent/requirements-sandbox.txt", import.meta.url),
).text();
const pythonRuntime = await Bun.file(
  new URL("./mac-agent/src/python-runtime.py", import.meta.url),
).text();
const pythonClient = await Bun.file(
  new URL("./mac-agent/src/python.ts", import.meta.url),
).text();

test("worker image includes conservative media processing tools", () => {
  for (const packageName of [
    "ffmpeg",
    "file",
    "jpegoptim",
    "jq",
    "libimage-exiftool-perl",
    "optipng",
    "webp",
  ]) {
    expect(dockerfile).toContain(`    ${packageName} \\\n`);
  }
});

test("worker image includes a minimal Python runtime", () => {
  for (const packageName of ["python3", "python3-venv"]) {
    expect(dockerfile).toContain(`    ${packageName} \\\n`);
  }
  expect(dockerfile).toContain("mac-agent/requirements-sandbox.txt");
  expect(dockerfile).toContain('new_session("u2netp")');
  expect(dockerfile).toContain("NUMBA_CACHE_DIR=/opt/minisago-numba-cache");
  expect(dockerfile).toContain("remove(Image.new");
  expect(sandboxRequirements.trim()).toBe(
    "opencv-python-headless==5.0.0.93\nrembg[cpu]==2.0.76",
  );
  expect(pythonRuntime).toContain(
    'PYTHON = "/opt/minisago-python/bin/python3"',
  );
  expect(pythonRuntime).toContain('"U2NET_HOME": "/opt/minisago-models"');
  expect(pythonRuntime).toContain('"HOME": "/tmp"');
  expect(pythonRuntime).toContain(
    '"NUMBA_CACHE_DIR": "/opt/minisago-numba-cache"',
  );
  expect(sandboxBroker.match(/mode: 0o444/gu)).toHaveLength(2);
  expect(sandboxBroker).toContain("await chmod(directory, 0o757)");
  expect(sandboxBroker).toContain("removeWorkspace(directory)");
  expect(sandboxBroker).toContain("if (isMissing(error)) continue");
  expect(pythonRuntime).toContain("clean_workspace(output_path)");
});

test("images copy code from the consolidated source layout", () => {
  expect(dockerfile).toContain(
    "COPY --chown=bun:bun src/chatbot /app/src/chatbot",
  );
  expect(dockerfile).not.toContain("COPY --chown=bun:bun lib /app/lib");
  expect(hostedDockerfile).toContain(
    "COPY --from=builder --chown=bun:bun /app/src ./src",
  );
  expect(hostedDockerfile).not.toContain("/app/lib");
  expect(hostedDockerfile).not.toContain("/app/data");
});

test("hosted image includes Git for local server-memory history", () => {
  expect(hostedDockerfile).toContain("RUN apk add --no-cache git");
});

test("generic Python runs behind a private container boundary", () => {
  const sandboxOffset = workerCompose.indexOf("\n  sandbox:\n");
  const worker = workerCompose.slice(0, sandboxOffset);
  const sandbox = workerCompose.slice(sandboxOffset);
  expect(worker).not.toContain("/var/run/docker.sock");
  expect(sandbox).toContain("/var/run/docker.sock:/var/run/docker.sock");
  expect(sandbox).toContain("sandbox-internal");
  expect(sandbox).toContain("cap_drop:\n      - ALL");
  expect(sandbox).toContain("no-new-privileges:true");
  expect(workerCompose).toContain("internal: true");
  for (const guardrail of [
    'CapDrop: ["ALL"]',
    'NetworkMode: "none"',
    "PidsLimit: 32",
    'SecurityOpt: ["no-new-privileges"]',
    "MAX_WORKSPACE_BYTES = 64 * 1024 * 1024",
    "CONTAINER_TIMEOUT_MS = 127_000",
  ]) {
    expect(sandboxBroker).toContain(guardrail);
  }
});

test("Python timeout margins outlive the 120-second runtime", () => {
  expect(pythonRuntime).toContain("PROCESS_TIMEOUT_SECONDS = 120");
  expect(sandboxBroker).toContain("CONTAINER_TIMEOUT_MS = 127_000");
  expect(pythonClient).toContain("SANDBOX_TIMEOUT_MS = 130_000");
});
