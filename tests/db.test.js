const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

// Creates a database in the format used before the `removed` column,
// then loads src/db.js on it, as an upgraded bot would.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-bot-db-"));
const file = path.join(dir, "old.sqlite");

const old = new Database(file);
old.exec(`
  CREATE TABLE copied_messages (
    source_message_id TEXT NOT NULL,
    source_channel_id TEXT NOT NULL,
    destination_channel_id TEXT NOT NULL,
    destination_message_id TEXT NOT NULL,
    copied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source_message_id, destination_channel_id)
  );
  INSERT INTO copied_messages
    (source_message_id, source_channel_id, destination_channel_id, destination_message_id)
  VALUES ('m1', 'src', 'dst', 'copy-1');
`);
old.close();

process.env.DATABASE_PATH = file;
const db = require("../src/db");

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an old database is upgraded and keeps its records", () => {
  assert.equal(db.isCopied("m1", "dst"), true);
  assert.deepEqual(db.getCopies("m1"), [
    { destination_channel_id: "dst", destination_message_id: "copy-1" },
  ]);
});

test("removed copies count as copied but are not returned", () => {
  db.markRemoved("m1", "dst");

  assert.equal(db.isCopied("m1", "dst"), true);
  assert.deepEqual(db.getCopies("m1"), []);
});
