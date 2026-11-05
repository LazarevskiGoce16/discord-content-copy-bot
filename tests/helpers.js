// Shared test setup. Require this before anything from src/ so the
// fixture config and an in-memory database are used.
const path = require("path");

process.env.CONFIG_PATH = path.join(__dirname, "fixtures", "config.json");
process.env.DATABASE_PATH = ":memory:";

const { DiscordAPIError, PermissionsBitField } = require("discord.js");

const client = require("../src/client");
const { config } = require("../src/config");

const defaultConfig = structuredClone(config);

// Restores the fixture config, then applies overrides.
function setConfig(overrides = {}) {
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, structuredClone(defaultConfig), overrides);
}

function apiError(status, code, message = "API error") {
  return new DiscordAPIError(
    { message, code }, code, status, "POST", "/test", {}
  );
}

function attachment(name, contentType, size = 4) {
  return { name, contentType, size, url: `https://cdn.test/${name}` };
}

let nextSnowflake = 1n;

function makeMessage({
  id = String(nextSnowflake++),
  channelId = "source",
  content = "",
  attachments = [],
  embeds = [],
  bot = false,
  createdTimestamp = Date.now(),
  editedTimestamp = null,
} = {}) {
  const map = new Map(attachments.map((a, i) => [String(i), a]));

  return {
    id,
    channelId,
    content,
    attachments: map,
    embeds,
    author: { id: bot ? "bot" : "user", username: "author", bot },
    createdAt: new Date(createdTimestamp),
    createdTimestamp,
    editedTimestamp,
    partial: false,
  };
}

// A destination channel that records what the bot sends, edits and deletes.
function makeDestination({
  permissions = ["ViewChannel", "SendMessages", "AttachFiles"],
  failSend = null,
} = {}) {
  const granted = permissions.map((name) => PermissionsBitField.Flags[name]);
  const messages = new Map();
  let nextId = 1;

  const channel = {
    id: "destination",
    guild: { members: { me: {} } },
    isTextBased: () => true,
    permissionsFor: () => ({
      has: (flags) => [flags].flat().every((flag) => granted.includes(flag)),
    }),

    async send(payload) {
      const error = failSend?.(payload);
      if (error) throw error;

      const id = `copy-${nextId++}`;
      const sent = {
        id,
        content: payload.content,
        files: payload.files,
        async edit(update) {
          sent.content = update.content;
          sent.files = update.files;
          sent.edits = (sent.edits ?? 0) + 1;
        },
        async delete() {
          messages.delete(id);
        },
      };

      messages.set(id, sent);
      return sent;
    },
  };

  // Mirrors discord.js: fetch(id) returns one message or throws 10008.
  channel.messages = {
    store: messages,
    async fetch(id) {
      if (!messages.has(id)) throw apiError(404, 10008, "Unknown Message");
      return messages.get(id);
    },
  };

  return channel;
}

// A source channel that pages like Discord: newest-first, and with
// `after` returns the oldest `limit` messages after that ID. Like Discord,
// it returns no messages (not an error) without Read Message History.
function makeSource(messages, {
  permissions = ["ViewChannel", "ReadMessageHistory"],
} = {}) {
  const granted = permissions.map((name) => PermissionsBitField.Flags[name]);
  const canReadHistory = granted.includes(
    PermissionsBitField.Flags.ReadMessageHistory
  );
  const sorted = [...messages].sort(
    (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)
  );

  return {
    id: "source",
    guild: { members: { me: {} } },
    isTextBased: () => true,
    permissionsFor: () => ({
      has: (flags) => [flags].flat().every((flag) => granted.includes(flag)),
    }),
    messages: {
      async fetch({ before, after, limit }) {
        let page;

        if (!canReadHistory) {
          page = [];
        } else if (after) {
          page = sorted
            .filter((m) => BigInt(m.id) > BigInt(after))
            .slice(0, limit);
        } else {
          page = sorted
            .filter((m) => !before || BigInt(m.id) < BigInt(before))
            .slice(-limit);
        }

        page.reverse();

        const result = new Map(page.map((m) => [m.id, m]));
        result.last = () => page[page.length - 1];
        return result;
      },
    },
  };
}

// Routes client.channels.fetch to fakes; unknown IDs throw like Discord.
function useChannels(channels) {
  client.channels.fetch = async (id) => {
    if (channels[id]) return channels[id];
    throw apiError(404, 10003, "Unknown Channel");
  };
}

module.exports = {
  client,
  config,
  setConfig,
  apiError,
  attachment,
  makeMessage,
  makeDestination,
  makeSource,
  useChannels,
};
