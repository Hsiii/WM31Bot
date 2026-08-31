import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requestMinisagoDeployment } from "./deploy-socket";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("submits one immutable MiniSago deployment request", async () => {
  const root = await mkdtemp(join(tmpdir(), "minisago-deploy-socket-"));
  roots.push(root);
  const socketPath = join(root, "deploy.sock");
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const channelId = "1282936453134815275";
  const requests: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (request) => {
      requests.push(request);
      socket.end(`accepted ${commit}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  await expect(
    requestMinisagoDeployment(socketPath, commit, channelId),
  ).resolves.toBe(`accepted ${commit}`);
  expect(requests).toEqual([`deploy ${commit} ${channelId}\n`]);

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("rejects a host denial", async () => {
  const root = await mkdtemp(join(tmpdir(), "minisago-deploy-socket-"));
  roots.push(root);
  const socketPath = join(root, "deploy.sock");
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const channelId = "1282936453134815275";
  const server = createServer((socket) => {
    socket.on("data", () => socket.end("busy deployment-in-progress\n"));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  await expect(
    requestMinisagoDeployment(socketPath, commit, channelId),
  ).rejects.toThrow("busy deployment-in-progress");

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
