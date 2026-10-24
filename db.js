const users = [];
const wallets = [];

let lastUserId = 0;
let lastWalletId = 0;

function newUserId() {
  lastUserId = lastUserId + 1;
  return lastUserId;
}

function newWalletId() {
  lastWalletId = lastWalletId + 1;
  return lastWalletId;
}

module.exports = {
  users,
  wallets,
  newUserId,
  newWalletId
};