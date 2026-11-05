const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const {
  setConfig,
  makeMessage,
  makeDestination,
  useChannels,
} = require("./helpers");
const db = require("../src/db");
const { copyMessage } = require("../src/services/copy");
const {
  updateCopiedMessage,
  deleteCopiedMessages,
} = require("../src/services/sync");

let destination;

afterEach(() => mock.restoreAll());

beforeEach(() => {
  setConfig();
  destination = makeDestination();
  useChannels({ destination });
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});

async function copied(content = "https://x.test") {
  const message = makeMessage({ content });
  await copyMessage(message, "destination");
  return message;
}

function edited(message, content) {
  return { ...message, content, editedTimestamp: Date.now() };
}

const onlyCopy = () => [...destination.messages.store.values()][0];

test("an edit updates the copy", async () => {
  const message = await copied();
  await updateCopiedMessage(edited(message, "https://y.test"));

  assert.match(onlyCopy().content, /y\.test$/);
});

test("link preview updates without an edit are ignored", async () => {
  const message = await copied();
  await updateCopiedMessage({
    ...message,
    embeds: [{ url: "https://x.test" }],
  });

  assert.equal(onlyCopy().edits, undefined);
});

test("rapid edits are all applied, in order", async () => {
  const message = await copied();

  await Promise.all([
    updateCopiedMessage(edited(message, "https://first.test")),
    updateCopiedMessage(edited(message, "https://second.test")),
  ]);

  assert.equal(onlyCopy().edits, 2);
  assert.match(onlyCopy().content, /second\.test$/);
});

test("an edit that removes the link deletes the copy", async () => {
  const message = await copied();
  await updateCopiedMessage(edited(message, "no link any more"));

  assert.equal(destination.messages.store.size, 0);
  assert.deepEqual(db.getCopies(message.id), []);
});

test("an edit that adds a link creates a copy", async () => {
  const message = makeMessage({ content: "plain text" });
  await copyMessage(message, "destination");
  assert.equal(destination.messages.store.size, 0);

  await updateCopiedMessage(edited(message, "now https://x.test"));
  assert.equal(destination.messages.store.size, 1);
});

test("without history, old messages are not copied on edit", async () => {
  setConfig({ history: { enabled: false } });
  const { client } = require("./helpers");
  client.readyTimestamp = Date.now();

  const old = makeMessage({ content: "plain", createdTimestamp: 0 });
  await updateCopiedMessage(edited(old, "now https://x.test"));

  assert.equal(destination.messages.store.size, 0);
  client.readyTimestamp = null;
});

test("editing a copy deleted by hand forgets it", async () => {
  const message = await copied();
  destination.messages.store.clear();

  await updateCopiedMessage(edited(message, "https://y.test"));
  assert.deepEqual(db.getCopies(message.id), []);
});

test("deleting the source deletes the copy", async () => {
  const message = await copied();
  await deleteCopiedMessages(message);

  assert.equal(destination.messages.store.size, 0);
  assert.deepEqual(db.getCopies(message.id), []);
});

test("a copy that is already gone is just forgotten", async () => {
  const message = await copied();
  destination.messages.store.clear();

  await deleteCopiedMessages(message);
  assert.deepEqual(db.getCopies(message.id), []);
});

test("deleting during an in-flight copy leaves no orphan", async () => {
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const originalSend = destination.send;
  destination.send = async (payload) => {
    await sendGate;
    return originalSend(payload);
  };

  const message = makeMessage({ content: "https://x.test" });
  const copying = copyMessage(message, "destination");
  const deleting = deleteCopiedMessages(message);

  releaseSend();
  await Promise.all([copying, deleting]);

  assert.equal(destination.messages.store.size, 0);
  assert.deepEqual(db.getCopies(message.id), []);
});

test("a failing update does not block later ones", async () => {
  const message = await copied();
  const copy = onlyCopy();
  const originalEdit = copy.edit;
  copy.edit = async () => { throw new TypeError("network down"); };

  await updateCopiedMessage(edited(message, "https://first.test"));

  copy.edit = originalEdit;
  await updateCopiedMessage(edited(message, "https://second.test"));
  assert.match(onlyCopy().content, /second\.test$/);
});
