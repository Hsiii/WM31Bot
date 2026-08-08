import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { isAbsolute, join, resolve } from "node:path";

import {
  pythonSandboxRequestSchema,
  pythonSandboxResponseSchema,
} from "./python";

const PORT = 8080;
const MAX_BODY_BYTES = 56 * 1024 * 1024;
const MAX_EXECUTION_OUTPUT_BYTES = 12 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 2;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 128;
const CONTAINER_TIMEOUT_MS = 127_000;
const POLL_INTERVAL_MS = 100;
const SANDBOX_LABEL = "dev.hsichen.minisago.python-sandbox";
const jobDirectoryPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const image = process.env.MINISAGO_SANDBOX_IMAGE?.trim();
if (!image) throw new Error("MINISAGO_SANDBOX_IMAGE is required.");
const jobsRoot = resolve(
  process.env.MINISAGO_SANDBOX_JOBS_ROOT?.trim() || "/var/lib/minisago-sandbox",
);
if (!isAbsolute(jobsRoot) || jobsRoot === "/") {
  throw new Error("MINISAGO_SANDBOX_JOBS_ROOT must be a dedicated path.");
}
await mkdir(jobsRoot, { recursive: true, mode: 0o700 });
await chmod(jobsRoot, 0o700);

let activeJobs = 0;

type DockerResponse = { statusCode: number; body: Buffer };

async function dockerRequest(
  method: string,
  path: string,
  options: {
    body?: Buffer;
    contentType?: string;
    maximumResponseBytes?: number;
  } = {},
): Promise<DockerResponse> {
  const maximumResponseBytes = options.maximumResponseBytes ?? 1_000_000;
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest(
      {
        socketPath: "/var/run/docker.sock",
        method,
        path,
        headers: options.contentType
          ? { "content-type": options.contentType }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk) => {
          const bytes = Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > maximumResponseBytes) {
            request.destroy(
              new Error("Docker response exceeded the broker limit."),
            );
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          const statusCode = response.statusCode ?? 500;
          if (statusCode >= 300) {
            reject(
              new Error(
                body.toString("utf8").slice(0, 2_000) ||
                  `Docker returned ${statusCode}.`,
              ),
            );
            return;
          }
          resolveRequest({ statusCode, body });
        });
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

function jsonBody(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}

async function dockerJson<T>(method: string, path: string, value?: unknown) {
  const response = await dockerRequest(method, path, {
    ...(value === undefined ? {} : { body: jsonBody(value) }),
    contentType: "application/json",
  });
  return response.body.length
    ? (JSON.parse(response.body.toString("utf8")) as T)
    : (undefined as T);
}

function demultiplexDockerStream(buffer: Buffer) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) {
      throw new Error("Docker returned an incomplete stream header.");
    }
    const stream = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + length > buffer.byteLength) {
      throw new Error("Docker returned an incomplete stream frame.");
    }
    const frame = buffer.subarray(offset, offset + length);
    (stream === 2 ? stderr : stdout).push(frame);
    offset += length;
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function removeContainer(id: string) {
  await dockerRequest("DELETE", `/containers/${id}?force=1`).catch(() => {});
}

function safeFilename(index: number, filename: string) {
  const name = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return `${index}-${name || "attachment"}`;
}

async function removeWorkspace(directory: string) {
  await chmod(join(directory, "inputs"), 0o700).catch(() => {});
  await chmod(directory, 0o700).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

function isMissing(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function prepareWorkspace(
  request: ReturnType<typeof pythonSandboxRequestSchema.parse>,
) {
  const directory = join(jobsRoot, randomUUID());
  const inputsDirectory = join(directory, "inputs");
  try {
    await mkdir(inputsDirectory, { recursive: true, mode: 0o755 });
    const attachments = [];
    for (const [index, attachment] of request.attachments.entries()) {
      const filename = safeFilename(index, attachment.filename);
      const path = join(inputsDirectory, filename);
      await writeFile(path, Buffer.from(attachment.data, "base64"), {
        mode: 0o444,
      });
      attachments.push({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        path: `inputs/${filename}`,
      });
    }
    const outputPath = request.outputExtension
      ? `artifact.${request.outputExtension}`
      : undefined;
    await writeFile(
      join(directory, "request.json"),
      JSON.stringify({
        code: request.code,
        attachments,
        ...(outputPath ? { outputPath } : {}),
      }),
      { mode: 0o444 },
    );
    await chmod(inputsDirectory, 0o555);
    await chmod(directory, 0o757);
    return directory;
  } catch (error) {
    await removeWorkspace(directory);
    throw error;
  }
}

async function workspaceUsage(directory: string) {
  const pending = [directory];
  let bytes = 0;
  let files = 0;
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else {
        files += 1;
        try {
          bytes += (await lstat(path)).size;
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
      }
      if (files > MAX_WORKSPACE_FILES || bytes > MAX_WORKSPACE_BYTES) {
        throw new Error("Python workspace exceeded its limit.");
      }
    }
  }
}

async function waitForContainer(id: string, directory: string) {
  const deadline = Date.now() + CONTAINER_TIMEOUT_MS;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error("Python execution exceeded 127 seconds.");
    }
    await workspaceUsage(directory);
    const inspection = await dockerJson<{
      State: { Running: boolean; ExitCode: number };
    }>("GET", `/containers/${id}/json`);
    if (!inspection.State.Running) return inspection.State.ExitCode;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function execute(
  request: ReturnType<typeof pythonSandboxRequestSchema.parse>,
) {
  const directory = await prepareWorkspace(request);
  let containerId: string | undefined;
  try {
    const created = await dockerJson<{ Id: string }>(
      "POST",
      "/containers/create",
      {
        Image: image,
        AttachStderr: true,
        AttachStdout: true,
        Entrypoint: ["/usr/bin/python3"],
        Cmd: [
          "-I",
          "/app/mac-agent/src/python-runtime.py",
          "/workspace/request.json",
        ],
        User: "65534:65534",
        WorkingDir: "/workspace",
        Labels: { [SANDBOX_LABEL]: "true" },
        HostConfig: {
          AutoRemove: false,
          Binds: [`${directory}:/workspace:rw`],
          CapDrop: ["ALL"],
          Memory: 2 * 1024 * 1024 * 1024,
          MemorySwap: 2 * 1024 * 1024 * 1024,
          NanoCpus: 2_000_000_000,
          NetworkMode: "none",
          PidsLimit: 32,
          ReadonlyPaths: [
            "/app",
            "/bin",
            "/boot",
            "/etc",
            "/home",
            "/lib",
            "/lib64",
            "/opt",
            "/root",
            "/sbin",
            "/srv",
            "/usr",
            "/var",
          ],
          SecurityOpt: ["no-new-privileges"],
          Tmpfs: {
            "/tmp":
              "rw,nosuid,nodev,noexec,size=16777216,uid=65534,gid=65534,mode=0700",
          },
          Ulimits: [
            { Name: "core", Soft: 0, Hard: 0 },
            { Name: "fsize", Soft: 8 * 1024 * 1024, Hard: 8 * 1024 * 1024 },
            { Name: "nofile", Soft: 64, Hard: 64 },
          ],
        },
        StopTimeout: 1,
      },
    );
    containerId = created.Id;
    await dockerRequest("POST", `/containers/${containerId}/start`);
    const exitCode = await waitForContainer(containerId, directory);
    const logs = await dockerRequest(
      "GET",
      `/containers/${containerId}/logs?stdout=1&stderr=1`,
      { maximumResponseBytes: MAX_EXECUTION_OUTPUT_BYTES },
    );
    const streams = demultiplexDockerStream(logs.body);
    if (exitCode !== 0) {
      throw new Error(
        streams.stderr.trim().slice(0, 2_000) || "Python sandbox failed.",
      );
    }
    return pythonSandboxResponseSchema.parse(JSON.parse(streams.stdout));
  } finally {
    if (containerId) await removeContainer(containerId);
    await removeWorkspace(directory);
  }
}

async function body(request: Request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new Error("Sandbox request is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new Error("Sandbox request is too large.");
  }
  return pythonSandboxRequestSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
}

const filters = encodeURIComponent(
  JSON.stringify({ label: [`${SANDBOX_LABEL}=true`] }),
);
const stale = await dockerJson<Array<{ Id: string }>>(
  "GET",
  `/containers/json?all=1&filters=${filters}`,
);
await Promise.all(stale.map((item) => removeContainer(item.Id)));
for (const entry of await readdir(jobsRoot)) {
  if (jobDirectoryPattern.test(entry)) {
    await removeWorkspace(join(jobsRoot, entry));
  }
}

Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  idleTimeout: 140,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, active: activeJobs });
    }
    if (request.method !== "POST" || url.pathname !== "/run") {
      return new Response("Not found.", { status: 404 });
    }
    if (activeJobs >= MAX_ACTIVE_JOBS) {
      return new Response("Python sandbox is busy.", { status: 429 });
    }
    activeJobs += 1;
    try {
      return Response.json(await execute(await body(request)));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Sandbox failed.";
      return new Response(message.slice(0, 2_000), { status: 400 });
    } finally {
      activeJobs -= 1;
    }
  },
});

console.log(`MiniSago sandbox broker listening on ${PORT}.`);
