const client = require("../client");
const db = require("../db");
const { historyEnabled, getDestinationId } = require("../config");
const { shouldCopyMessage } = require("../utils/filters");
const { buildMessagePayload } = require("../utils/payload");
const { isUnknownMessageError } = require("../utils/errors");
const { copyMessage, waitForPendingCopies } = require("./copy");

// Per-message task chains. Edits and deletions of the same message run
// one after another, so a rapid second edit is applied rather than lost.
const queues = new Map();

function enqueue(messageId, task) {
  const run = (queues.get(messageId) ?? Promise.resolve())
    .then(async () => {
      // Act on copies that are still being sent, too.
      await waitForPendingCopies(messageId);
      await task();
    })
    .catch((error) => {
      console.error(`Sync task for message ${messageId} failed:`, error);
    });

  queues.set(messageId, run);

  run.finally(() => {
    if (queues.get(messageId) === run) queues.delete(messageId);
  });

  return run;
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

// Messages history sync would have covered, or that were posted while
// the bot was online, may get a copy when an edit makes them eligible.
function isInLiveScope(message) {
  return historyEnabled()
    || message.createdTimestamp >= client.readyTimestamp;
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

  // Discord also sends updates when it adds link previews. Only real
  // edits set editedTimestamp; skip the rest to avoid needless re-uploads.
  if (!message.editedTimestamp) return;

  await enqueue(message.id, async () => {
    const copies = db.getCopies(message.id);
    const eligible = shouldCopyMessage(message);

    if (copies.length === 0) {
      const destinationId = getDestinationId(message.channelId);

      // The edit made a previously skipped message eligible.
      if (eligible && destinationId && isInLiveScope(message)) {
        await copyMessage(message, destinationId);
      }

      return;
    }

    // If the edit makes the message ineligible,
    // remove its existing destination copies.
    if (!eligible) {
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
        if (isUnknownMessageError(error)) {
          // Someone deleted the copy by hand. Keep it deleted: don't
          // update it again, and don't let history sync re-copy it.
          db.markRemoved(message.id, copy.destination_channel_id);
          console.log(
            `Copy ${copy.destination_message_id} was deleted by hand; ` +
            "it will not be re-created."
          );
          continue;
        }

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

  await enqueue(message.id, async () => {
    for (const copy of db.getCopies(message.id)) {
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
