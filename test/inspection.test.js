const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, api } = require("./helpers");

let seq = 0;
// 每个用例使用不同的 孔数+纸型 组合，避免方案唯一性冲突
function combo() {
  seq += 1;
  return { holeCount: 1000 + seq, paperType: `测试纸-${seq}` };
}

async function createPlan(base, fields) {
  const res = await api(base, "POST", "/inspection-plans", {
    sampleSize: 2,
    majorAllowed: 1,
    minorAllowed: 2,
    ...fields
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function createBatch(base, fields) {
  const res = await api(base, "POST", "/inspection-batches", fields);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function getBatch(base, id) {
  const res = await api(base, "GET", `/inspection-batches/${id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}

async function addSample(base, batchId, sampleNo, defects = []) {
  return api(base, "POST", `/inspection-batches/${batchId}/samples`, { sampleNo, defects });
}

test("方案按孔数+纸型唯一匹配，重复组合被拒绝", async (t) => {
  const { base } = await startApp(t);
  const c = combo();

  const plan = await createPlan(base, { ...c, name: "常规" });
  assert.equal(plan.version, 1);
  assert.equal(plan.sampleSize, 2);

  const dup = await api(base, "POST", "/inspection-plans", { ...c, sampleSize: 3, majorAllowed: 0, minorAllowed: 0 });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /已存在/);

  // 无匹配方案的批次不能创建
  const noPlan = await api(base, "POST", "/inspection-batches", { holeCount: 999999, paperType: "不存在的纸" });
  assert.equal(noPlan.status, 400);
  assert.match(noPlan.body.error, /检验方案/);

  // 非法方案字段
  const bad = await api(base, "POST", "/inspection-plans", { ...combo(), sampleSize: 0, majorAllowed: 0, minorAllowed: 0 });
  assert.equal(bad.status, 400);
});

test("开始登记样本后方案冻结，方案切换只影响未冻结批次", async (t) => {
  const { base } = await startApp(t);
  const c = combo();
  const plan = await createPlan(base, { ...c, sampleSize: 2, majorAllowed: 0, minorAllowed: 5 });

  const batch = await createBatch(base, c);
  assert.equal(batch.planSnapshot, null);
  assert.equal(batch.effectivePlan.version, 1);

  // 登记前切换方案 → 批次跟随新方案
  const v2 = await api(base, "PUT", `/inspection-plans/${plan.id}`, { sampleSize: 3, majorAllowed: 1 });
  assert.equal(v2.status, 200);
  assert.equal(v2.body.data.version, 2);
  const before = await getBatch(base, batch.id);
  assert.equal(before.planSnapshot, null);
  assert.equal(before.effectivePlan.version, 2);
  assert.equal(before.effectivePlan.sampleSize, 3);

  // 首个样本登记 → 冻结当前方案快照（v2）
  const s1 = await addSample(base, batch.id, "S-1");
  assert.equal(s1.status, 201);
  assert.equal(s1.body.data.batch.planSnapshot.version, 2);
  assert.equal(s1.body.data.batch.planSnapshot.sampleSize, 3);

  // 冻结后再切换方案 → 已冻结批次不受影响
  const v3 = await api(base, "PUT", `/inspection-plans/${plan.id}`, { sampleSize: 9, majorAllowed: 9 });
  assert.equal(v3.body.data.version, 3);

  await addSample(base, batch.id, "S-2", [{ severity: "major", count: 1 }]);
  const s3 = await addSample(base, batch.id, "S-3");
  assert.equal(s3.status, 201);
  const judged = s3.body.data.batch;
  // 按冻结的 v2（sampleSize=3）判定，而不是 v3（sampleSize=9）
  assert.equal(judged.status, "judged");
  assert.equal(judged.verdict.planVersion, 2);
  assert.equal(judged.verdict.result, "accepted"); // 主要缺陷 1 ≤ 允收 1
  assert.equal(judged.planSnapshot.sampleSize, 3);

  // 新建批次使用切换后的 v3
  const batch2 = await createBatch(base, c);
  assert.equal(batch2.effectivePlan.version, 3);
  assert.equal(batch2.effectivePlan.sampleSize, 9);

  // 方案匹配条件不可修改
  const badPut = await api(base, "PUT", `/inspection-plans/${plan.id}`, { holeCount: 12345 });
  assert.equal(badPut.status, 400);
});

test("致命缺陷直接否决，主要/次要按允收数判定", async (t) => {
  const { base } = await startApp(t);

  // 致命：即使主要/次要都在允收范围内也直接否决
  const c1 = combo();
  await createPlan(base, { ...c1, sampleSize: 1, majorAllowed: 5, minorAllowed: 5 });
  const b1 = await createBatch(base, c1);
  const r1 = await addSample(base, b1.id, "S-1", [
    { severity: "致命" },
    { severity: "次要", count: 1 }
  ]);
  assert.equal(r1.body.data.batch.status, "judged");
  assert.equal(r1.body.data.batch.verdict.result, "rejected");
  assert.ok(r1.body.data.batch.verdict.reasons.some((r) => r.includes("致命")));

  // 主要缺陷超允收 → 否决
  const c2 = combo();
  await createPlan(base, { ...c2, sampleSize: 2, majorAllowed: 1, minorAllowed: 9 });
  const b2 = await createBatch(base, c2);
  await addSample(base, b2.id, "S-1", [{ severity: "主要", count: 1 }]);
  const r2 = await addSample(base, b2.id, "S-2", [{ severity: "major", count: 1 }]);
  assert.equal(r2.body.data.batch.verdict.result, "rejected");
  assert.ok(r2.body.data.batch.verdict.reasons.some((r) => r.includes("主要")));

  // 次要缺陷超允收 → 否决
  const c3 = combo();
  await createPlan(base, { ...c3, sampleSize: 1, majorAllowed: 1, minorAllowed: 1 });
  const b3 = await createBatch(base, c3);
  const r3 = await addSample(base, b3.id, "S-1", [{ severity: "minor", count: 2 }]);
  assert.equal(r3.body.data.batch.verdict.result, "rejected");
  assert.ok(r3.body.data.batch.verdict.reasons.some((r) => r.includes("次要")));

  // 全部在允收范围内 → 合格
  const c4 = combo();
  await createPlan(base, { ...c4, sampleSize: 2, majorAllowed: 1, minorAllowed: 2 });
  const b4 = await createBatch(base, c4);
  await addSample(base, b4.id, "S-1", [{ severity: "major" }, { severity: "minor", count: 2 }]);
  const r4 = await addSample(base, b4.id, "S-2");
  assert.equal(r4.body.data.batch.verdict.result, "accepted");
  assert.equal(r4.body.data.batch.verdict.label, "合格");
  assert.deepEqual(r4.body.data.batch.verdict.tallies, { critical: 0, major: 1, minor: 2 });

  // 非法缺陷等级
  const c5 = combo();
  await createPlan(base, { ...c5, sampleSize: 1 });
  const b5 = await createBatch(base, c5);
  const bad = await addSample(base, b5.id, "S-1", [{ severity: "严重" }]);
  assert.equal(bad.status, 400);
});

test("样本带编号唯一，重复提交返回原结果（含并发重复）", async (t) => {
  const { base } = await startApp(t);
  const c = combo();
  await createPlan(base, { ...c, sampleSize: 5, majorAllowed: 9, minorAllowed: 9 });
  const batch = await createBatch(base, c);

  const first = await addSample(base, batch.id, "S-1", [{ severity: "minor", count: 1 }]);
  assert.equal(first.status, 201);
  assert.equal(first.body.data.duplicated, false);

  // 重复提交（即使缺陷内容不同）返回原结果，不产生新样本
  const again = await addSample(base, batch.id, "S-1", [{ severity: "critical", count: 9 }]);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.duplicated, true);
  assert.equal(again.body.data.sample.id, first.body.data.sample.id);
  assert.deepEqual(again.body.data.batch.tallies, { critical: 0, major: 0, minor: 1 });

  // 并发提交同一编号 → 只有一个样本落库
  const results = await Promise.all(
    Array.from({ length: 5 }, () => addSample(base, batch.id, "S-dup", []))
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200 && r.body.data.duplicated).length, 4);
  const ids = new Set(results.map((r) => r.body.data.sample.id));
  assert.equal(ids.size, 1);

  const detail = await getBatch(base, batch.id);
  assert.equal(detail.samples.length, 2);
});

test("撤回样本后按剩余样本重算，已判定批次不能撤回", async (t) => {
  const { base } = await startApp(t);
  const c = combo();
  await createPlan(base, { ...c, sampleSize: 3, majorAllowed: 1, minorAllowed: 5 });
  const batch = await createBatch(base, c);

  const s1 = (await addSample(base, batch.id, "S-1", [{ severity: "major", count: 1 }])).body.data.sample;
  await addSample(base, batch.id, "S-2", [{ severity: "minor", count: 2 }]);
  let detail = await getBatch(base, batch.id);
  assert.deepEqual(detail.tallies, { critical: 0, major: 1, minor: 2 });

  // 撤回 S-1 → 统计按剩余样本重算
  const wd = await api(base, "POST", `/inspection-batches/${batch.id}/samples/${s1.id}/withdraw`);
  assert.equal(wd.status, 200);
  assert.equal(wd.body.data.sample.status, "withdrawn");
  assert.deepEqual(wd.body.data.batch.tallies, { critical: 0, major: 0, minor: 2 });
  assert.equal(wd.body.data.batch.activeSampleCount, 1);
  assert.equal(wd.body.data.batch.status, "sampling");

  // 重复撤回 / 撤回不存在样本
  const again = await api(base, "POST", `/inspection-batches/${batch.id}/samples/${s1.id}/withdraw`);
  assert.equal(again.status, 409);
  const missing = await api(base, "POST", `/inspection-batches/${batch.id}/samples/sample_none/withdraw`);
  assert.equal(missing.status, 404);

  // 补足样本后判定：major 0 ≤ 1，minor 3 ≤ 5 → 合格
  await addSample(base, batch.id, "S-3", [{ severity: "minor", count: 1 }]);
  const s4 = await addSample(base, batch.id, "S-4");
  const judged = s4.body.data.batch;
  assert.equal(judged.status, "judged");
  assert.equal(judged.verdict.result, "accepted");
  assert.deepEqual(judged.verdict.tallies, { critical: 0, major: 0, minor: 3 });

  // 已判定批次不能撤回，也不能再登记新样本
  const s4id = s4.body.data.sample.id;
  const late = await api(base, "POST", `/inspection-batches/${batch.id}/samples/${s4id}/withdraw`);
  assert.equal(late.status, 409);
  assert.match(late.body.error, /已判定/);
  const more = await addSample(base, batch.id, "S-5");
  assert.equal(more.status, 409);

  // 已判定后重复提交原样本编号仍返回原结果
  const dup = await addSample(base, batch.id, "S-4");
  assert.equal(dup.status, 200);
  assert.equal(dup.body.data.duplicated, true);
});

test("同一批并发提交最终样本只生成一份判定", async (t) => {
  const { base } = await startApp(t);
  const c = combo();
  await createPlan(base, { ...c, sampleSize: 2, majorAllowed: 0, minorAllowed: 0 });
  const batch = await createBatch(base, c);
  await addSample(base, batch.id, "S-1");

  // 5 个并发请求争抢“最终样本”
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => addSample(base, batch.id, `S-${i + 2}`))
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 4);

  const detail = await getBatch(base, batch.id);
  assert.equal(detail.status, "judged");
  assert.equal(detail.samples.length, 2);
  assert.equal(detail.activeSampleCount, 2);
  assert.ok(detail.verdict);
  assert.equal(detail.verdict.result, "accepted");
  assert.equal(detail.verdict.sampleCount, 2);
});

test("写入失败不留半批：样本、快照、判定都不落库", async (t) => {
  const { base, storage } = await startApp(t);
  const c = combo();
  await createPlan(base, { ...c, sampleSize: 2, majorAllowed: 0, minorAllowed: 0 });
  const batch = await createBatch(base, c);

  // 首个样本写入失败 → 方案快照也不应冻结
  storage.failNextWrites(1);
  const fail1 = await addSample(base, batch.id, "S-1");
  assert.equal(fail1.status, 500);
  let detail = await getBatch(base, batch.id);
  assert.equal(detail.samples.length, 0);
  assert.equal(detail.planSnapshot, null);
  assert.equal(detail.status, "sampling");

  // 恢复后重试成功
  const ok1 = await addSample(base, batch.id, "S-1");
  assert.equal(ok1.status, 201);
  assert.ok(ok1.body.data.batch.planSnapshot);

  // 最终样本（触发判定）写入失败 → 判定和样本都不落库
  storage.failNextWrites(1);
  const fail2 = await addSample(base, batch.id, "S-2", [{ severity: "critical" }]);
  assert.equal(fail2.status, 500);
  detail = await getBatch(base, batch.id);
  assert.equal(detail.samples.length, 1);
  assert.equal(detail.verdict, null);
  assert.equal(detail.status, "sampling");

  // 恢复后重试 → 正常判定
  const ok2 = await addSample(base, batch.id, "S-2", [{ severity: "critical" }]);
  assert.equal(ok2.status, 201);
  assert.equal(ok2.body.data.batch.status, "judged");
  assert.equal(ok2.body.data.batch.verdict.result, "rejected");
});

test("重启后批次、样本和判定保持一致", async (t) => {
  const first = await startApp(t);
  const c = combo();
  await createPlan(first.base, { ...c, sampleSize: 1, majorAllowed: 0, minorAllowed: 0 });
  const batch = await createBatch(first.base, { ...c, batchNo: "LOT-RESTART" });
  const judged = await addSample(first.base, batch.id, "S-1", [{ severity: "major", count: 2 }]);
  assert.equal(judged.body.data.batch.verdict.result, "rejected");
  await new Promise((resolve) => first.server.close(resolve));

  // 用同一库文件重新启动（模拟进程重启）
  const second = await startApp(t, { dbFile: first.dbFile });
  const detail = await getBatch(second.base, batch.id);
  assert.equal(detail.batchNo, "LOT-RESTART");
  assert.equal(detail.status, "judged");
  assert.equal(detail.verdict.result, "rejected");
  assert.deepEqual(detail.verdict.tallies, { critical: 0, major: 2, minor: 0 });
  assert.equal(detail.planSnapshot.sampleSize, 1);
  assert.equal(detail.samples.length, 1);
  assert.equal(detail.samples[0].sampleNo, "S-1");

  const list = await api(second.base, "GET", "/inspection-batches");
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].verdict.result, "rejected");

  // 原接口数据也完好
  const tunes = await api(second.base, "GET", "/tunes");
  assert.equal(tunes.status, 200);
  assert.ok(tunes.body.data.length >= 1);
});
