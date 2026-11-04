const { PermissionsBitField } = require("discord.js");

const client = require("../client");
const db = require("../db");
const { shouldCopyMessage } = require("../utils/filters");
const { buildMessagePayload } = require("../utils/payload");
const { isPermanentSendError } = require("../utils/errors");

// In-flight copies, so concurrent callers can await the same result.
const pendingCopies = new Map();

// Returns true when the message is copied or intentionally skipped,
// and false when it should be retried later.
async function copyMessage(message, destinationId) {
  if (!message || message.author?.bot || !shouldCopyMessage(message)) {
    return true;
  }

  if (db.isCopied(message.id, destinationId)) return true;

  const copyKey = `${message.id}:${destinationId}`;

  // Another caller (live sync or history sync) is already copying this
  // message; report its outcome instead of assuming success.
  if (pendingCopies.has(copyKey)) return pendingCopies.get(copyKey);

  const copy = sendCopy(message, destinationId);
  pendingCopies.set(copyKey, copy);

  try {
    return await copy;
  } finally {
    pendingCopies.delete(copyKey);
  }
}

async function sendCopy(message, destinationId) {
  try {
    const destination = await client.channels.fetch(destinationId);

    if (!destination || !destination.isTextBased()
        || !destination.guild) {
      console.error("Invalid destination channel:", destinationId);
      return false;
    }

    const me = destination.guild.members.me;
    const permissions = me
      ? destination.permissionsFor(me)
      : null;

    if (!permissions?.has([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
    ])) {
      console.error(
        "Missing destination permissions:",
        destinationId
      );
      return false;
    }

    const payload = await buildMessagePayload(message);

    if (!payload) return true;

    const sent = await destination.send(payload);

    db.saveCopied(
      message.id,
      message.channelId,
      destinationId,
      sent.id
    );

    console.log(
      `Copied ${message.id} -> ${sent.id} | ` +
      `Original time: ${message.createdAt.toLocaleString()}`
    );

    return true;
  } catch (error) {
    if (isPermanentSendError(error)) {
      console.error(
        `Skipping message ${message.id}; Discord rejected it permanently:`,
        error.message
      );
      return true;
    }

    console.error(
      `Failed to copy message ${message.id}:`,
      error
    );
    return false;
  }
}

module.exports = { copyMessage };
