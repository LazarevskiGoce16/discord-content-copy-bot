const { config } = require("../config");
const {
  linksEnabled,
  isAttachmentAllowed,
  getEmbeddedLinks,
} = require("./filters");

const maxAttachmentBytes =
  (config.maxAttachmentSizeMB ?? 10) * 1024 * 1024;

const downloadAttempts = 3;
const downloadTimeoutMs = 30_000;
const retryDelayMs = 500;

function truncate(text, maxLength = 2000) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries network errors, timeouts, rate limits and server errors.
// Other HTTP errors (e.g. 403/404 for an expired URL) fail immediately.
async function download(url) {
  let lastError;

  for (let attempt = 1; attempt <= downloadAttempts; attempt++) {
    if (attempt > 1) await sleep(retryDelayMs * (attempt - 1));

    let response;

    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(downloadTimeoutMs),
      });
    } catch (error) {
      lastError = error;
      continue;
    }

    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }

    lastError = new Error(`Download returned ${response.status}`);

    if (response.status !== 429 && response.status < 500) break;
  }

  throw lastError;
}

// Discord normalizes embed URLs (e.g. "https://a.com" becomes
// "https://a.com/"), so URLs are compared in their parsed form.
function normalizeUrl(url) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function getContentUrls(content) {
  return new Set(
    (content.match(/https?:\/\/[^\s<>]+/gi) ?? []).map(normalizeUrl)
  );
}

async function buildMessagePayload(message) {
  let content = message.content || "";

  // Include URLs from embeds that are not already in the text.
  if (linksEnabled()) {
    const contentUrls = getContentUrls(content);
    const embeddedLinks = [...new Set(getEmbeddedLinks(message))]
      .filter((url) => !contentUrls.has(normalizeUrl(url)));

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
      const buffer = await download(attachment.url);

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

module.exports = {
  truncate,
  buildMessagePayload,
};
