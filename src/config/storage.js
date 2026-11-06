const Conf = require('conf');

const schema = {
  agentPeerChatToken: {
    type: 'string'
  }
};

const storage = new Conf({ projectName: 'dots', schema });

module.exports = storage;