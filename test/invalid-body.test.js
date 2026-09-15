const test = require("node:test");
const assert = require("node:assert/strict");
const { readFile } = require("fs/promises");
const { startApp, api } = require("./helpers");

// 反例：抽检接口收到 JSON null 等非对象请求体时，必须返回定位清楚的参数错误（400），
// 且不得写入任何数据；正常流程不得回退。
test("空请求根值（JSON null 等）返回参数错误且原数据不变", async (t) => {
  const { base, dbFile } = await startApp(t);

  // 准备正常数据：方案 + 批次 + 已冻结快照 + 一个样本
  const plan = (
    await api(base, "POST", "/inspection-plans", {
      holeCount: 7001,
      paperType: "反例纸",
      sampleSize: 2,
      majorAllowed: 1,
      minorAllowed: 1
    })
  ).body.data;
  const batch = (
    await api(base, "POST", "/inspection-batches", {
      holeCount: 7001,
      paperType: "反例纸",
      batchNo: "LOT-NULL"
    })
  ).body.data;
  const s1 = await api(base, "POST", `/inspection-batches/${batch.id}/samples`, {
    sampleNo: "S-1",
    defects: [{ severity: "minor", count: 1 }]
  });
  assert.equal(s1.status, 201);
  assert.ok(s1.body.data.batch.planSnapshot);

  const fileBefore = await readFile(dbFile, "utf8");

  const endpoints = [
    ["POST", "/inspection-plans"],
    ["POST", "/inspection-batches"],
    ["PUT", `/inspection-plans/${plan.id}`],
    ["POST", `/inspection-batches/${batch.id}/samples`]
  ];

  // JSON null → 400 参数错误（修复前为 500 内部错误）
  for (const [method, path] of endpoints) {
    const res = await api(base, method, path, null);
    assert.equal(res.status, 400, `${method} ${path}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, /JSON对象/);
    assert.match(res.body.error, /null/);
  }

  // 其他非对象根值（数组/字符串/数字/布尔）同样返回定位清楚的 400
  for (const [method, path] of endpoints) {
    for (const bad of [[1, 2], "abc", 42, true]) {
      const res = await api(base, method, path, bad);
      assert.equal(res.status, 400, `${method} ${path} body=${JSON.stringify(bad)}`);
      assert.match(res.body.error, /JSON对象/);
    }
  }

  // 非法 JSON 文本 → 400
  const malformed = await fetch(`${base}/inspection-batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json"
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /合法JSON/);

  // 被拒请求没有写入任何数据：库文件逐字节一致
  assert.equal(await readFile(dbFile, "utf8"), fileBefore);

  // 原批次、样本、方案保持不变
  const detail = await api(base, "GET", `/inspection-batches/${batch.id}`);
  assert.equal(detail.body.data.samples.length, 1);
  assert.equal(detail.body.data.status, "sampling");
  assert.equal(detail.body.data.verdict, null);
  assert.equal(detail.body.data.planSnapshot.version, 1);
  assert.deepEqual(detail.body.data.tallies, { critical: 0, major: 0, minor: 1 });
  const plans = await api(base, "GET", "/inspection-plans");
  const kept = plans.body.data.filter((item) => item.id === plan.id);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].version, 1);

  // 回归：正常流程不受影响 —— 方案可切换、样本可登记、判定正常生成
  const put = await api(base, "PUT", `/inspection-plans/${plan.id}`, { minorAllowed: 5 });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.version, 2);

  // 批次已冻结 v1（minorAllowed=1），S-2 带 2 条次要 → 超允收 → 否决
  const s2 = await api(base, "POST", `/inspection-batches/${batch.id}/samples`, {
    sampleNo: "S-2",
    defects: [{ severity: "minor", count: 2 }]
  });
  assert.equal(s2.status, 201);
  assert.equal(s2.body.data.batch.status, "judged");
  assert.equal(s2.body.data.batch.verdict.result, "rejected");
  assert.equal(s2.body.data.batch.verdict.planVersion, 1);

  // 已判定批次收到 null 仍是 400，判定与样本保持不变
  const lateNull = await api(base, "POST", `/inspection-batches/${batch.id}/samples`, null);
  assert.equal(lateNull.status, 400);
  const finalDetail = await api(base, "GET", `/inspection-batches/${batch.id}`);
  assert.equal(finalDetail.body.data.verdict.result, "rejected");
  assert.equal(finalDetail.body.data.samples.length, 2);

  // 原有接口同样拒绝 null（不再 500），且正常行为不变
  const tuneNull = await api(base, "POST", "/tunes", null);
  assert.equal(tuneNull.status, 400);
  const health = await api(base, "GET", "/health");
  assert.equal(health.body.ok, true);
  const tunes = await api(base, "GET", "/tunes");
  assert.equal(tunes.status, 200);
  assert.ok(tunes.body.data.length >= 1);
});
