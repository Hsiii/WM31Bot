import { getPublicDiscordSummary } from "@/lib/discord/env";

const exampleCommand = "npm run register:commands";

export default function Home() {
  const summary = getPublicDiscordSummary();

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Discord Self-Assign Roles</p>
        <h1>Serverless bot flow built for Vercel.</h1>
        <p className="lede">
          This project uses Discord interactions instead of a long-running gateway
          connection, so it deploys cleanly on Vercel and still lets members add
          or remove Wordle channel access from simple slash commands.
        </p>
        <div className="panel-grid">
          <article className="panel accent">
            <span className="panel-label">Endpoint</span>
            <strong>/api/interactions</strong>
            <p>Configure this as the Discord Interactions Endpoint URL.</p>
          </article>
          <article className="panel">
            <span className="panel-label">Command</span>
            <strong>/join-wordle-channel</strong>
            <p>Use `/leave-wordle-channel` to remove the same access role.</p>
          </article>
        </div>
      </section>

      <section className="content-grid">
        <article className="card">
          <h2>Configuration status</h2>
          <ul className="status-list">
            <li>
              <span>Application ID</span>
              <strong>{summary.hasApplicationId ? "set" : "missing"}</strong>
            </li>
            <li>
              <span>Public key</span>
              <strong>{summary.hasPublicKey ? "set" : "missing"}</strong>
            </li>
            <li>
              <span>Bot token</span>
              <strong>{summary.hasBotToken ? "set" : "missing"}</strong>
            </li>
            <li>
              <span>Guild ID</span>
              <strong>{summary.hasGuildId ? "set" : "optional"}</strong>
            </li>
            <li>
              <span>Managed roles</span>
              <strong>{summary.roleCount}</strong>
            </li>
          </ul>
        </article>

        <article className="card">
          <h2>Managed roles preview</h2>
          {summary.roles.length === 0 ? (
            <p>No roles configured yet.</p>
          ) : (
            <ul className="role-list">
              {summary.roles.map((role) => (
                <li key={role.id}>
                  <strong>{role.emoji ? `${role.emoji} ${role.label}` : role.label}</strong>
                  <span>{role.id}</span>
                  <p>{role.description || "No description"}</p>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="card wide">
          <h2>Quick start</h2>
          <ol className="steps-list">
            <li>Create a Discord application and bot.</li>
            <li>Invite the bot with Manage Roles permission.</li>
            <li>Move the bot role above the Wordle access role in the server hierarchy.</li>
            <li>Copy .env.example to .env.local and fill in your IDs and keys.</li>
            <li>Deploy to Vercel, then set the interactions endpoint to /api/interactions.</li>
            <li>Run <code>{exampleCommand}</code> to publish the Wordle slash commands.</li>
          </ol>
        </article>

        <article className="card wide code-card">
          <h2>Role JSON format</h2>
          <pre>{`[
  {
    "id": "123456789012345678",
    "label": "Announcements",
    "description": "Ping me for updates",
    "emoji": "📣"
  }
]`}</pre>
        </article>
      </section>
    </main>
  );
}
