const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Events } = require("discord.js");

require("./helpers");
const { registerHandlers } = require("../src/handlers");

test("registers every event, ready only once", () => {
  const registered = [];
  registerHandlers({
    on: (event) => registered.push(["on", event]),
    once: (event) => registered.push(["once", event]),
  });

  assert.deepEqual(registered, [
    ["once", Events.ClientReady],
    ["on", Events.MessageCreate],
    ["on", Events.MessageUpdate],
    ["on", Events.MessageDelete],
    ["on", Events.MessageBulkDelete],
    ["on", Events.Error],
  ]);
});

test("a throwing handler is logged, not left as an unhandled rejection", async () => {
  const errors = mock.method(console, "error", () => {});

  const emitter = new EventEmitter();
  registerHandlers(emitter);

  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);

  // A null message makes the update handler throw a TypeError.
  emitter.emit(Events.MessageUpdate, null, null);
  await new Promise((resolve) => setImmediate(resolve));

  process.off("unhandledRejection", onUnhandled);
  mock.restoreAll();

  assert.deepEqual(unhandled, []);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /messageUpdate/);
});
