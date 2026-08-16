import { execFileSync, spawnSync } from "node:child_process";

const repository = "orangesago/mini-sago";
const workflow = "image.yml";
const service = "minisago";
const remoteHost = process.env.SAGO_CLOUD_HOST ?? "sago-cloud";
const remoteDeployRoot =
  process.env.SAGO_CLOUD_OPERATIONS_ROOT ?? "/srv/sago-cloud/operations";
const sshConnectTimeout = "10";
const sshRetryDelay = "15";
const sshAttempts = 3;

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function hasRemote(name) {
  return output("git", ["remote"]).split("\n").includes(name);
}

function remoteBranchCommit(remote, branch) {
  return output("git", [
    "ls-remote",
    "--exit-code",
    remote,
    `refs/heads/${branch}`,
  ]).split(/\s/u)[0];
}

function deployRemote() {
  const remoteCommand = `${remoteDeployRoot}/scripts/deploy-${service}`;

  for (let attempt = 1; attempt <= sshAttempts; attempt += 1) {
    const result = spawnSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        `ConnectTimeout=${sshConnectTimeout}`,
        remoteHost,
        remoteCommand,
      ],
      { encoding: "utf8" },
    );

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status === 0) return;

    const timedOut = result.stderr?.includes("Operation timed out");
    if (!timedOut || attempt === sshAttempts) {
      if (timedOut) {
        console.error(
          `Unable to reach ${remoteHost} after ${sshAttempts} attempts. Check that its SSH service and firewall permit this network.`,
        );
      }
      process.exit(result.status ?? 1);
    }

    console.error(
      `SSH connection to ${remoteHost} timed out; retrying in ${sshRetryDelay} seconds (${attempt}/${sshAttempts}).`,
    );
    run("sleep", [sshRetryDelay]);
  }
}

function waitForImage(commit) {
  let runId = "";

  for (let attempt = 0; attempt < 30 && !runId; attempt += 1) {
    const runs = JSON.parse(
      output("gh", [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        workflow,
        "--commit",
        commit,
        "--limit",
        "1",
        "--json",
        "databaseId",
      ]),
    );

    runId = runs[0]?.databaseId?.toString() ?? "";
    if (!runId) run("sleep", ["2"]);
  }

  if (!runId) {
    console.error(`No ${workflow} run appeared for ${commit}.`);
    process.exit(1);
  }

  run("gh", ["run", "watch", runId, "--repo", repository, "--exit-status"]);
}

const branch = output("git", ["branch", "--show-current"]);

if (branch !== "main") {
  console.error(
    `Deploy from main. Current branch is ${branch || "(detached)"}.`,
  );
  process.exit(1);
}

if (output("git", ["status", "--porcelain"])) {
  console.error("Commit or stash local changes before deploying.");
  process.exit(1);
}

if (!hasRemote("origin")) {
  console.error("Missing origin remote.");
  process.exit(1);
}

const commit = output("git", ["rev-parse", "HEAD"]);
const remoteCommit = remoteBranchCommit("origin", branch);

if (commit !== remoteCommit) {
  console.error(
    "Local main does not match origin/main. Merge changes through a PR, then update local main before deploying. This script never pushes code.",
  );
  process.exit(1);
}

waitForImage(commit);
deployRemote();
