const { Events } = require("discord.js");

const { liveSyncEnabled, getDestinationId } = require("../config");
const { copyMessage } = require("../services/copy");

module.exports = {
  event: Events.MessageCreate,

  async execute(message) {
    if (!liveSyncEnabled()) return;

    const destinationId = getDestinationId(message.channelId);

    if (!destinationId) return;

    await copyMessage(message, destinationId);
  },
};
