const pendingByChat = new Map();

function setPending(chatId, data) {
  pendingByChat.set(String(chatId), {
    ...data,
    updatedAt: Date.now()
  });
}

function getPending(chatId) {
  return pendingByChat.get(String(chatId)) || null;
}

function clearPending(chatId) {
  pendingByChat.delete(String(chatId));
}

module.exports = {
  setPending,
  getPending,
  clearPending
};
