require("dotenv").config();

const {
  Client,
  DiscordAPIError,
  GatewayIntentBits,
  Events,
  PermissionsBitField,
  Partials
} = require("discord.js");

const Database = require("better-sqlite3");
const config = require("../config.json");

const validModes = ["migration", "synchronization"];

if (!validModes.includes(config.mode)) {
  throw new Error(
    `Invalid mode "${config.mode}". Use "migration" or "synchronization".`
  );
}

if (!config.channelMap || Object.keys(config.channelMap).length === 0) {
  throw new Error("channelMap must contain at least one channel mapping.");
}

if (
  config.mode === "synchronization" &&
  config.history?.enabled === false &&
  config.liveSync?.enabled !== true
) {
  throw new Error(
    "Synchronization mode requires history or live synchronization to be enabled."
  );
}

if (!process.env.DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is missing from .env");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
  ]
});

const db = new Database("transfer.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS copied_messages (
    source_message_id TEXT NOT NULL,
    source_channel_id TEXT NOT NULL,
    destination_channel_id TEXT NOT NULL,
    destination_message_id TEXT NOT NULL,
    copied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

const isCopied = db.prepare(`
  SELECT 1 FROM copied_messages
  WHERE source_message_id = ?
    AND destination_channel_id = ?
`);

const saveCopied = db.prepare(`
  INSERT OR IGNORE INTO copied_messages (
    source_message_id,
    source_channel_id,
    destination_channel_id,
    destination_message_id
  )
  VALUES (?, ?, ?, ?)
`);

const getCopies = db.prepare(`
  SELECT destination_channel_id, destination_message_id
  FROM copied_messages
  WHERE source_message_id = ?
`);

const deleteCopied = db.prepare(`
  DELETE FROM copied_messages
  WHERE source_message_id = ?
    AND destination_channel_id = ?
`);

const getCheckpoint = db.prepare(`
  SELECT last_message_id
  FROM sync_checkpoints
  WHERE source_channel_id = ?
    AND destination_channel_id = ?
`);

const saveCheckpoint = db.prepare(`
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

const inProgress = new Set();
// In-flight copies, so concurrent callers can await the same result.
const pendingCopies = new Map();
const maxAttachmentBytes =
  (config.maxAttachmentSizeMB ?? 10) * 1024 * 1024;

function truncate(text, maxLength = 2000) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

function linksEnabled() {
  return config.copyLinks !== false && config.filters?.links !== false;
}

// Shared by shouldCopyMessage() and buildMessagePayload() so the
// decision to copy a message and what gets copied always agree.
function isAttachmentAllowed(attachment) {
  if (config.copyAttachments === false) return false;

  const filters = config.filters || {};
  const type = attachment.contentType || "";
  const filename = attachment.name || "";

  const isImage =
    type.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(filename);

  const isVideo =
    type.startsWith("video/") ||
    /\.(mp4|mov|webm|mkv|avi)$/i.test(filename);

  if (isImage) return filters.images !== false;
  if (isVideo) return filters.videos !== false;
  return filters.otherFiles !== false;
}

function getEmbeddedLinks(message) {
  return message.embeds
    .map((embed) => embed.url)
    .filter(Boolean);
}

function shouldCopyMessage(message) {
  const hasLink =
    linksEnabled() &&
    (/https?:\/\/\S+/i.test(message.content)
      || getEmbeddedLinks(message).length > 0);

  const hasEligibleAttachment = [
    ...message.attachments.values()
  ].some(isAttachmentAllowed);

  return hasLink || hasEligibleAttachment;
}

async function buildMessagePayload(message) {
  let content = message.content || "";

  // Include URLs from embeds.
  if (linksEnabled()) {
    const embeddedLinks = getEmbeddedLinks(message)
      .filter((url) => !content.includes(url));

    if (embeddedLinks.length) {
      content += (content ? "\n" : "") + embeddedLinks.join("\n");
    }
  }

  const files = [];
  const fallbackLinks = [];

  // Attachments excluded by copyAttachments or the type filters are
  // dropped entirely, not posted as links.
  for (const attachment of message.attachments.values()) {
    if (!isAttachmentAllowed(attachment)) continue;

    if (attachment.size > maxAttachmentBytes) {
      fallbackLinks.push(attachment.url);
      continue;
    }

    try {
      const response = await fetch(attachment.url);

      if (!response.ok) {
        throw new Error(`Download returned ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.length > maxAttachmentBytes) {
        fallbackLinks.push(attachment.url);
        continue;
      }

      files.push({
        attachment: buffer,
        name: attachment.name || "attachment",
      });
    } catch (error) {
      console.warn(
        "Could not download attachment:",
        attachment.url,
        error.message
      );

      fallbackLinks.push(attachment.url);
    }
  }

  if (fallbackLinks.length) {
    content += (content ? "\n" : "")
      + "Original attachment links:\n"
      + fallbackLinks.join("\n");
  }

  if (!content.trim() && files.length === 0) {
    return null;
  }

  const attribution =
    `**${message.author.username} (copied)**\n` +
    `*Original date: ${message.createdAt.toISOString()}*\n\n`;

  content = truncate(attribution + content, 2000);

  return {
    content,
    files,
    allowedMentions: { parse: [] },
  };
}

// Discord rejects these requests no matter how often they are retried
// (e.g. 400 invalid form body, 413 request entity too large).
function isPermanentSendError(error) {
  return error instanceof DiscordAPIError
    && (error.status === 400 || error.status === 413);
}

// Returns true when the message is copied or intentionally skipped,
// and false when it should be retried later.
async function copyMessage(message, destinationId) {
  if (!message || message.author?.bot || !shouldCopyMessage(message)) {
    return true;
  }

  if (isCopied.get(message.id, destinationId)) return true;

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

    saveCopied.run(
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
  if (message.author.id === client.user.id) return;

  const copies = getCopies.all(message.id);

  if (copies.length === 0) return;

  const copyKey = `${message.id}:update`;

  if (inProgress.has(copyKey)) return;

  inProgress.add(copyKey);

  try {
    const stillEligible = shouldCopyMessage(message);

    // If the edit makes the message ineligible,
    // remove its existing destination copies.
    if (!stillEligible) {
      for (const copy of copies) {
        try {
          const destination = await client.channels.fetch(
            copy.destination_channel_id
          );

          if (destination?.isTextBased()) {
            const destinationMessage = await destination.messages.fetch(
              copy.destination_message_id
            );

            await destinationMessage.delete();
          }

          deleteCopied.run(
            message.id,
            copy.destination_channel_id
          );

          console.log(
            `Removed copy ${copy.destination_message_id} ` +
            `because source message ${message.id} is no longer eligible.`
          );
        } catch (error) {
          if (error.code === 10008) {
            // The destination message was already deleted.
            deleteCopied.run(
              message.id,
              copy.destination_channel_id
            );
          } else {
            console.error(
              `Could not remove copy ${copy.destination_message_id}:`,
              error
            );
          }
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
  } finally {
    inProgress.delete(copyKey);
  }
}

async function deleteCopiedMessages(message) {
  if (!message?.id) return;

  const copies = getCopies.all(message.id);

  if (copies.length === 0) return;

  const deleteKey = `${message.id}:delete`;

  if (inProgress.has(deleteKey)) return;

  inProgress.add(deleteKey);

  try {
    for (const copy of copies) {
      try {
        const destination = await client.channels.fetch(
          copy.destination_channel_id
        );

        if (!destination || !destination.isTextBased()) {
          console.error(
            `Cannot access destination channel: ${copy.destination_channel_id}`
          );
          continue;
        }

        const destinationMessage = await destination.messages.fetch(
          copy.destination_message_id
        );

        await destinationMessage.delete();

        deleteCopied.run(
          message.id,
          copy.destination_channel_id
        );

        console.log(
          `Deleted copy: ${message.id} -> ${copy.destination_message_id}`
        );
      } catch (error) {
        // The destination message may already have been deleted.
        if (error.code === 10008 || error.status === 404) {
          deleteCopied.run(
            message.id,
            copy.destination_channel_id
          );

          console.log(
            `Copy was already deleted: ${copy.destination_message_id}`
          );
        } else {
          console.error(
            `Failed to delete copy ${copy.destination_message_id}:`,
            error
          );
        }
      }
    }
  } finally {
    inProgress.delete(deleteKey);
  }
}

async function syncHistory(sourceId, destinationId) {
  const source = await client.channels.fetch(sourceId);

  if (!source || !source.isTextBased() || !source.messages) {
    console.error(`Invalid source channel: ${sourceId}`);
    return false;
  }

  const checkpoint = getCheckpoint.get(sourceId, destinationId);

  let lastMessageId = checkpoint?.last_message_id ?? null;
  let processedCount = 0;

  console.log(
    checkpoint
      ? `Recovering messages after ${lastMessageId} in ${sourceId}`
      : `Starting initial history scan for ${sourceId}`
  );

  if (lastMessageId) {
    // Recover messages posted after the previous checkpoint.
    while (true) {
      const messages = await source.messages.fetch({
        after: lastMessageId,
        limit: 100,
      });

      if (messages.size === 0) break;

      const orderedMessages = [...messages.values()].sort(
        (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1
      );

      for (const message of orderedMessages) {
        const success = await copyMessage(message, destinationId);

        if (success === false) {
          console.error(
            `Stopping history sync at ${message.id}. It will be retried next time.`
          );
          return false;
        }

        saveCheckpoint.run(sourceId, destinationId, message.id);

        // Advance the recovery cursor.
        lastMessageId = message.id;
        processedCount++;
      }
    }
  } else {
    // No checkpoint exists: perform the initial full-history scan.
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

    // Process messages from oldest to newest.
    allMessages.sort(
      (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1
    );

    for (const message of allMessages) {
      const success = await copyMessage(message, destinationId);

      if (success === false) {
        console.error(
          `Stopping history sync at ${message.id}. It will be retried next time.`
        );
        return false;
      }

      saveCheckpoint.run(sourceId, destinationId, message.id);
      lastMessageId = message.id;
      processedCount++;
    }
  }

  console.log(
    `Finished history sync for ${sourceId}. Processed ${processedCount} messages.`
  );

  return true;
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Selected mode: ${config.mode}`);

  const failedChannels = [];

  try {
    // Step 1: Copy historical messages if enabled.
    if (config.history?.enabled !== false) {
      console.log("Starting historical migration...");

      for (const [sourceId, destinationId] of
        Object.entries(config.channelMap)) {
        console.log(
          `Migrating ${sourceId} -> ${destinationId}`
        );

        const success = await syncHistory(sourceId, destinationId);

        if (!success) failedChannels.push(sourceId);
      }

      if (failedChannels.length) {
        console.error(
          `Historical migration incomplete for: ${failedChannels.join(", ")}. ` +
          "Restart the bot to resume from the last checkpoint."
        );
      } else {
        console.log("Historical migration completed.");
      }
    } else {
      console.log("Historical migration is disabled.");
    }

    // Step 2: Decide whether the bot should remain online.
    const liveSyncEnabled =
      config.mode === "synchronization" &&
      config.liveSync?.enabled === true;

    if (liveSyncEnabled) {
      console.log("Live synchronization is enabled.");
      console.log("The bot will remain online.");
      return;
    }

    console.log("No live synchronization requested.");
    console.log("Shutting down the bot.");

    db.close();
    client.destroy();
    process.exitCode = failedChannels.length ? 1 : 0;
  } catch (error) {
    console.error("Migration failed:", error);
    console.error(
      "Fix the problem and restart the bot to retry."
    );

    db.close();
    client.destroy();
    process.exitCode = 1;
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (
    config.mode !== "synchronization" ||
    config.liveSync?.enabled !== true
  ) {
    return;
  }

  const destinationId = config.channelMap[message.channelId];

  if (!destinationId) return;

  await copyMessage(message, destinationId);
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (
    config.mode !== "synchronization" ||
    config.liveSync?.enabled !== true ||
    config.liveSync?.syncEdits !== true
  ) {
    return;
  }

  if (!config.channelMap[newMessage.channelId]) return;

  await updateCopiedMessage(newMessage);
});

client.on(Events.MessageDelete, async (message) => {
  if (
    config.mode !== "synchronization" ||
    config.liveSync?.enabled !== true ||
    config.liveSync?.syncDeletions !== true
  ) {
    return;
  }

  if (!config.channelMap[message.channelId]) return;

  await deleteCopiedMessages(message);
});

client.on(Events.MessageBulkDelete, async (messages, channel) => {
  if (
    config.mode !== "synchronization" ||
    config.liveSync?.enabled !== true ||
    config.liveSync?.syncDeletions !== true
  ) {
    return;
  }

  if (!config.channelMap[channel.id]) return;

  for (const message of messages.values()) {
    await deleteCopiedMessages(message);
  }
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

client.login(process.env.DISCORD_TOKEN);
