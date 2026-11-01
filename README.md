# Discord Content Copy Bot

A one-way Discord server content migration tool built with **Node.js** and **discord.js**.

`discord-content-copy-bot` copies selected historical messages from source channels into mapped destination channels. It is designed for one-time migrations—not continuous mirroring or synchronization.

It can transfer messages containing links and selected attachments, including images, GIFs, videos, and other files.

## Features

- **One-way migration:** Copy content from a source server/channel to a destination server/channel.
- **Selected channel mapping:** Configure multiple source-to-destination channel pairs.
- **Historical messages:** Fetch and process existing channel history.
- **Content filtering:** Choose whether to include images, videos, other files, and links.
- **Attachment transfer:** Download eligible attachments and upload them to the destination channel, subject to Discord's upload limits.
- **Duplicate tracking:** Use SQLite to remember which source messages have been copied to each destination channel.
- **Independent destinations:** The same source message can be copied to multiple destination channels, with separate tracking for each destination.
- **Migration logging:** Log source and destination message IDs and the original message timestamp.
- **One-time execution:** Shut down after the configured migration finishes.

## Requirements

- [Node.js](https://nodejs.org/) (a current LTS release is recommended)
- npm
- A Discord application and bot created in the [Discord Developer Portal](https://discord.com/developers/applications)
- Permission to access the source channels and post in the destination channels

## Installation

Clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/discord-content-copy-bot.git
cd discord-content-copy-bot
```

Install dependencies:

```bash
npm install
```

Create a `.env` file in the project root:

```dotenv
DISCORD_TOKEN=YOUR_BOT_TOKEN
```

Create `config.json` in the project root. See [Configuration](#configuration) below.

Start the migration:

```bash
npm start
```

The bot logs in, processes each configured channel mapping, and shuts down when the migration finishes.

## Discord bot setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create a new application and add a bot.
3. Open the **Bot** settings.
4. Enable **Message Content Intent** under Privileged Gateway Intents.
5. Generate an OAuth2 authorization URL with the `bot` scope.
6. Invite the bot to both the source and destination servers.

The bot needs these permissions:

| Permission | Where | Purpose |
|---|---|---|
| View Channels | Source and destination | Access the configured channels |
| Read Message History | Source | Fetch historical messages |
| Send Messages | Destination | Post migrated messages |
| Attach Files | Destination | Upload copied attachments |
| Embed Links | Destination | Display link previews where Discord permits them |

The bot must be able to access every configured source and destination channel. You must have authorization to access and repost the content being migrated.

## Configuration

Example `config.json`:

```json
{
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
  "maxAttachmentSizeMB": 8
}
```

### Channel mapping

Each entry in `channelMap` maps one source channel ID to one destination channel ID:

```json
"channelMap": {
  "111111111111111111": "222222222222222222",
  "333333333333333333": "444444444444444444"
}
```

The bot processes each mapping independently. You can map multiple source channels to different destination channels, and you can map the same source channel to more than one destination channel.

To copy a channel ID in Discord:

1. Enable **Developer Mode** in Discord's Advanced settings.
2. Right-click the channel.
3. Select **Copy Channel ID**.

### Content options

| Setting | Type | Description |
|---|---|---|
| `copyAttachments` | Boolean | Enables or disables attachment downloading and uploading globally. |
| `copyLinks` | Boolean | Enables or disables copying URLs found in message text. |
| `filters.images` | Boolean | Includes image attachments, including common image formats such as GIF. |
| `filters.videos` | Boolean | Includes video attachments. |
| `filters.otherFiles` | Boolean | Includes attachments that are not classified as images or videos. |
| `filters.links` | Boolean | Includes messages containing HTTP or HTTPS URLs. |
| `maxAttachmentSizeMB` | Number | Maximum attachment size the bot attempts to download and upload, in MB. |

Set an individual filter to `false` to exclude that content type. A message is eligible if it contains at least one enabled content type.

`copyAttachments: false` disables all attachment transfers, regardless of the individual attachment filters. `copyLinks: false` disables link detection, regardless of `filters.links`.

The attachment size setting is a bot-side limit, not a way to override Discord's upload limits. Attachments that exceed the configured limit, or that cannot be downloaded, may be represented by their original URLs if the current implementation supports that fallback.

## What gets copied?

The bot is intended to copy messages that contain at least one eligible link or attachment.

| Source message | Expected result |
|---|---|
| Plain text only | Skipped |
| Text containing an HTTP/HTTPS URL | Copied when link filtering is enabled |
| Image attachment | Copied when image filtering is enabled |
| GIF attachment | Treated as an image when detected as `image/*` or by its `.gif` filename |
| Video attachment | Copied when video filtering is enabled |
| PDF, ZIP, or other attachment | Copied when other-file filtering is enabled |
| Text with an eligible attachment | Copied, including its text |
| Message with multiple eligible attachments | Eligible attachments are processed, subject to upload limits |

Some externally hosted GIFs and media are shared as links or embeds rather than file attachments. Their transfer depends on link handling and the URL being present in the message content or supported embed data.

## Migration behavior

This project performs a **one-time historical migration**:

1. The bot logs in to Discord.
2. It processes each entry in `channelMap`.
3. It fetches source-channel history in batches.
4. It processes messages in chronological order.
5. It skips messages that do not match the configured filters.
6. It sends eligible content to the mapped destination channel.
7. It records successful copies in SQLite.
8. It shuts down after all configured mappings finish.

It does not continuously monitor channels for new messages after the migration completes.

### Running the migration again

Run:

```bash
npm start
```

The SQLite database is retained between runs. Messages already recorded for a particular destination are skipped, while messages not yet recorded can be retried.

If you intentionally want to start completely fresh, stop the bot and delete `transfer.sqlite` from the project root before running it again. **This removes all migration records**, so previously copied messages may be copied again.

## Duplicate tracking with SQLite

The bot creates `transfer.sqlite` automatically when it runs. It stores the source message ID, destination channel ID, destination message ID, and copy timestamp.

The intended uniqueness rule is:

```sql
PRIMARY KEY (source_message_id, destination_channel_id)
```

This means:

- A source message is copied at most once to a given destination channel according to the database.
- The same source message can be copied to a different destination channel.
- Re-running a migration does not normally duplicate successfully recorded messages.

The database is local to the machine running the bot. Keep it if you want to preserve migration progress.

## Project structure

```text
discord-content-copy-bot/
├── src/
│   └── index.js
├── .env
├── .gitignore
├── config.json
├── package.json
├── package-lock.json
└── transfer.sqlite       # Generated automatically; do not commit
```

## Security

Never commit your Discord bot token.

Recommended `.gitignore`:

```gitignore
node_modules/
.env
transfer.sqlite
transfer.sqlite-shm
transfer.sqlite-wal
```

Channel IDs are identifiers, not authentication credentials. However, if you prefer not to disclose your server structure in a public repository, keep your real `config.json` private and commit a `config.example.json` containing placeholder IDs instead.

If a bot token is ever exposed, reset it in the Discord Developer Portal immediately and update your local `.env` file.

## Limitations and notes

- **No exact Discord message recreation:** The destination message is sent by the bot. Discord does not let a bot impersonate the original author or assign the original message timestamp to a newly sent message.
- **Attribution:** The implementation can include the original author's username and original timestamp as message text.
- **Timestamp display:** An ISO 8601 timestamp is unambiguous and uses UTC. A Discord timestamp such as `<t:UNIX_TIMESTAMP:F>` can display in each viewer's local timezone.
- **Edits and deletions:** The current one-time migration does not synchronize later source-message edits or deletions.
- **Reactions and threads:** These are not automatically recreated by the basic implementation.
- **Embeds:** Link previews may render differently in the destination. Embed content is not guaranteed to be reproduced exactly.
- **Attachment limits:** Discord's upload limits apply. Large files may need to be skipped or left as source links.
- **Rate limits:** Discord rate limits apply. Avoid adding aggressive parallel requests; process messages responsibly.
- **Large histories:** Fetching all pages into memory before processing can use substantial memory on large channels. A paginated, checkpointed implementation is recommended for very large migrations.
- **Partial failures:** SQLite records successful sends, but an interruption after Discord accepts a send and before the database record is saved can result in a duplicate on a later run.

## Troubleshooting

### `DISCORD_TOKEN is missing from .env`

Make sure `.env` exists in the project root and contains:

```dotenv
DISCORD_TOKEN=YOUR_BOT_TOKEN
```

Do not add spaces around the `=` or commit this file.

### The bot cannot access a channel

Check that the bot is in the relevant server and has **View Channel** and **Read Message History** permissions in the source, or **View Channel** and **Send Messages** permissions in the destination.

### Message content or links are missing

Verify that **Message Content Intent** is enabled in the Developer Portal and that the bot has the necessary channel permissions. Check the `copyLinks` and `filters.links` settings.

### Attachments are not copied

Check `copyAttachments`, the relevant filter (`images`, `videos`, or `otherFiles`), `maxAttachmentSizeMB`, and the destination bot's **Attach Files** permission. Some attachments may not expose a usable content type; filename detection is only a fallback.

### Messages are skipped on a later run

This is expected for messages already recorded in `transfer.sqlite` for that destination. Delete the database only if you intentionally want to discard all migration history and start fresh.

### The bot stops after migration

This is expected. The application is designed to exit after its one-time migration completes.

## Development

Install dependencies:

```bash
npm install
```

Run the bot:

```bash
npm start
```

The project uses:

- [Node.js](https://nodejs.org/)
- [discord.js](https://discord.js.org/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [dotenv](https://www.npmjs.com/package/dotenv)

## License

No license has been specified yet. Add a `LICENSE` file before presenting the repository as open source. If you intend others to use, modify, and redistribute the project, choose a license that matches those goals.
