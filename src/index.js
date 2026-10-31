require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionsBitField,
} = require("discord.js");

const Database = require("better-sqlite3");
const config = require("../config.json");

if (!process.env.DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is missing from .env");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const db = new Database("transfer.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS copied_messages (
    source_message_id TEXT PRIMARY KEY,
    source_channel_id TEXT NOT NULL,
    destination_message_id TEXT NOT NULL,
    copied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const isCopied = db.prepare(
  "SELECT 1 FROM copied_messages WHERE source_message_id = ?"
);

const saveCopied = db.prepare(`
  INSERT OR IGNORE INTO copied_messages
    (source_message_id, source_channel_id, destination_message_id)
  VALUES (?, ?, ?)
`);

const inProgress = new Set();
const maxAttachmentBytes =
  (config.maxAttachmentSizeMB ?? 8) * 1024 * 1024;

function truncate(text, maxLength = 2000) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

async function copyMessage(message, destinationId) {
  if (!message || message.author?.bot) return;
  if (message.author?.id === client.user.id) return;

  if (isCopied.get(message.id) || inProgress.has(message.id)) {
    return;
  }

  inProgress.add(message.id);

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

    let content = "";

    // Keep links and text, with clear attribution to the source.
    if (message.content) {
      content = message.content;
    }

    if (config.copyLinks) {
      const embeddedLinks = message.embeds
        .map((embed) => embed.url)
        .filter((url) => url && !content.includes(url));

      if (embeddedLinks.length) {
        content += (content ? "\n" : "")
          + embeddedLinks.join("\n");
      }
    }

    const files = [];
    const fallbackLinks = [];

    if (config.copyAttachments) {
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

          const buffer = Buffer.from(
            await response.arrayBuffer()
          );

          // Check actual size too, not only Discord's metadata.
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

    if (!content.trim() && files.length === 0) return;

    // Mark the copied content so it cannot be mistaken for
    // an original message from the source author.
    const attribution =
      `**${message.author.username} (copied)**\n` +
      `*Original date: ${message.createdAt.toISOString()}*\n\n`;

    content = truncate(
      attribution + content,
      2000
    );

    const sent = await destination.send({
      content: content || undefined,
      files,
      allowedMentions: { parse: [] },
    });

    saveCopied.run(
      message.id,
      message.channelId,
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
    inProgress.delete(message.id);
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
  console.log("Starting one-time migration...");

  try {
    for (const [sourceId, destinationId] of
      Object.entries(config.channelMap)) {
      console.log(`Migrating channel ${sourceId}`);

      await syncHistory(sourceId, destinationId);
    }

    console.log("Migration completed successfully.");
    console.log("The bot will now shut down.");

    db.close();
    client.destroy();
    process.exitCode = 0;
  } catch (error) {
    console.error("Migration failed:", error);
    console.error(
      "Fix the problem and rerun to retry the migration."
    );

    db.close();
    client.destroy();
    process.exitCode = 1;
  }
});


client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

client.login(process.env.DISCORD_TOKEN);
