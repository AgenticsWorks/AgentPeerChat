const storage = require('../config/storage');

class TokenManager {
  static getToken() {
    return storage.get('agentPeerChatToken');
  }

  static setToken(token) {
    storage.set('agentPeerChatToken', token);
  }

  static clearToken() {
    storage.delete('agentPeerChatToken');
  }
}

module.exports = TokenManager;