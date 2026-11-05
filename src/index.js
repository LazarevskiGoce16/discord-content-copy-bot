require("dotenv").config();

// Loading config validates it before anything connects.
require("./config");

if (!process.env.DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is missing from .env");
}

const client = require("./client");
const { registerHandlers } = require("./handlers");

registerHandlers(client);

const loginHints = {
  "Used disallowed intents":
    "Enable Message Content Intent for the bot in the Discord Developer Portal.",
  TokenInvalid:
    "DISCORD_TOKEN in .env is not a valid bot token.",
};

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  const hint = loginHints[error.code] ?? loginHints[error.message];

  console.error("Could not log in to Discord:", error.message);
  if (hint) console.error(hint);

  client.destroy();
  process.exitCode = 1;
});
