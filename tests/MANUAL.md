# Manual test checklist

`npm test` covers the logic with fake Discord channels. This checklist covers what only real Discord can confirm: permissions, upload limits, intents, and how edits and deletions actually arrive.

Run `npm test` first; there is no point testing by hand while it fails.

## Setup

Use a separate test server so nothing touches real channels or the real database.

1. Create a test server and invite the bot with the permissions from the README.
2. Create these channels:

   | Channel | Purpose |
   |---|---|
   | `src-a` | Source, mapped to `dst-a` |
   | `src-b` | Source, mapped to `dst-b` |
   | `dst-a`, `dst-b` | Destinations |

3. Post about 20 messages in `src-a` from a normal (non-bot) account; the bot never copies bot messages, so they cannot be seeded by a script. Include plain text, links, images, a GIF, a video, a PDF, and one file larger than `maxAttachmentSizeMB`. Paging across many messages is already covered by `npm test`. Post a few links in `src-b` too.
4. Create `config.test.json` from `config.example.json` with the test channel IDs.
5. Run the bot against the test config and a test database (PowerShell):

   ```powershell
   $env:CONFIG_PATH = "config.test.json"
   $env:DATABASE_PATH = "test.sqlite"
   npm start
   ```

   To start a section from a clean state, stop the bot, delete `test.sqlite` and clear the destination channels.

## 1. Migration mode

Config: `"mode": "migration"`, `history.enabled: true`.

| # | Action | Expected |
|---|---|---|
| 1.1 | Run the bot | Both mappings copied oldest-first; plain-text messages skipped; log ends with `Historical migration completed.`; process exits |
| 1.2 | Check the exit code (`$LASTEXITCODE`) | `0` |
| 1.3 | Run again without changes | `Recovering messages after …`, `Processed 0 messages`; nothing new in destinations |
| 1.4 | Post 3 new link messages in `src-a`, run again | Only those 3 copied, after the earlier copies |
| 1.5 | Fresh state. Start the bot and press Ctrl+C partway through `src-a` | Partial copy in `dst-a` |
| 1.6 | Run again | Continues from where it stopped; no duplicates, no gaps. At most one duplicate if Ctrl+C landed between send and record (see README *Limitations*) |
| 1.7 | Change `src-b`'s destination to a channel ID that does not exist, run | `src-a` still completes; `Historical migration incomplete for: <src-b>`; exit code `1` |

## 2. Permissions

Restore the valid config. Change one permission at a time on the channel, run, then restore it.

| # | Change | Expected |
|---|---|---|
| 2.1 | Deny **Read Message History** on `src-a` | `Missing View Channels or Read Message History in source: <src-a>`; `src-b` still runs; exit code `1` |
| 2.2 | Deny **Send Messages** on `dst-a` | `Missing destination permissions`; `src-a` stops at the first eligible message |
| 2.3 | Deny **Attach Files** on `dst-a` | Link-only messages copy; stops with `Missing Attach Files permission in destination` at the first message with a file |
| 2.4 | Restore the permission and run again | Resumes from the message that failed |
| 2.5 | Disable **Message Content Intent** in the Developer Portal, run | Login refused: `Could not log in to Discord: Used disallowed intents` plus a hint to enable the intent; exit code `1`. Re-enable it afterwards |

## 3. Content and attachments

Check these in `dst-a` after a full run.

| # | Source message | Expected copy |
|---|---|---|
| 3.1 | Any copied message | Starts with `**<username> (copied)**` and the original UTC date |
| 3.2 | Image, GIF, video, PDF | Re-uploaded as files, not links |
| 3.3 | File larger than `maxAttachmentSizeMB` | Posted under **Original attachment links** |
| 3.4 | Several files that together exceed the destination's upload limit but are each under `maxAttachmentSizeMB` | `Skipping message …; Discord rejected it permanently`; history continues past it. Needs a source server with a higher upload limit (boosted) than the destination; on equal servers Discord stops the user from posting such a message, and `npm test` covers it |
| 3.5 | Message mentioning `@everyone` or a user | Mention text copied, nobody pinged |
| 3.6 | Message of 1,950+ characters with a link (the attribution adds about 80) | Copy cut to 2,000 characters ending in `...`. Discord turns very long pastes into `message.txt`, which is copied as a file instead |
| 3.7 | Set `filters.videos: false`, fresh state, run | Video-only messages skipped; a message with an image and a video copies only the image |

## 4. Synchronization mode

Config: `"mode": "synchronization"`, `history.enabled: true`, all `liveSync` options `true`. Leave the bot running.

| # | Action | Expected |
|---|---|---|
| 4.1 | Start the bot | History catches up, then `The bot will remain online.` |
| 4.2 | Post a link in `src-a` | Copied within a few seconds |
| 4.3 | Wait for Discord to add the link preview | Copy is **not** marked `(edited)` |
| 4.4 | Edit the message's text, keeping a link | Copy updated |
| 4.5 | Edit twice within a second | Copy shows the second edit |
| 4.6 | Edit to remove the only link | Copy deleted |
| 4.7 | Post plain text, then edit it to add a link | Copy created at the end of `dst-a` |
| 4.8 | Delete a source message | Copy deleted |
| 4.9 | Bulk-delete several source messages (for example with a moderation bot's purge command) | All their copies deleted |
| 4.10 | Delete a copy by hand in `dst-a`, edit its source, edit it again, then restart the bot | Log `was deleted by hand; it will not be re-created.` once; the second edit and the restart do not re-create the copy |
| 4.11 | Post an image with a message | File re-uploaded in the copy |
| 4.12 | Stop the bot, post 2 links in `src-a`, start it again | Both copied during startup catch-up |
| 4.13 | Stop the bot, edit or delete a copied source message, start it again | Not synchronized (documented limitation) |
| 4.14 | Have another bot post a link in `src-a` | Not copied |

## Results

| Section | Date | Tester | Pass/Fail | Notes |
|---|---|---|---|---|
| 1. Migration | | | | |
| 2. Permissions | | | | |
| 3. Content | | | | |
| 4. Synchronization | | | | |
