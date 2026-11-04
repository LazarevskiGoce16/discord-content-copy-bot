const { Events } = require("discord.js");

module.exports = {
  event: Events.Error,

  execute(error) {
    console.error("Discord client error:", error);
  },
};
