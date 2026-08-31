import { access, chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { OracleAnswerJob } from "../../contracts/worker-contract";

type DeveloperWorkspaceOptions = {
  githubConfigDir: string;
  githubRepositories: string[];
  githubWorktreeRoot: string;
  deploySocketPath?: string;
  deploySocketRepository?: string;
  signal?: AbortSignal;
};

const PRESERVED_WORKSPACE_TTL_MS = 3 * 24 * 60 * 60_000;
const preservedWorkspaceTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

function preserveThenRemove(path: string) {
  const previous = preservedWorkspaceTimers.get(path);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    preservedWorkspaceTimers.delete(path);
    void rm(path, { recursive: true, force: true });
  }, PRESERVED_WORKSPACE_TTL_MS);
  timer.unref?.();
  preservedWorkspaceTimers.set(path, timer);
}

export type DeveloperWorkspace = {
  directory: string;
  environment: Record<string, string>;
  sandboxReadPaths: string[];
  sandboxWritePaths: string[];
  cleanup: () => Promise<void>;
};

const GH_WRAPPER = `#!/bin/sh
set -eu

deny() {
  echo "MiniSago denied this GitHub operation." >&2
  exit 77
}

command="\${1:-}"
subcommand="\${2:-}"
case "$command:$subcommand" in
  api:*)
    [ "$subcommand" != "graphql" ] || deny
    for argument in "$@"; do
      case "$argument" in
        -X|--method|-X*|--method=*|-f|-f*|--raw-field|--raw-field=*|-F|-F*|--field|--field=*|--input|--input=*) deny ;;
      esac
    done
    ;;
  issue:create|issue:edit|issue:close|issue:reopen|issue:comment)
    ;;
  pr:create)
    draft=false
    for argument in "$@"; do
      [ "$argument" = "--draft" ] && draft=true
    done
    [ "$draft" = true ] || deny
    ;;
  pr:merge)
    for argument in "$@"; do
      case "$argument" in
        --admin|--admin=*) deny ;;
      esac
    done
    ;;
  pr:ready|pr:review|pr:comment|repo:create|repo:delete|repo:archive|repo:edit|repo:fork|release:*|workflow:run|run:rerun|run:cancel|run:delete|secret:*|variable:*)
    deny
    ;;
  auth:status|repo:view|repo:clone|repo:list|pr:view|pr:list|pr:checks|pr:diff|pr:status|issue:view|issue:list|issue:status|run:view|run:list|run:watch|workflow:view|workflow:list|release:view|release:list|release:download|search:*|status:*|help:*|version:*)
    ;;
  *)
    deny
    ;;
esac

exec "$MINISAGO_REAL_GH" "$@"
`;

const GIT_WRAPPER = `#!/bin/sh
set -eu

if [ "\${1:-}" = "push" ]; then
  branch="$("$MINISAGO_REAL_GIT" branch --show-current)"
  [ "$branch" = "$MINISAGO_GIT_BRANCH" ] || {
    echo "MiniSago denied git push from an unprepared branch." >&2
    exit 77
  }
  for argument in "$@"; do
    case "$argument" in
      --force|--force-with-lease|-f|main|master|HEAD:main|HEAD:master)
        echo "MiniSago denied a protected or force push." >&2
        exit 77
        ;;
    esac
  done
fi

exec "$MINISAGO_REAL_GIT" "$@"
`;

function safeJobId(jobId: string) {
  if (!/^[a-z0-9._-]{1,128}$/iu.test(jobId)) {
    throw new Error("Developer job ID is not filesystem-safe.");
  }
  return jobId;
}

function selectedRepository(job: OracleAnswerJob, repositories: string[]) {
  const repository = repositories.find(
    (candidate) =>
      candidate.toLocaleLowerCase("en-US") ===
      job.repository.toLocaleLowerCase("en-US"),
  );
  if (!repository) {
    throw new Error("The selected repository is not available on this worker.");
  }
  return repository;
}

type RunCommand = (
  command: string[],
  environment: Record<string, string>,
  signal?: AbortSignal,
) => Promise<void>;

async function run(
  command: string[],
  environment: Record<string, string>,
  signal?: AbortSignal,
) {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const stop = () => child.kill();
  signal?.addEventListener("abort", stop, { once: true });
  const [, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal?.removeEventListener("abort", stop);
  if (signal?.aborted) {
    throw new Error("Repository preparation was cancelled.");
  }
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim().split("\n").at(-1) ||
        `Repository preparation exited with status ${exitCode}.`,
    );
  }
}

export async function prepareDeveloperWorkspace(
  job: OracleAnswerJob,
  options: DeveloperWorkspaceOptions,
  runCommand: RunCommand = run,
): Promise<DeveloperWorkspace> {
  const repository = selectedRepository(job, options.githubRepositories);
  const deploySocketPath =
    options.deploySocketPath &&
    options.deploySocketRepository?.toLocaleLowerCase("en-US") ===
      repository.toLocaleLowerCase("en-US")
      ? options.deploySocketPath
      : undefined;
  const workspaceId = job.developerTask?.id ?? job.id;
  const jobRoot = resolve(options.githubWorktreeRoot, safeJobId(workspaceId));
  const directory = join(jobRoot, ...repository.split("/"));
  const binDirectory = join(jobRoot, "bin");
  const branch = `minisago/${safeJobId(workspaceId)}`;
  const preparationEnvironment = {
    GH_CONFIG_DIR: options.githubConfigDir,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const preservedTimer = preservedWorkspaceTimers.get(jobRoot);
  if (preservedTimer) {
    clearTimeout(preservedTimer);
    preservedWorkspaceTimers.delete(jobRoot);
  }

  const resume = Boolean(job.developerTask?.resumeSessionId);
  if (resume) {
    try {
      await access(directory);
      await access(binDirectory);
    } catch {
      throw new Error("The preserved coding workspace is unavailable.");
    }
  } else {
    await rm(jobRoot, { recursive: true, force: true });
    await mkdir(jobRoot, { recursive: true, mode: 0o700 });
  }
  try {
    if (!resume) {
      await runCommand(
        [
          "gh",
          "repo",
          "clone",
          repository,
          directory,
          "--",
          "--filter=blob:none",
        ],
        preparationEnvironment,
        options.signal,
      );
      await runCommand(
        ["git", "-C", directory, "switch", "-c", branch],
        preparationEnvironment,
        options.signal,
      );
      await mkdir(binDirectory, { mode: 0o700 });
      const ghWrapper = join(binDirectory, "gh");
      const gitWrapper = join(binDirectory, "git");
      await Promise.all([
        Bun.write(ghWrapper, GH_WRAPPER),
        Bun.write(gitWrapper, GIT_WRAPPER),
      ]);
      await Promise.all([chmod(ghWrapper, 0o700), chmod(gitWrapper, 0o700)]);
    }
  } catch (error) {
    if (!resume) await rm(jobRoot, { recursive: true, force: true });
    throw error;
  }

  const environment = {
    ...preparationEnvironment,
    MINISAGO_GIT_BRANCH: branch,
    MINISAGO_REAL_GH: Bun.which("gh") || "/usr/bin/gh",
    MINISAGO_REAL_GIT: Bun.which("git") || "/usr/bin/git",
    PATH: `${binDirectory}:${process.env.PATH || "/usr/bin:/bin"}`,
    ...(deploySocketPath
      ? {
          MINISAGO_DEPLOY_SOCKET: deploySocketPath,
          MINISAGO_DISCORD_CHANNEL_ID: job.channelId,
        }
      : {}),
  };

  return {
    directory,
    environment,
    sandboxReadPaths: [binDirectory, resolve(options.githubConfigDir)],
    sandboxWritePaths: [
      resolve(directory, ".git"),
      ...(deploySocketPath ? [deploySocketPath] : []),
    ],
    cleanup: job.developerTask
      ? () => {
          preserveThenRemove(jobRoot);
          return Promise.resolve();
        }
      : () => rm(jobRoot, { recursive: true, force: true }),
  };
}
