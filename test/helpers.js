const http = require("http");
const path = require("path");
const { mkdtemp } = require("fs/promises");
const { tmpdir } = require("os");
const { createApp } = require("../src/app");
const { createJsonFileStorage } = require("../src/store");

// 包装存储，可注入“下一次写失败”，用于验证失败恢复
function withFailureInjection(storage) {
  let pendingFailures = 0;
  return {
    file: storage.file,
    read: (...args) => storage.read(...args),
    async write(data) {
      if (pendingFailures > 0) {
        pendingFailures -= 1;
        throw new Error("模拟写入失败");
      }
      return storage.write(data);
    },
    failNextWrites(count = 1) {
      pendingFailures += count;
    }
  };
}

// 启动一个真实 HTTP 服务（独立临时库文件，端口随机）
async function startApp(t, { dbFile } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "strip-qc-"));
  const file = dbFile || path.join(dir, "db.json");
  const storage = withFailureInjection(createJsonFileStorage(file));
  const app = createApp({ storage });
  await app.ready;
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    server,
    storage,
    dbFile: file,
    base: `http://127.0.0.1:${server.address().port}`
  };
}

async function api(base, method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

module.exports = { startApp, api };
