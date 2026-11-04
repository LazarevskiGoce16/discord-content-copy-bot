const config = require("../config.json");

const validModes = ["migration", "synchronization"];

if (!validModes.includes(config.mode)) {
  throw new Error(
    `Invalid mode "${config.mode}". Use "migration" or "synchronization".`
  );
}

if (!config.channelMap || Object.keys(config.channelMap).length === 0) {
  throw new Error("channelMap must contain at least one channel mapping.");
}

if (
  config.mode === "synchronization" &&
  config.history?.enabled === false &&
  config.liveSync?.enabled !== true
) {
  throw new Error(
    "Synchronization mode requires history or live synchronization to be enabled."
  );
}

function historyEnabled() {
  return config.history?.enabled !== false;
}

function liveSyncEnabled() {
  return config.mode === "synchronization"
    && config.liveSync?.enabled === true;
}

function syncEditsEnabled() {
  return liveSyncEnabled() && config.liveSync?.syncEdits === true;
}

function syncDeletionsEnabled() {
  return liveSyncEnabled() && config.liveSync?.syncDeletions === true;
}

function getDestinationId(sourceChannelId) {
  return config.channelMap[sourceChannelId];
}

module.exports = {
  config,
  historyEnabled,
  liveSyncEnabled,
  syncEditsEnabled,
  syncDeletionsEnabled,
  getDestinationId,
};
