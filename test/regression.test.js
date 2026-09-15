const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, api } = require("./helpers");

// 原有接口回归：行为与重构前保持一致
test("原接口回归：曲目/区间/问题闭环不变", async (t) => {
  const { base } = await startApp(t);

  const health = await api(base, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.ok(health.body.routes.includes("POST /inspection-batches/:id/samples"));

  // 演示数据 + 进度
  const tunes = await api(base, "GET", "/tunes");
  assert.equal(tunes.status, 200);
  const demo = tunes.body.data.find((item) => item.id === "tune_demo");
  assert.ok(demo);
  assert.equal(demo.progress.totalSections, 2);
  assert.equal(demo.progress.percent, 50);

  const progress = await api(base, "GET", "/tunes/tune_demo/progress");
  assert.equal(progress.body.data.openIssues, 1);

  // 新建曲目
  const created = await api(base, "POST", "/tunes", {
    title: "测试曲",
    composer: "某人",
    stripSpec: { widthMm: 70, scale: "20音", tempoBpm: 90, paperType: "牛皮纸" }
  });
  assert.equal(created.status, 201);
  const tuneId = created.body.data.id;

  // 区间登记与勾选
  const section = await api(base, "POST", `/tunes/${tuneId}/sections`, {
    startBeat: 1,
    endBeat: 16,
    laneRange: "1-8"
  });
  assert.equal(section.status, 201);
  const unchecked = await api(base, "GET", `/tunes/${tuneId}/unchecked-sections`);
  assert.equal(unchecked.body.data.length, 1);
  const check = await api(base, "PATCH", `/sections/${section.body.data.id}/check`, { checked: true });
  assert.equal(check.body.data.checked, true);
  const unchecked2 = await api(base, "GET", `/tunes/${tuneId}/unchecked-sections`);
  assert.equal(unchecked2.body.data.length, 0);

  // 问题登记与关闭
  const issue = await api(base, "POST", "/issues", {
    tuneId,
    sectionId: section.body.data.id,
    type: "错孔",
    beat: 5,
    lane: 3,
    description: "第5拍第3轨错孔"
  });
  assert.equal(issue.status, 201);
  const resolved = await api(base, "PATCH", `/issues/${issue.body.data.id}/status`, { status: "resolved" });
  assert.equal(resolved.body.data.status, "resolved");
  assert.ok(resolved.body.data.resolvedAt);
  const open = await api(base, "GET", "/issues?tuneId=" + tuneId + "&status=open");
  assert.equal(open.body.data.length, 0);

  // 404 行为
  const noTune = await api(base, "GET", "/tunes/tune_none/progress");
  assert.equal(noTune.status, 404);
  const noRoute = await api(base, "GET", "/no-such-route");
  assert.equal(noRoute.status, 404);
  assert.ok(noRoute.body.routes);
});
