const { Events } = require("discord.js");

const { syncDeletionsEnabled, getDestinationId } = require("../config");
const { deleteCopiedMessages } = require("../services/sync");

module.exports = {
  event: Events.MessageBulkDelete,

  async execute(messages, channel) {
    if (!syncDeletionsEnabled()) return;
    if (!getDestinationId(channel.id)) return;

    for (const message of messages.values()) {
      await deleteCopiedMessages(message);
    }
  },
};
