const handlers = [
  require("./ready"),
  require("./messageCreate"),
  require("./messageUpdate"),
  require("./messageDelete"),
  require("./messageBulkDelete"),
  require("./error"),
];

// Errors are logged instead of becoming unhandled rejections,
// which would crash the process.
async function runHandler(handler, args) {
  try {
    await handler.execute(...args);
  } catch (error) {
    console.error(`Error in ${handler.event} handler:`, error);
  }
}

function registerHandlers(client) {
  for (const handler of handlers) {
    const register = handler.once ? "once" : "on";
    client[register](handler.event, (...args) => runHandler(handler, args));
  }
}

module.exports = { registerHandlers };
