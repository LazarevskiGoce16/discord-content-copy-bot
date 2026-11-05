const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const {
  setConfig,
  apiError,
  attachment,
  makeMessage,
  makeDestination,
  useChannels,
} = require("./helpers");
const db = require("../src/db");
const { copyMessage } = require("../src/services/copy");

const link = () => makeMessage({ content: "https://x.test" });

afterEach(() => mock.restoreAll());

beforeEach(() => {
  setConfig();
  mock.method(global, "fetch", async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(4),
  }));
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});

test("copies an eligible message and records it", async () => {
  const destination = makeDestination();
  useChannels({ destination });
  const message = link();

  assert.equal(await copyMessage(message, "destination"), true);
  assert.equal(destination.messages.store.size, 1);
  assert.equal(db.isCopied(message.id, "destination"), true);
});

test("skips bots and ineligible messages without sending", async () => {
  const destination = makeDestination();
  useChannels({ destination });

  const bot = makeMessage({ content: "https://x.test", bot: true });
  assert.equal(await copyMessage(bot, "destination"), true);
  assert.equal(await copyMessage(makeMessage({ content: "hi" }), "destination"), true);
  assert.equal(destination.messages.store.size, 0);
});

test("never sends the same message twice", async () => {
  const destination = makeDestination();
  useChannels({ destination });
  const message = link();

  // Concurrent callers share one send; a later call sees the record.
  const results = await Promise.all([
    copyMessage(message, "destination"),
    copyMessage(message, "destination"),
  ]);
  await copyMessage(message, "destination");

  assert.deepEqual(results, [true, true]);
  assert.equal(destination.messages.store.size, 1);
});

test("concurrent caller sees a failure instead of success", async () => {
  const destination = makeDestination({
    failSend: () => new TypeError("network down"),
  });
  useChannels({ destination });
  const message = link();

  const results = await Promise.all([
    copyMessage(message, "destination"),
    copyMessage(message, "destination"),
  ]);

  assert.deepEqual(results, [false, false]);
  assert.equal(db.isCopied(message.id, "destination"), false);
});

test("permanent Discord rejections are skipped", async () => {
  useChannels({
    destination: makeDestination({
      failSend: () => apiError(413, 40005, "Request entity too large"),
    }),
  });

  assert.equal(await copyMessage(link(), "destination"), true);
});

test("temporary failures ask for a retry", async () => {
  useChannels({
    destination: makeDestination({
      failSend: () => apiError(403, 50013, "Missing Permissions"),
    }),
  });

  assert.equal(await copyMessage(link(), "destination"), false);
});

test("inaccessible destination channel asks for a retry", async () => {
  useChannels({});
  assert.equal(await copyMessage(link(), "missing"), false);
});

test("missing Send Messages asks for a retry", async () => {
  const destination = makeDestination({ permissions: ["ViewChannel"] });
  useChannels({ destination });

  assert.equal(await copyMessage(link(), "destination"), false);
  assert.equal(destination.messages.store.size, 0);
});

test("missing Attach Files only matters when there are files", async () => {
  const destination = makeDestination({
    permissions: ["ViewChannel", "SendMessages"],
  });
  useChannels({ destination });

  const withFile = makeMessage({
    attachments: [attachment("a.png", "image/png")],
  });

  assert.equal(await copyMessage(withFile, "destination"), false);
  assert.equal(await copyMessage(link(), "destination"), true);
  assert.equal(destination.messages.store.size, 1);
});
