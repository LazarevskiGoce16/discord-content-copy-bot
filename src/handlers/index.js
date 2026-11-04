const handlers = [
  require("./ready"),
  require("./messageCreate"),
  require("./messageUpdate"),
  require("./messageDelete"),
  require("./messageBulkDelete"),
  require("./error"),
];

function registerHandlers(client) {
  for (const handler of handlers) {
    const register = handler.once ? "once" : "on";
    client[register](handler.event, (...args) => handler.execute(...args));
  }
}

module.exports = { registerHandlers };
