// Generated by Alibaba Node.js PGO
const pgo = require('./pgoCommonUtils.js');
pgo.start();
const originModule = require('./index_pgo_origin.js');
Object.assign(exports, originModule);
exports.initializer = async (context, callback) => {
  const originCallback = callback;
  callback = (...args) => {
    pgo.end();
    originCallback(...args);
  }
  originModule['initializer'](context, callback);
};