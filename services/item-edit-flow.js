const { formatEditableItemLine, shortenItemLabel } = require('./telegram-ui');

async function sendItemEditList({ bot, setPending, chatId, payload, mode, sourceLabel, action = 'edit' }) {
  const itemLines = (payload.items || []).map((item, index) => formatEditableItemLine(item, index)).join('\n\n');
  setPending(chatId, {
    type: action === 'delete' ? 'item-delete-select' : 'item-edit-select',
    payload,
    mode,
    sourceLabel
  });
  await bot.sendMessage(chatId, `Danh sách mặt hàng hiện tại:\n\n${itemLines || 'Chưa có mặt hàng.'}`, {
    reply_markup: {
      inline_keyboard: action === 'delete'
        ? [
            ...(payload.items || []).map((item, index) => ([{ text: `❌ D${index + 1} - ${shortenItemLabel(item?.description)}`, callback_data: `item:delete:${index}` }])),
            [{ text: '⬅️ Quay lại preview', callback_data: 'item:back:preview' }]
          ]
        : [
            ...(payload.items || []).map((item, index) => ([{ text: `✏️ D${index + 1} - ${shortenItemLabel(item?.description)}`, callback_data: `item:edit:${index}` }])),
            [
              { text: '➕ Thêm sản phẩm', callback_data: 'item:add' },
              { text: '⬅️ Quay lại preview', callback_data: 'item:back:preview' }
            ]
          ]
    }
  });
}

function buildAddItemQuestion(payload, pending) {
  return {
    type: 'question',
    payload,
    mode: pending.mode,
    sourceLabel: pending.sourceLabel,
    question: {
      kind: 'item.add.description',
      index: Array.isArray(payload.items) ? payload.items.length : 0,
      prompt: 'Anh gửi giúp em tên sản phẩm mới để em thêm dòng nhé.'
    }
  };
}

function buildItemEditFieldState(payload, pending, itemIndex) {
  return {
    type: 'item-edit-field',
    payload,
    mode: pending.mode,
    sourceLabel: pending.sourceLabel,
    itemIndex
  };
}

function buildItemEditFieldPrompt(payload, itemIndex) {
  const item = payload.items[itemIndex];
  return `Anh đang sửa dòng ${itemIndex + 1}:\n${formatEditableItemLine(item, itemIndex)}\n\nAnh muốn sửa gì?\n1. Tên sản phẩm\n2. Giá đầu vào\n3. Số lượng\n4. Đơn vị\n5. Xuất xứ`;
}

module.exports = {
  sendItemEditList,
  buildAddItemQuestion,
  buildItemEditFieldState,
  buildItemEditFieldPrompt
};
