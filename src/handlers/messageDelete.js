const { Events } = require("discord.js");

const { syncDeletionsEnabled, getDestinationId } = require("../config");
const { deleteCopiedMessages } = require("../services/sync");

module.exports = {
  event: Events.MessageDelete,

  async execute(message) {
    if (!syncDeletionsEnabled()) return;
    if (!getDestinationId(message.channelId)) return;

    await deleteCopiedMessages(message);
  },
};
