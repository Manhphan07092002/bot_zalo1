function buildQuoteListView({ mode, userId, keyword = '', isAdminUser, getRecentQuotes, getQuotesByUser, findQuotesByKeyword }) {
  let entries = [];
  let title = '';

  if (mode === 'recent') {
    entries = getRecentQuotes(500);
    title = 'Báo giá gần đây';
  } else if (mode === 'mine') {
    entries = getQuotesByUser(userId, 500);
    if (!entries.length && isAdminUser(userId)) entries = getRecentQuotes(500);
    title = 'Báo giá của tôi';
  } else {
    const results = findQuotesByKeyword(keyword, 500);
    entries = isAdminUser(userId)
      ? results
      : results.filter((entry) => String(entry.createdBy || '') === String(userId || ''));
    title = `Kết quả tìm cho: ${keyword}`;
  }

  return { entries, title };
}

module.exports = {
  buildQuoteListView
};
