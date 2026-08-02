# Security

MiniSago treats the hosted Discord service as the authority boundary and Codex
workers as constrained executors. Model output never grants its own
permissions.

## Capability boundary

| Capability                                 | Community | Owner                    |
| ------------------------------------------ | --------- | ------------------------ |
| Conversation and public web research       | Yes       | Yes                      |
| Permission-filtered Discord context        | Yes       | Yes                      |
| Host-bound reminders and voice actions     | Yes       | Yes                      |
| Cross-channel messaging and emoji creation | No        | Yes                      |
| Repository checkout and developer commands | No        | Yes                      |
| GitHub mutation                            | No        | Owner-routed tasks only  |
| Mac file search and upload                 | No        | Explicit Mac target only |

The hosted service checks requester identity before dispatch. The worker checks
the declared capabilities again before Codex runs. Authorization never depends
on matching phrases in the request.

## Discord boundaries

Chatbot access uses an owner ID, allowed guilds, and optional channel
exceptions. Ambient reactions use the same community boundary. Guild searches
include only channels where the requester has View Channel and Read Message
History; if role data cannot be loaded, search falls back to the current
channel.

Member roles, join dates, presence, and reaction-member lists are not sent to
Codex. Host-bound tools cannot use model arguments to substitute another
requester, guild, member, or channel.

The owner may copy an emoji between shared guilds or create one from an image
attached directly to the request or its replied-to message. The destination bot
role must have Create Expressions. Community users never receive this tool.

## Worker authentication and isolation

Oracle and Mac use independent random bridge secrets of at least 32 bytes. The
secret selects a fixed server-owned profile; workers cannot raise their own
capabilities or priority.

Every Codex run is ephemeral and ignores normal user configuration, memories,
skills, plugins, and user-configured MCP servers. Chat jobs have restricted
filesystem access and no general network permission outside Codex's own web
search and MiniSago's MCP server.

The Linux worker uses Codex's Bubblewrap sandbox inside the container.
Production allows only its required namespace and mount syscalls and loads the
dedicated AppArmor profile. The worker process remains unprivileged.

## Attachments and Mac files

Only answer jobs download attachments. Supported formats are images, PDFs, and
text files, with these limits:

- at most 10 attachments;
- at most 20 MB per attachment and 40 MB total; and
- at most 100,000 extracted characters per file and 200,000 total.

Downloads accept only Discord HTTPS CDN hosts, stop on cancellation, and are
deleted after the response. Attachment URLs are stripped from observable tool
results and sanitized in traces.

Mac file requests are owner-only and read-only. Search is limited to configured
roots, and the host revalidates the exact path before uploading at most one
regular file of 8 MB or less. Symlinks and paths outside the roots are rejected.

## Owner development and GitHub

Development jobs receive one selected disposable repository checkout. GitHub
uses a dedicated persistent `gh` login with a fine-grained credential limited
to the configured repository allowlist. Tokens must never be placed in Discord,
tasks, environment files, shell arguments, or repository content.

The owner router assigns `issue`, `code`, or `deploy` from the requested task.
Implementation requests receive `code` scope without requiring the owner to
separately request each implementation mechanic, push, or draft pull request.
Per-job `gh` and `git` wrappers enforce that scope:

- read-only jobs cannot mutate GitHub;
- issue jobs can perform only bounded issue operations;
- code jobs may use a prepared feature branch, push it, and open a draft PR;
- merge, ready, review, protected-branch, and force-push operations are denied.

GitHub rulesets must independently block direct and force pushes to protected
branches. The credential should have repository contents, issues, and pull
request access plus read access to checks and Actions when needed; never grant
administration, secrets, environments, deployments, organization, or unrelated
repository access. Credential and ruleset setup is tracked in
[issue #12](https://github.com/Hsiii/mini-sago/issues/12).

## Retention and privacy

Metadata-only worker logs exclude prompts, Discord messages, answers, links,
and attachment contents. Debug traces may contain message context, sanitized
attachment metadata, bounded MCP tool names and arguments, model output,
errors, and timings. They never contain MCP tokens, signed URL parameters,
tool-result message bodies, or downloaded attachment bodies.

Traces are owner-readable, expire after 14 days, and are pruned oldest-first
above 250 MB. The `get_previous_trace` tool exposes bounded operational metadata
from the same channel, never private chain-of-thought.
