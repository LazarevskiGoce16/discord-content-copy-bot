# Discord Content Copy Bot

A one-way Discord content copier built with **Node.js** and **discord.js**.

`discord-content-copy-bot` copies messages containing links and attachments (images, GIFs, videos and other files) from source channels into mapped destination channels. It runs in one of two modes:

- **Migration:** copy each source channel's history once, then exit.
- **Synchronization:** copy history, then stay online and mirror new messages and, optionally, edits and deletions.

## Features

- **Channel mapping:** Configure multiple source-to-destination channel pairs.
- **Historical copy:** Copy existing channel history oldest-first.
- **Resumable:** A per-channel checkpoint lets an interrupted run continue where it stopped.
- **Live synchronization:** Copy new messages as they are posted, and optionally propagate edits and deletions.
- **Content filtering:** Choose whether to include images, videos, other files and links.
- **Attachment transfer:** Download eligible attachments and re-upload them, falling back to the original URL when a file is too large or cannot be downloaded.
- **Duplicate tracking:** SQLite records every copy, so re-running never re-sends a recorded message.
- **Attribution:** Each copy shows the original author's username and the original timestamp.

## Requirements

- [Node.js](https://nodejs.org/) 22 or later (required by better-sqlite3)
- npm
- A Discord application and bot created in the [Discord Developer Portal](https://discord.com/developers/applications)
- Authorization to read the source channels and to repost their content in the destination channels

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/YOUR_USERNAME/discord-content-copy-bot.git
cd discord-content-copy-bot
npm install
```

Create your environment and configuration files from the examples:

```bash
cp .env.example .env
cp config.example.json config.json
```

Put your bot token in `.env`:

```dotenv
DISCORD_TOKEN=YOUR_BOT_TOKEN
```

Edit `config.json` (see [Configuration](#configuration)), then start the bot:

```bash
npm start
```

## Discord bot setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create a new application and add a bot.
3. In the **Bot** settings, enable **Message Content Intent** under Privileged Gateway Intents. Without it, the bot cannot see links in message text.
4. Generate an OAuth2 authorization URL with the `bot` scope and the permissions below.
5. Invite the bot to both the source and destination servers.

Required permissions:

| Permission | Where | Purpose |
|---|---|---|
| View Channels | Source and destination | Access the configured channels |
| Read Message History | Source | Fetch historical messages |
| Read Message History | Destination | Find earlier copies when syncing edits and deletions |
| Send Messages | Destination | Post copied messages |
| Attach Files | Destination | Upload copied attachments (checked before sending a message with files) |
| Embed Links | Destination | Show link previews |

The bot only edits and deletes its own messages, so it does not need **Manage Messages**.

## Configuration

Example `config.json` (the same as `config.example.json`):

```json
{
  "mode": "migration",

  "history": {
    "enabled": true
  },

  "liveSync": {
    "enabled": false,
    "syncEdits": false,
    "syncDeletions": false
  },

  "channelMap": {
    "SOURCE_CHANNEL_ID_1": "DESTINATION_CHANNEL_ID_1",
    "SOURCE_CHANNEL_ID_2": "DESTINATION_CHANNEL_ID_2"
  },

  "copyAttachments": true,
  "copyLinks": true,

  "filters": {
    "images": true,
    "videos": true,
    "otherFiles": true,
    "links": true
  },

  "maxAttachmentSizeMB": 10
}
```

### Mode and synchronization options

| Setting | Type | Default | Description |
|---|---|---|---|
| `mode` | `"migration"` or `"synchronization"` | Required | Migration exits after copying history. Synchronization can stay online. |
| `history.enabled` | Boolean | `true` | Copy existing channel history on startup. |
| `liveSync.enabled` | Boolean | `false` | Copy new messages as they arrive. Only used in synchronization mode. |
| `liveSync.syncEdits` | Boolean | `false` | Update copies when the source message is edited. |
| `liveSync.syncDeletions` | Boolean | `false` | Delete copies when the source message is deleted. |

Synchronization mode needs `history.enabled` or `liveSync.enabled` turned on; the bot refuses to start otherwise.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | The bot token, read from `.env`. |
| `CONFIG_PATH` | No | Use a config file other than `config.json`, relative to the current directory. |
| `DATABASE_PATH` | No | Use a database file other than `transfer.sqlite`. The tests use `:memory:`. |

With `CONFIG_PATH` and `DATABASE_PATH`, one checkout can run several independent setups.

### Channel mapping

Each entry in `channelMap` maps one source channel ID to one destination channel ID:

```json
"channelMap": {
  "111111111111111111": "222222222222222222",
  "333333333333333333": "444444444444444444"
}
```

Several source channels can map to the same destination. A source channel can have only one destination, because each key in the map must be unique.

To copy a channel ID in Discord, enable **Developer Mode** in Discord's Advanced settings, right-click the channel and select **Copy Channel ID**.

### Content options

| Setting | Type | Default | Description |
|---|---|---|---|
| `copyAttachments` | Boolean | `true` | Master switch for attachments. When `false`, no attachments are copied, whatever the individual filters say. |
| `copyLinks` | Boolean | `true` | Master switch for links. When `false`, links do not make a message eligible and embed URLs are not added. |
| `filters.images` | Boolean | `true` | Include image attachments, including GIFs. |
| `filters.videos` | Boolean | `true` | Include video attachments. |
| `filters.otherFiles` | Boolean | `true` | Include attachments that are neither images nor videos. |
| `filters.links` | Boolean | `true` | Include messages that contain HTTP or HTTPS URLs. |
| `maxAttachmentSizeMB` | Number | `10` | Largest attachment the bot downloads and re-uploads. |

## What gets copied?

A message is copied when it contains at least one enabled link or attachment type. Messages sent by bots, including this one, are never copied.

| Source message | Result |
|---|---|
| Plain text only | Skipped |
| Text containing an HTTP/HTTPS URL | Copied when links are enabled |
| Link preview (embed) with a URL | Copied when links are enabled; the embed URL is added to the text |
| Image or GIF attachment | Copied when images are enabled |
| Video attachment | Copied when videos are enabled |
| PDF, ZIP or other attachment | Copied when other files are enabled |
| Text with an eligible attachment | Copied, including its text |
| Mixed attachments, some filtered out | Copied with only the enabled attachments; filtered ones are left out entirely |

Attachment types are detected from the content type, falling back to the file extension.

Each copy starts with the original author's username and the original UTC timestamp, and is cut to Discord's 2,000-character limit. Mentions in copied text are never pinged.

Attachment downloads time out after 30 seconds and are retried up to three times on network errors, rate limits and server errors. When an enabled attachment is larger than `maxAttachmentSizeMB` or still cannot be downloaded, its original URL is added under **Original attachment links** instead. If Discord rejects a message outright (for example because its files together exceed the server's upload limit), the bot logs it, skips it and continues.

## How it runs

### History

For each entry in `channelMap`, the bot:

1. Fetches the source channel's history.
2. Copies eligible messages to the destination, oldest first.
3. Records each copy in SQLite and saves a checkpoint after every message.

The first run for a channel pair scans the full history. Later runs only fetch messages newer than the checkpoint, so restarting in synchronization mode also picks up messages posted while the bot was offline.

If a copy fails for a reason that might be temporary, such as a network error or missing permissions, the bot stops that channel at the failed message and moves on to the next mapping. It retries from that message on the next run. The same applies when a source channel cannot be read at all: that mapping is reported as incomplete and the others still run.

### After history

- **Migration mode:** the bot shuts down. It exits with code `0` when every channel completed, or `1` when any channel was left incomplete. Run `npm start` again to resume.
- **Synchronization mode with `liveSync.enabled`:** the bot stays online and copies new messages from mapped channels as they arrive.

### Edits and deletions

With `syncEdits` on:

- Editing a source message updates every copy of it.
- If the edit removes everything eligible (for example, the only link is deleted), the copies are deleted.
- If the edit makes a skipped message eligible (for example, a link is added), a copy is created. With `history.enabled: false`, this only applies to messages posted while the bot was online. The new copy is posted at the end of the destination channel, not at the original message's position.
- Link previews that Discord adds after a message is posted are not treated as edits, so copies are not re-uploaded for them.
- If a copy was deleted by hand in the destination, the bot forgets it instead of retrying.

With `syncDeletions` on, deleting a source message, including through bulk deletion, deletes its copies. A message deleted while its copy is still being sent has that copy removed as soon as the send finishes.

Edits and deletions of the same message are applied in the order they arrive. Only changes that happen while the bot is online are synchronized.

## Data stored in SQLite

The bot creates `transfer.sqlite` in the directory it runs from, with two tables:

- `copied_messages`: source message ID, source and destination channel IDs, destination message ID and copy time. A source message is recorded at most once per destination channel. Edit and deletion sync uses this table to find copies.
- `sync_checkpoints`: the last processed source message for each source and destination pair.

Keep the database to preserve progress. To start completely fresh, stop the bot and delete `transfer.sqlite`. **This discards all records**, so everything will be copied again and old copies can no longer be edited or deleted by the bot.

Changing a source channel's destination in `channelMap` starts a new history copy for the new pair; the old pair's records are kept.

## Project structure

```text
discord-content-copy-bot/
├── src/
│   ├── index.js              # Entry point: checks the token, registers handlers, logs in
│   ├── config.js             # Loads and validates config.json
│   ├── client.js             # Discord client
│   ├── db.js                 # SQLite schema and queries
│   ├── handlers/             # One file per Discord event
│   ├── services/
│   │   ├── copy.js           # Copies one message to a destination
│   │   ├── history.js        # Checkpointed history copy
│   │   └── sync.js           # Edit and deletion propagation
│   └── utils/
│       ├── filters.js        # Link and attachment eligibility
│       ├── payload.js        # Builds the message sent to the destination
│       └── errors.js         # Discord error classification
├── tests/                    # node:test suite with fake Discord channels
├── .env.example
├── config.example.json
├── package.json
└── package-lock.json
```

`.env`, `config.json` and `transfer.sqlite` are created locally and are ignored by git.

## Security

Never commit your Discord bot token. The included `.gitignore` already excludes `.env`, `config.json`, `node_modules/` and the SQLite files.

If a bot token is ever exposed, reset it in the Discord Developer Portal immediately and update your `.env` file.

## Limitations

- **Not an exact recreation:** Copies are sent by the bot. Discord does not let a bot post as the original author or backdate a message, so authorship and time are shown as text.
- **Reactions and threads** are not copied.
- **Embeds:** Only embed URLs are copied; Discord regenerates the preview in the destination, which may look different.
- **Offline changes:** Edits and deletions made while the bot is offline are not synchronized.
- **Large histories:** The first scan of a channel loads its whole history into memory before copying. Later runs only fetch messages after the checkpoint.
- **Rare duplicates:** If the bot stops after Discord accepts a message but before the copy is recorded, that message can be copied again on the next run.
- **Rate limits:** Messages are copied one at a time, and discord.js waits out Discord's rate limits automatically.

## Troubleshooting

### `DISCORD_TOKEN is missing from .env`

Make sure `.env` exists in the project root and contains `DISCORD_TOKEN=YOUR_BOT_TOKEN` with no spaces around the `=`.

### `Invalid mode` or `channelMap must contain at least one channel mapping`

Check that `mode` is `"migration"` or `"synchronization"` and that `channelMap` has at least one entry.

### `Invalid source channel` or `Invalid destination channel`

The channel ID is wrong, or the bot is not in that server or cannot see the channel. Check the IDs and the **View Channels** permission.

### `History sync failed for …`

The source channel could not be read, usually because the ID is wrong or the bot lacks **View Channels** or **Read Message History** there. The error that follows gives the details. Other mappings still run.

### `Missing destination permissions` or `Missing Attach Files permission in destination`

Give the bot **View Channels** and **Send Messages** in the destination channel, plus **Attach Files** if messages have attachments, then restart. History resumes from the checkpoint.

### `Historical migration incomplete for: …`

At least one channel stopped at a message that could not be copied. The log line before it shows the error. Fix the cause and run the bot again; it resumes from that message.

### Links are missing or link-only messages are skipped

Verify that **Message Content Intent** is enabled in the Developer Portal, and check `copyLinks` and `filters.links`.

### Attachments are not copied

Check `copyAttachments`, the relevant filter (`images`, `videos` or `otherFiles`), `maxAttachmentSizeMB` and the bot's **Attach Files** permission in the destination.

### Edits or deletions are not synchronized

Check that `mode` is `"synchronization"`, `liveSync.enabled` is `true`, and `syncEdits` or `syncDeletions` is `true`. The bot also needs **Read Message History** in the destination channel.

## Development

```bash
npm install
npm start
npm test
```

`npm test` runs the suite in `tests/` with Node's built-in test runner. The tests use fake Discord channels, `tests/fixtures/config.json` and an in-memory database, so they need no token, never connect to Discord and never touch your `config.json` or `transfer.sqlite`.

The project uses:

- [Node.js](https://nodejs.org/)
- [discord.js](https://discord.js.org/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [dotenv](https://www.npmjs.com/package/dotenv)

## License

No license has been specified yet. Add a `LICENSE` file before presenting the repository as open source.
