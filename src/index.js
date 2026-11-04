require("dotenv").config();

const {
  Client,
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
  )
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

const inProgress = new Set();
const maxAttachmentBytes =
  (config.maxAttachmentSizeMB ?? 10) * 1024 * 1024;

function truncate(text, maxLength = 2000) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

function shouldCopyMessage(message) {
  const filters = config.filters || {};

  const hasLink =
    filters.links !== false &&
    config.copyLinks !== false &&
    /https?:\/\/\S+/i.test(message.content);

  const hasEligibleAttachment = [
    ...message.attachments.values()
  ].some((attachment) => {
    if (config.copyAttachments === false) return false;

    const type = attachment.contentType || "";
    const filename = attachment.name || "";

    const isImage =
      type.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(filename);

    const isVideo =
      type.startsWith("video/") ||
      /\.(mp4|mov|webm|mkv|avi)$/i.test(filename);

    const isOtherFile = !isImage && !isVideo;

    return (
      (isImage && filters.images !== false) ||
      (isVideo && filters.videos !== false) ||
      (isOtherFile && filters.otherFiles !== false)
    );
  });

  return hasLink || hasEligibleAttachment;
}

async function buildMessagePayload(message) {
  let content = message.content || "";

  // Include URLs from embeds.
  if (config.copyLinks !== false) {
    const embeddedLinks = message.embeds
      .map((embed) => embed.url)
      .filter((url) => url && !content.includes(url));

    if (embeddedLinks.length) {
      content += (content ? "\n" : "") + embeddedLinks.join("\n");
    }
  }

  const files = [];
  const fallbackLinks = [];

  if (config.copyAttachments !== false) {
    for (const attachment of message.attachments.values()) {
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
  } else {
    fallbackLinks.push(
      ...message.attachments.map((attachment) => attachment.url)
    );
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

async function copyMessage(message, destinationId) {
  if (!message || message.author?.bot) return;
  if (!shouldCopyMessage(message)) return;
  if (message.author?.id === client.user.id) return;

  const copyKey = `${message.id}:${destinationId}`;

  if (isCopied.get(message.id, destinationId) || inProgress.has(copyKey)) {
    return;
  }

  inProgress.add(copyKey);

  try {
    const destination = await client.channels.fetch(destinationId);

    if (!destination || !destination.isTextBased()
        || !destination.guild) {
      console.error("Invalid destination channel:", destinationId);
      return;
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
      return;
    }

    const payload = await buildMessagePayload(message);

    if (!payload) return;

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
  } catch (error) {
    console.error(
      `Failed to copy message ${message.id}:`,
      error
    );
  } finally {
    inProgress.delete(copyKey);
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

  if (!source || !source.isTextBased() || !source.guild) {
    console.error("Invalid source channel:", sourceId);
    return;
  }

  console.log(`Reading history from ${sourceId}`);

  let before;
  const pages = [];

  // Fetch history in batches of up to 100 messages.
  while (true) {
    const options = { limit: 100 };

    if (before) options.before = before;

    const batch = await source.messages.fetch(options);

    if (batch.size === 0) break;

    pages.push([...batch.values()]);
    before = batch.last().id;

    if (batch.size < 100) break;
  }

  // API results are newest-first. Reverse the pages and
  // sort each page to transfer the history oldest-first.
  pages.reverse();

  for (const page of pages) {
    page.sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    for (const message of page) {
      await copyMessage(message, destinationId);
    }
  }

  console.log(`Finished history for ${sourceId}`);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Selected mode: ${config.mode}`);

  try {
    // Step 1: Copy historical messages if enabled.
    if (config.history?.enabled !== false) {
      console.log("Starting historical migration...");

      for (const [sourceId, destinationId] of
        Object.entries(config.channelMap)) {
        console.log(
          `Migrating ${sourceId} -> ${destinationId}`
        );

        await syncHistory(sourceId, destinationId);
      }

      console.log("Historical migration completed.");
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
    process.exitCode = 0;
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
