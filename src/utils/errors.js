const { DiscordAPIError, RESTJSONErrorCodes } = require("discord.js");

// Discord rejects these requests no matter how often they are retried
// (e.g. 400 invalid form body, 413 request entity too large).
function isPermanentSendError(error) {
  return error instanceof DiscordAPIError
    && (error.status === 400 || error.status === 413);
}

function isUnknownMessageError(error) {
  return error?.code === RESTJSONErrorCodes.UnknownMessage
    || error?.status === 404;
}

module.exports = {
  isPermanentSendError,
  isUnknownMessageError,
};
