const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const {
  setConfig,
  makeMessage,
  makeDestination,
  makeSource,
  useChannels,
} = require("./helpers");
const db = require("../src/db");
const { syncHistory } = require("../src/services/history");

// IDs 1..250 cross several 100-message pages.
const history = Array.from({ length: 250 }, (_, i) => makeMessage({
  id: String(i + 1),
  content: `https://x.test/${i + 1}`,
}));

const sentUrls = (destination) => [...destination.messages.store.values()]
  .map((message) => message.content.split("\n").pop());

afterEach(() => mock.restoreAll());

beforeEach(() => {
  setConfig();
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});

test("interrupted history resumes from the checkpoint", async () => {
  let failing = true;
  const destination = makeDestination({
    failSend: (payload) => failing && payload.content.endsWith("/120")
      ? new TypeError("network down")
      : null,
  });
  useChannels({ source: makeSource(history), destination });

  assert.equal(await syncHistory("source", "destination"), false);
  assert.equal(destination.messages.store.size, 119);
  assert.equal(db.getCheckpoint("source", "destination"), "119");

  failing = false;
  assert.equal(await syncHistory("source", "destination"), true);

  const expected = history.map((message) => message.content);
  assert.deepEqual(sentUrls(destination), expected, "oldest first, no duplicates");
  assert.equal(db.getCheckpoint("source", "destination"), "250");

  // A rerun with nothing new sends nothing.
  assert.equal(await syncHistory("source", "destination"), true);
  assert.equal(destination.messages.store.size, 250);

  // Checkpoints belong to a source and destination pair.
  assert.equal(db.getCheckpoint("source", "another-destination"), null);
});

test("skipped messages still advance the checkpoint", async () => {
  const messages = [
    makeMessage({ id: "1001", content: "https://x.test" }),
    makeMessage({ id: "1002", content: "plain text" }),
  ];
  const destination = makeDestination();
  useChannels({ source: makeSource(messages), "pair-c": destination });

  assert.equal(await syncHistory("source", "pair-c"), true);
  assert.equal(db.getCheckpoint("source", "pair-c"), "1002");
  assert.equal(destination.messages.store.size, 1);
});

test("missing Read Message History fails instead of looking empty", async () => {
  const destination = makeDestination();
  useChannels({
    source: makeSource(history, { permissions: ["ViewChannel"] }),
    "pair-e": destination,
  });

  assert.equal(await syncHistory("source", "pair-e"), false);
  assert.equal(db.getCheckpoint("source", "pair-e"), null);
});

test("an inaccessible source channel fails without throwing", async () => {
  useChannels({ destination: makeDestination() });
  assert.equal(await syncHistory("missing", "destination"), false);
});

test("a fetch error while paging fails without throwing", async () => {
  const source = makeSource(history);
  source.messages.fetch = async () => {
    throw new TypeError("network down");
  };
  useChannels({ source, "pair-d": makeDestination() });

  assert.equal(await syncHistory("source", "pair-d"), false);
});
