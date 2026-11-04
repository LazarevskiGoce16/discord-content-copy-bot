const { Events } = require("discord.js");

const db = require("../db");
const {
  config,
  historyEnabled,
  liveSyncEnabled,
} = require("../config");
const { syncHistory } = require("../services/history");

function shutdown(client, exitCode) {
  db.close();
  client.destroy();
  process.exitCode = exitCode;
}

module.exports = {
  event: Events.ClientReady,
  once: true,

  async execute(readyClient) {
    console.log(`Logged in as ${readyClient.user.tag}`);
    console.log(`Selected mode: ${config.mode}`);

    const failedChannels = [];

    try {
      // Step 1: Copy historical messages if enabled.
      if (historyEnabled()) {
        console.log("Starting historical migration...");

        for (const [sourceId, destinationId] of
          Object.entries(config.channelMap)) {
          console.log(
            `Migrating ${sourceId} -> ${destinationId}`
          );

          const success = await syncHistory(sourceId, destinationId);

          if (!success) failedChannels.push(sourceId);
        }

        if (failedChannels.length) {
          console.error(
            `Historical migration incomplete for: ${failedChannels.join(", ")}. ` +
            "Restart the bot to resume from the last checkpoint."
          );
        } else {
          console.log("Historical migration completed.");
        }
      } else {
        console.log("Historical migration is disabled.");
      }

      // Step 2: Decide whether the bot should remain online.
      if (liveSyncEnabled()) {
        console.log("Live synchronization is enabled.");
        console.log("The bot will remain online.");
        return;
      }

      console.log("No live synchronization requested.");
      console.log("Shutting down the bot.");

      shutdown(readyClient, failedChannels.length ? 1 : 0);
    } catch (error) {
      console.error("Migration failed:", error);
      console.error(
        "Fix the problem and restart the bot to retry."
      );

      shutdown(readyClient, 1);
    }
  },
};
