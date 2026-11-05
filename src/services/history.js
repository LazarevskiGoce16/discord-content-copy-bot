const client = require("../client");
const db = require("../db");
const { copyMessage } = require("./copy");

const compareIds = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1;

// Copies messages oldest-first, advancing the checkpoint after each one.
// Returns the number processed, or null if a copy failed.
async function copyInOrder(messages, sourceId, destinationId) {
  let processed = 0;

  for (const message of [...messages].sort(compareIds)) {
    const success = await copyMessage(message, destinationId);

    if (!success) {
      console.error(
        `Stopping history sync at ${message.id}. It will be retried next time.`
      );
      return null;
    }

    db.saveCheckpoint(sourceId, destinationId, message.id);
    processed++;
  }

  return processed;
}

// Recover messages posted after the previous checkpoint.
async function copyAfterCheckpoint(source, destinationId, checkpoint) {
  let lastMessageId = checkpoint;
  let processedCount = 0;

  while (true) {
    const messages = await source.messages.fetch({
      after: lastMessageId,
      limit: 100,
    });

    if (messages.size === 0) break;

    const processed = await copyInOrder(
      messages.values(), source.id, destinationId
    );

    if (processed === null) return null;

    processedCount += processed;
    lastMessageId = db.getCheckpoint(source.id, destinationId);
  }

  return processedCount;
}

// No checkpoint exists: perform the initial full-history scan.
async function copyFullHistory(source, destinationId) {
  let before = null;
  const allMessages = [];

  while (true) {
    const options = { limit: 100 };

    if (before) {
      options.before = before;
    }

    const messages = await source.messages.fetch(options);

    if (messages.size === 0) break;

    allMessages.push(...messages.values());

    before = messages.last().id;

    if (messages.size < 100) break;
  }

  return copyInOrder(allMessages, source.id, destinationId);
}

// Returns true when the channel's history is fully copied. Errors are
// contained here so one broken channel does not stop the others.
async function syncHistory(sourceId, destinationId) {
  try {
    return await syncChannelHistory(sourceId, destinationId);
  } catch (error) {
    console.error(`History sync failed for ${sourceId}:`, error);
    return false;
  }
}

async function syncChannelHistory(sourceId, destinationId) {
  const source = await client.channels.fetch(sourceId);

  if (!source || !source.isTextBased() || !source.messages) {
    console.error(`Invalid source channel: ${sourceId}`);
    return false;
  }

  const checkpoint = db.getCheckpoint(sourceId, destinationId);

  console.log(
    checkpoint
      ? `Recovering messages after ${checkpoint} in ${sourceId}`
      : `Starting initial history scan for ${sourceId}`
  );

  const processedCount = checkpoint
    ? await copyAfterCheckpoint(source, destinationId, checkpoint)
    : await copyFullHistory(source, destinationId);

  if (processedCount === null) return false;

  console.log(
    `Finished history sync for ${sourceId}. Processed ${processedCount} messages.`
  );

  return true;
}

module.exports = { syncHistory };
