const { Events } = require("discord.js");

const { syncEditsEnabled, getDestinationId } = require("../config");
const { updateCopiedMessage } = require("../services/sync");

module.exports = {
  event: Events.MessageUpdate,

  async execute(oldMessage, newMessage) {
    if (!syncEditsEnabled()) return;
    if (!getDestinationId(newMessage.channelId)) return;

    await updateCopiedMessage(newMessage);
  },
};
