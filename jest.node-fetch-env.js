/* eslint-disable @typescript-eslint/no-var-requires */
// jest 27 的 node 环境不带 Node 18+ 的全局 fetch 家族；测 Response / NextRequest 的用例用这个环境
// 用法：测试文件顶部 docblock `@jest-environment <rootDir>/jest.node-fetch-env.js`
const NodeEnvironment = require('jest-environment-node');

class NodeFetchEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const name of ['fetch', 'Request', 'Response', 'Headers', 'FormData', 'AbortSignal', 'AbortController']) {
      this.global[name] = globalThis[name];
    }
  }
}

module.exports = NodeFetchEnvironment;
