const client = require("../client");
const db = require("../db");
const { shouldCopyMessage } = require("../utils/filters");
const { buildMessagePayload } = require("../utils/payload");
const { isUnknownMessageError } = require("../utils/errors");

// Keys of edits/deletions currently being propagated.
const inProgress = new Set();

async function withLock(key, task) {
  if (inProgress.has(key)) return;

  inProgress.add(key);

  try {
    await task();
  } finally {
    inProgress.delete(key);
  }
}

// Deletes one destination copy and forgets it. Returns true only when
// this call deleted it; a copy that was already gone is just forgotten.
async function removeCopy(sourceMessageId, copy) {
  try {
    const destination = await client.channels.fetch(
      copy.destination_channel_id
    );

    if (!destination || !destination.isTextBased()) {
      console.error(
        `Cannot access destination channel: ${copy.destination_channel_id}`
      );
      return false;
    }

    const destinationMessage = await destination.messages.fetch(
      copy.destination_message_id
    );

    await destinationMessage.delete();
    db.deleteCopied(sourceMessageId, copy.destination_channel_id);

    return true;
  } catch (error) {
    if (isUnknownMessageError(error)) {
      db.deleteCopied(sourceMessageId, copy.destination_channel_id);

      console.log(
        `Copy was already deleted: ${copy.destination_message_id}`
      );
      return false;
    }

    console.error(
      `Failed to delete copy ${copy.destination_message_id}:`,
      error
    );
    return false;
  }
}

async function updateCopiedMessage(message) {
  if (!message) return;

  // Fetch the complete message if Discord only supplied a partial.
  if (message.partial) {
    try {
      message = await message.fetch();
    } catch (error) {
      console.error("Could not fetch updated message:", error);
      return;
    }
  }

  if (!message.author || message.author.bot) return;

  const copies = db.getCopies(message.id);

  if (copies.length === 0) return;

  await withLock(`${message.id}:update`, async () => {
    // If the edit makes the message ineligible,
    // remove its existing destination copies.
    if (!shouldCopyMessage(message)) {
      for (const copy of copies) {
        if (await removeCopy(message.id, copy)) {
          console.log(
            `Removed copy ${copy.destination_message_id} ` +
            `because source message ${message.id} is no longer eligible.`
          );
        }
      }

      return;
    }

    const payload = await buildMessagePayload(message);

    if (!payload) return;

    // Update every destination copy independently.
    for (const copy of copies) {
      try {
        const destination = await client.channels.fetch(
          copy.destination_channel_id
        );

        if (!destination?.isTextBased()) {
          console.error(
            "Invalid destination channel:",
            copy.destination_channel_id
          );
          continue;
        }

        const destinationMessage = await destination.messages.fetch(
          copy.destination_message_id
        );

        await destinationMessage.edit({
          content: payload.content,
          files: payload.files,
          attachments: [],
          allowedMentions: { parse: [] },
        });

        console.log(
          `Updated ${message.id} -> ${copy.destination_message_id}`
        );
      } catch (error) {
        console.error(
          `Could not update destination copy ${copy.destination_message_id}:`,
          error
        );
      }
    }
  });
}

async function deleteCopiedMessages(message) {
  if (!message?.id) return;

  const copies = db.getCopies(message.id);

  if (copies.length === 0) return;

  await withLock(`${message.id}:delete`, async () => {
    for (const copy of copies) {
      if (await removeCopy(message.id, copy)) {
        console.log(
          `Deleted copy: ${message.id} -> ${copy.destination_message_id}`
        );
      }
    }
  });
}

module.exports = {
  updateCopiedMessage,
  deleteCopiedMessages,
};
