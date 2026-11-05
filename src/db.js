const Database = require("better-sqlite3");

// DATABASE_PATH lets tests use ":memory:" instead of the real database.
const db = new Database(process.env.DATABASE_PATH ?? "transfer.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS copied_messages (
    source_message_id TEXT NOT NULL,
    source_channel_id TEXT NOT NULL,
    destination_channel_id TEXT NOT NULL,
    destination_message_id TEXT NOT NULL,
    copied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source_message_id, destination_channel_id)
  );
  CREATE TABLE IF NOT EXISTS sync_checkpoints (
    source_channel_id TEXT NOT NULL,
    destination_channel_id TEXT NOT NULL,
    last_message_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source_channel_id, destination_channel_id)
  );
`);

// Databases created before the `removed` column existed get it added.
const hasRemovedColumn = db.prepare("PRAGMA table_info(copied_messages)")
  .all()
  .some((column) => column.name === "removed");

if (!hasRemovedColumn) {
  db.exec(`
    ALTER TABLE copied_messages
    ADD COLUMN removed INTEGER NOT NULL DEFAULT 0
  `);
}

// Includes removed copies, so they are never sent again.
const isCopiedStmt = db.prepare(`
  SELECT 1 FROM copied_messages
  WHERE source_message_id = ?
    AND destination_channel_id = ?
`);

const saveCopiedStmt = db.prepare(`
  INSERT OR IGNORE INTO copied_messages (
    source_message_id,
    source_channel_id,
    destination_channel_id,
    destination_message_id
  )
  VALUES (?, ?, ?, ?)
`);

const getCopiesStmt = db.prepare(`
  SELECT destination_channel_id, destination_message_id
  FROM copied_messages
  WHERE source_message_id = ?
    AND removed = 0
`);

const markRemovedStmt = db.prepare(`
  UPDATE copied_messages
  SET removed = 1
  WHERE source_message_id = ?
    AND destination_channel_id = ?
`);

const deleteCopiedStmt = db.prepare(`
  DELETE FROM copied_messages
  WHERE source_message_id = ?
    AND destination_channel_id = ?
`);

const getCheckpointStmt = db.prepare(`
  SELECT last_message_id
  FROM sync_checkpoints
  WHERE source_channel_id = ?
    AND destination_channel_id = ?
`);

const saveCheckpointStmt = db.prepare(`
  INSERT INTO sync_checkpoints (
    source_channel_id,
    destination_channel_id,
    last_message_id,
    updated_at
  )
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(source_channel_id, destination_channel_id)
  DO UPDATE SET
    last_message_id = excluded.last_message_id,
    updated_at = CURRENT_TIMESTAMP
`);

module.exports = {
  isCopied(sourceMessageId, destinationChannelId) {
    return Boolean(isCopiedStmt.get(sourceMessageId, destinationChannelId));
  },

  saveCopied(sourceMessageId, sourceChannelId,
    destinationChannelId, destinationMessageId) {
    saveCopiedStmt.run(
      sourceMessageId,
      sourceChannelId,
      destinationChannelId,
      destinationMessageId
    );
  },

  getCopies(sourceMessageId) {
    return getCopiesStmt.all(sourceMessageId);
  },

  deleteCopied(sourceMessageId, destinationChannelId) {
    deleteCopiedStmt.run(sourceMessageId, destinationChannelId);
  },

  // For copies deleted by hand: keeps the record so the message is not
  // copied again, but stops edits and deletions from acting on it.
  markRemoved(sourceMessageId, destinationChannelId) {
    markRemovedStmt.run(sourceMessageId, destinationChannelId);
  },

  getCheckpoint(sourceChannelId, destinationChannelId) {
    return getCheckpointStmt.get(sourceChannelId, destinationChannelId)
      ?.last_message_id ?? null;
  },

  saveCheckpoint(sourceChannelId, destinationChannelId, messageId) {
    saveCheckpointStmt.run(sourceChannelId, destinationChannelId, messageId);
  },

  close() {
    db.close();
  },
};
