const path = require('node:path');

module.exports = function createDiFrameworkTscPlugin(context) {
  return {
    name: '@di-framework/tsc',
    source: path.resolve(context.dirname, 'plugin'),
    stage: 'transform',
  };
};
