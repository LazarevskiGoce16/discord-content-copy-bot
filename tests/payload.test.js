const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const { setConfig, attachment, makeMessage } = require("./helpers");
const { buildMessagePayload, truncate } = require("../src/utils/payload");

const ok = () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new ArrayBuffer(4),
});
const status = (code) => ({ ok: false, status: code });

afterEach(() => mock.restoreAll());

beforeEach(() => {
  setConfig();
  mock.method(global, "fetch", async () => ok());
});

const fileNames = (payload) => payload.files.map((file) => file.name);

test("adds attribution and disables mentions", async () => {
  const payload = await buildMessagePayload(
    makeMessage({ content: "https://x.test", createdTimestamp: 0 })
  );

  assert.match(payload.content, /^\*\*author \(copied\)\*\*\n/);
  assert.match(payload.content, /1970-01-01T00:00:00.000Z/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("filtered attachments are dropped, not linked", async () => {
  setConfig({ filters: { videos: false } });

  const payload = await buildMessagePayload(makeMessage({
    attachments: [
      attachment("a.png", "image/png"),
      attachment("b.mp4", "video/mp4"),
    ],
  }));

  assert.deepEqual(fileNames(payload), ["a.png"]);
  assert.ok(!payload.content.includes("b.mp4"));
});

test("copyAttachments false sends no files or attachment links", async () => {
  setConfig({ copyAttachments: false });

  const payload = await buildMessagePayload(makeMessage({
    content: "https://x.test",
    attachments: [attachment("a.png", "image/png")],
  }));

  assert.equal(payload.files.length, 0);
  assert.ok(!payload.content.includes("cdn.test"));
});

test("embed URLs are appended once, and only when links are on", async () => {
  const message = makeMessage({
    content: "hi",
    embeds: [{ url: "https://embed.test" }, { url: null }],
  });

  const withLinks = await buildMessagePayload(message);
  assert.equal(withLinks.content.split("https://embed.test").length - 1, 1);

  setConfig({ filters: { links: false } });
  const withoutLinks = await buildMessagePayload(message);
  assert.ok(!withoutLinks.content.includes("embed.test"));
});

test("embed URLs that Discord normalized are not duplicated", async () => {
  // Discord stores "https://google.mk" as "https://google.mk/" in embeds.
  const payload = await buildMessagePayload(makeMessage({
    content: "https://google.mk\nhttps://github.com",
    embeds: [
      { url: "https://google.mk/" },
      { url: "https://github.com/" },
      { url: "https://other.test/" },
    ],
  }));

  assert.match(payload.content, /https:\/\/google\.mk\nhttps:\/\/github\.com\nhttps:\/\/other\.test\/$/);
});

test("oversized attachment falls back to its URL", async () => {
  const big = { ...attachment("big.mp4", "video/mp4"), size: 50 * 1024 * 1024 };
  const payload = await buildMessagePayload(makeMessage({ attachments: [big] }));

  assert.equal(payload.files.length, 0);
  assert.match(payload.content, /Original attachment links:\nhttps:\/\/cdn.test\/big.mp4/);
  assert.equal(global.fetch.mock.callCount(), 0);
});

test("download retries server errors, then succeeds", async () => {
  const responses = [status(503), ok()];
  global.fetch.mock.mockImplementation(async () => responses.shift());

  const payload = await buildMessagePayload(makeMessage({
    attachments: [attachment("a.png", "image/png")],
  }));

  assert.deepEqual(fileNames(payload), ["a.png"]);
  assert.equal(global.fetch.mock.callCount(), 2);
});

test("download does not retry a 404", async () => {
  global.fetch.mock.mockImplementation(async () => status(404));

  const payload = await buildMessagePayload(makeMessage({
    attachments: [attachment("a.png", "image/png")],
  }));

  assert.equal(payload.files.length, 0);
  assert.match(payload.content, /cdn.test\/a.png/);
  assert.equal(global.fetch.mock.callCount(), 1);
});

test("download gives up after three network errors", async () => {
  global.fetch.mock.mockImplementation(async () => {
    throw new TypeError("fetch failed");
  });

  const payload = await buildMessagePayload(makeMessage({
    attachments: [attachment("a.png", "image/png")],
  }));

  assert.equal(payload.files.length, 0);
  assert.match(payload.content, /cdn.test\/a.png/);
  assert.equal(global.fetch.mock.callCount(), 3);
});

test("long content is truncated to 2000 characters", async () => {
  const payload = await buildMessagePayload(
    makeMessage({ content: "https://x.test " + "a".repeat(3000) })
  );

  assert.equal(payload.content.length, 2000);
  assert.ok(payload.content.endsWith("..."));
  assert.equal(truncate("short"), "short");
});
