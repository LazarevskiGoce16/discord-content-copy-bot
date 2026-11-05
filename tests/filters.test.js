const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { setConfig, attachment, makeMessage } = require("./helpers");
const { shouldCopyMessage } = require("../src/utils/filters");

beforeEach(() => setConfig());

test("plain text is skipped", () => {
  assert.equal(shouldCopyMessage(makeMessage({ content: "hello" })), false);
});

test("text with a URL is copied", () => {
  assert.equal(
    shouldCopyMessage(makeMessage({ content: "see https://x.test" })),
    true
  );
});

test("embed-only link is copied", () => {
  const message = makeMessage({ embeds: [{ url: "https://x.test" }] });
  assert.equal(shouldCopyMessage(message), true);
});

test("links are ignored when filters.links is false", () => {
  setConfig({ filters: { links: false } });
  assert.equal(
    shouldCopyMessage(makeMessage({ content: "https://x.test" })),
    false
  );
});

test("links are ignored when copyLinks is false", () => {
  setConfig({ copyLinks: false });
  const message = makeMessage({
    content: "https://x.test",
    embeds: [{ url: "https://y.test" }],
  });
  assert.equal(shouldCopyMessage(message), false);
});

test("each attachment type follows its filter", () => {
  const cases = [
    ["images", attachment("a.png", "image/png")],
    ["videos", attachment("b.mp4", "video/mp4")],
    ["otherFiles", attachment("c.zip", "application/zip")],
  ];

  for (const [filter, file] of cases) {
    setConfig();
    assert.equal(
      shouldCopyMessage(makeMessage({ attachments: [file] })),
      true,
      `${filter} on`
    );

    setConfig({ filters: { [filter]: false } });
    assert.equal(
      shouldCopyMessage(makeMessage({ attachments: [file] })),
      false,
      `${filter} off`
    );
  }
});

test("type falls back to the file extension", () => {
  setConfig({ filters: { images: false } });
  const message = makeMessage({ attachments: [attachment("a.JPG", null)] });
  assert.equal(shouldCopyMessage(message), false);
});

test("copyAttachments false overrides the type filters", () => {
  setConfig({ copyAttachments: false });
  const message = makeMessage({
    attachments: [attachment("a.png", "image/png")],
  });
  assert.equal(shouldCopyMessage(message), false);
});

test("one allowed attachment is enough", () => {
  setConfig({ filters: { videos: false } });
  const message = makeMessage({
    attachments: [
      attachment("b.mp4", "video/mp4"),
      attachment("a.png", "image/png"),
    ],
  });
  assert.equal(shouldCopyMessage(message), true);
});
