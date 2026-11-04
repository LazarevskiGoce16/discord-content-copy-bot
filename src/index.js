require("dotenv").config();

// Loading config validates it before anything connects.
require("./config");

if (!process.env.DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is missing from .env");
}

const client = require("./client");
const { registerHandlers } = require("./handlers");

registerHandlers(client);

client.login(process.env.DISCORD_TOKEN);
