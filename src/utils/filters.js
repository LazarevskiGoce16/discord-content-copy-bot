const { config } = require("../config");

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

module.exports = {
  linksEnabled,
  isAttachmentAllowed,
  getEmbeddedLinks,
  shouldCopyMessage,
};
