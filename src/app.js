const path = require("path");
const { normalizeDb, createJsonFileStorage } = require("./store");
const {
  fail,
  toInteger,
  toCleanString,
  validatePlanFields,
  matchPlan,
  snapshotPlan,
  normalizeDefects,
  tallyDefects,
  computeVerdict,
  viewBatch
} = require("./inspection");

const DEFAULT_DB_FILE = path.join(__dirname, "..", "data", "db.json");

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /inspection-plans",
  "POST /inspection-plans",
  "PUT /inspection-plans/:id",
  "GET /inspection-batches",
  "POST /inspection-batches",
  "GET /inspection-batches/:id",
  "POST /inspection-batches/:id/samples",
  "POST /inspection-batches/:id/samples/:sampleId/withdraw"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    fail(400, "请求体必须是合法JSON");
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) fail(400, `缺少字段：${missing.join(", ")}`);
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) fail(404, "曲目不存在");
  return tune;
}

function findBatch(db, batchId) {
  const batch = db.inspectionBatches.find((item) => item.id === batchId);
  if (!batch) fail(404, "批次不存在");
  return batch;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

// createApp({ dbFile?, storage? }) → { handler, storage, ready }
// 所有请求经同一条 promise 链串行执行；写操作先在草稿副本上改，
// 落库成功才替换内存状态——写入失败不会留下半批数据。
function createApp(options = {}) {
  const storage = options.storage || createJsonFileStorage(options.dbFile || DEFAULT_DB_FILE);
  let cache = null;
  let chain = Promise.resolve();

  function enqueue(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  async function load() {
    if (!cache) cache = normalizeDb(await storage.read());
    return cache;
  }

  function readState(fn) {
    return enqueue(async () => fn(await load()));
  }

  function transact(fn) {
    return enqueue(async () => {
      const current = await load();
      const draft = JSON.parse(JSON.stringify(current));
      const result = await fn(draft);
      await storage.write(draft);
      cache = draft;
      return result;
    });
  }

  async function handle(req, res) {
    const { pathname, searchParams } = parseUrl(req);

    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
    }

    // ---------- 原有接口（保持不变） ----------

    if (req.method === "GET" && pathname === "/tunes") {
      const [status, payload] = await readState((db) => [
        200,
        { data: db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) })) }
      ]);
      return send(res, status, payload);
    }

    if (req.method === "POST" && pathname === "/tunes") {
      const body = await parseBody(req);
      required(body, ["title", "stripSpec"]);
      const [status, payload] = await transact((db) => {
        const tune = {
          id: makeId("tune"),
          title: body.title,
          composer: body.composer || "",
          stripSpec: body.stripSpec,
          createdAt: new Date().toISOString()
        };
        db.tunes.push(tune);
        return [201, { data: tune }];
      });
      return send(res, status, payload);
    }

    const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
    if (tuneSectionsMatch && req.method === "GET") {
      const tuneId = tuneSectionsMatch[1];
      const [status, payload] = await readState((db) => {
        findTune(db, tuneId);
        return [200, { data: db.sections.filter((item) => item.tuneId === tuneId) }];
      });
      return send(res, status, payload);
    }

    if (tuneSectionsMatch && req.method === "POST") {
      const tuneId = tuneSectionsMatch[1];
      const body = await parseBody(req);
      required(body, ["startBeat", "endBeat", "laneRange"]);
      const [status, payload] = await transact((db) => {
        findTune(db, tuneId);
        const section = {
          id: makeId("section"),
          tuneId,
          startBeat: Number(body.startBeat),
          endBeat: Number(body.endBeat),
          laneRange: body.laneRange,
          checked: Boolean(body.checked),
          note: body.note || ""
        };
        db.sections.push(section);
        return [201, { data: section }];
      });
      return send(res, status, payload);
    }

    const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
    if (uncheckedMatch && req.method === "GET") {
      const tuneId = uncheckedMatch[1];
      const [status, payload] = await readState((db) => {
        findTune(db, tuneId);
        return [200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) }];
      });
      return send(res, status, payload);
    }

    const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
    if (progressMatch && req.method === "GET") {
      const [status, payload] = await readState((db) => [200, { data: buildProgress(db, progressMatch[1]) }]);
      return send(res, status, payload);
    }

    const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
    if (checkMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const [status, payload] = await transact((db) => {
        const section = db.sections.find((item) => item.id === checkMatch[1]);
        if (!section) return [404, { error: "区间不存在" }];
        section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
        section.note = body.note ?? section.note;
        return [200, { data: section }];
      });
      return send(res, status, payload);
    }

    if (req.method === "GET" && pathname === "/issues") {
      const tuneId = searchParams.get("tuneId");
      const statusFilter = searchParams.get("status");
      const [status, payload] = await readState((db) => [
        200,
        {
          data: db.issues.filter(
            (item) => (!tuneId || item.tuneId === tuneId) && (!statusFilter || item.status === statusFilter)
          )
        }
      ]);
      return send(res, status, payload);
    }

    if (req.method === "POST" && pathname === "/issues") {
      const body = await parseBody(req);
      required(body, ["tuneId", "sectionId", "type", "description"]);
      const [status, payload] = await transact((db) => {
        findTune(db, body.tuneId);
        const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
        if (!section) return [400, { error: "区间不存在或不属于该曲目" }];
        const issue = {
          id: makeId("issue"),
          tuneId: body.tuneId,
          sectionId: body.sectionId,
          type: body.type,
          beat: body.beat === undefined ? null : Number(body.beat),
          lane: body.lane === undefined ? null : Number(body.lane),
          description: body.description,
          status: "open",
          createdAt: new Date().toISOString(),
          resolvedAt: null
        };
        db.issues.push(issue);
        return [201, { data: issue }];
      });
      return send(res, status, payload);
    }

    const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
    if (issueStatusMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      required(body, ["status"]);
      const [status, payload] = await transact((db) => {
        const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
        if (!issue) return [404, { error: "问题不存在" }];
        issue.status = body.status;
        issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
        issue.note = body.note ?? issue.note;
        return [200, { data: issue }];
      });
      return send(res, status, payload);
    }

    // ---------- 成品孔位抽检 ----------

    // 检验方案：按 孔数 + 纸型 唯一匹配
    if (req.method === "GET" && pathname === "/inspection-plans") {
      const [status, payload] = await readState((db) => [200, { data: db.inspectionPlans }]);
      return send(res, status, payload);
    }

    if (req.method === "POST" && pathname === "/inspection-plans") {
      const body = await parseBody(req);
      const fields = validatePlanFields(body);
      const [status, payload] = await transact((db) => {
        if (matchPlan(db, fields)) {
          fail(409, `孔数=${fields.holeCount}、纸型=${fields.paperType} 的检验方案已存在`);
        }
        const now = new Date().toISOString();
        const plan = {
          id: makeId("plan"),
          name: fields.name || "",
          holeCount: fields.holeCount,
          paperType: fields.paperType,
          sampleSize: fields.sampleSize,
          majorAllowed: fields.majorAllowed,
          minorAllowed: fields.minorAllowed,
          version: 1,
          createdAt: now,
          updatedAt: now
        };
        db.inspectionPlans.push(plan);
        return [201, { data: plan }];
      });
      return send(res, status, payload);
    }

    // 方案切换：更新阈值即升版本；已冻结批次不受影响
    const planMatch = pathname.match(/^\/inspection-plans\/([^/]+)$/);
    if (planMatch && req.method === "PUT") {
      const body = await parseBody(req);
      const fields = validatePlanFields(body, { partial: true });
      const [status, payload] = await transact((db) => {
        const plan = db.inspectionPlans.find((item) => item.id === planMatch[1]);
        if (!plan) fail(404, "检验方案不存在");
        if (fields.holeCount !== undefined && fields.holeCount !== plan.holeCount) {
          fail(400, "方案匹配条件（孔数）不可修改，请新建方案");
        }
        if (fields.paperType !== undefined && fields.paperType !== plan.paperType) {
          fail(400, "方案匹配条件（纸型）不可修改，请新建方案");
        }
        const keys = ["sampleSize", "majorAllowed", "minorAllowed", "name"];
        const changed = keys.some((key) => fields[key] !== undefined && fields[key] !== plan[key]);
        if (changed) {
          for (const key of keys) {
            if (fields[key] !== undefined) plan[key] = fields[key];
          }
          plan.version += 1;
          plan.updatedAt = new Date().toISOString();
        }
        return [200, { data: plan }];
      });
      return send(res, status, payload);
    }

    if (req.method === "GET" && pathname === "/inspection-batches") {
      const [status, payload] = await readState((db) => [
        200,
        { data: db.inspectionBatches.map((batch) => viewBatch(db, batch)) }
      ]);
      return send(res, status, payload);
    }

    if (req.method === "POST" && pathname === "/inspection-batches") {
      const body = await parseBody(req);
      const holeCount = toInteger(body.holeCount);
      if (holeCount === null || holeCount <= 0) fail(400, "孔数 holeCount 必须是正整数");
      const paperType = toCleanString(body.paperType);
      if (!paperType) fail(400, "纸型 paperType 不能为空");
      let quantity = null;
      if (body.quantity !== undefined && body.quantity !== null) {
        quantity = toInteger(body.quantity);
        if (quantity === null || quantity < 1) fail(400, "批量 quantity 必须是正整数");
      }
      const batchNo = body.batchNo === undefined ? "" : toCleanString(body.batchNo);
      const [status, payload] = await transact((db) => {
        if (!matchPlan(db, { holeCount, paperType })) {
          fail(400, `没有匹配孔数=${holeCount}、纸型=${paperType} 的检验方案`);
        }
        const finalBatchNo = batchNo || makeId("batch");
        if (db.inspectionBatches.some((item) => item.batchNo === finalBatchNo)) {
          fail(409, `批号 ${finalBatchNo} 已存在`);
        }
        const batch = {
          id: makeId("lot"),
          batchNo: finalBatchNo,
          holeCount,
          paperType,
          quantity,
          status: "sampling",
          planSnapshot: null,
          verdict: null,
          createdAt: new Date().toISOString(),
          judgedAt: null
        };
        db.inspectionBatches.push(batch);
        return [201, { data: viewBatch(db, batch) }];
      });
      return send(res, status, payload);
    }

    const batchMatch = pathname.match(/^\/inspection-batches\/([^/]+)$/);
    if (batchMatch && req.method === "GET") {
      const [status, payload] = await readState((db) => {
        const batch = findBatch(db, batchMatch[1]);
        return [
          200,
          {
            data: {
              ...viewBatch(db, batch),
              samples: db.inspectionSamples.filter((item) => item.batchId === batch.id)
            }
          }
        ];
      });
      return send(res, status, payload);
    }

    // 登记样本：样本带编号在批内唯一，重复提交返回原结果；
    // 首个样本冻结方案快照；达到样本量即判定（同事务落库）。
    const samplesMatch = pathname.match(/^\/inspection-batches\/([^/]+)\/samples$/);
    if (samplesMatch && req.method === "POST") {
      const batchId = samplesMatch[1];
      const body = await parseBody(req);
      const sampleNo = toCleanString(body.sampleNo);
      if (!sampleNo) fail(400, "样本编号 sampleNo 不能为空");
      const defects = normalizeDefects(body.defects);
      const [status, payload] = await transact((db) => {
        const batch = findBatch(db, batchId);
        const existing = db.inspectionSamples.find(
          (item) => item.batchId === batchId && item.sampleNo === sampleNo
        );
        if (existing) {
          return [200, { data: { duplicated: true, sample: existing, batch: viewBatch(db, batch) } }];
        }
        if (batch.status === "judged") {
          fail(409, "批次已判定，不能再登记样本");
        }
        const now = new Date().toISOString();
        if (!batch.planSnapshot) {
          const plan = matchPlan(db, batch);
          if (!plan) fail(409, "批次没有匹配的检验方案，无法登记样本");
          batch.planSnapshot = snapshotPlan(plan, now);
        }
        const sample = {
          id: makeId("sample"),
          batchId,
          sampleNo,
          defects,
          status: "active",
          createdAt: now,
          withdrawnAt: null
        };
        db.inspectionSamples.push(sample);
        const active = db.inspectionSamples.filter(
          (item) => item.batchId === batchId && item.status === "active"
        );
        if (!batch.verdict && active.length >= batch.planSnapshot.sampleSize) {
          batch.verdict = computeVerdict(batch.planSnapshot, tallyDefects(active), active.length, now);
          batch.status = "judged";
          batch.judgedAt = now;
        }
        return [201, { data: { duplicated: false, sample, batch: viewBatch(db, batch) } }];
      });
      return send(res, status, payload);
    }

    // 撤回样本：已判定批次不能撤回；撤回后按剩余有效样本重算
    const withdrawMatch = pathname.match(/^\/inspection-batches\/([^/]+)\/samples\/([^/]+)\/withdraw$/);
    if (withdrawMatch && req.method === "POST") {
      const [, batchId, sampleId] = withdrawMatch;
      const [status, payload] = await transact((db) => {
        const batch = findBatch(db, batchId);
        const sample = db.inspectionSamples.find(
          (item) => item.id === sampleId && item.batchId === batchId
        );
        if (!sample) fail(404, "样本不存在");
        if (batch.status === "judged") fail(409, "批次已判定，不能撤回样本");
        if (sample.status === "withdrawn") fail(409, "样本已撤回");
        sample.status = "withdrawn";
        sample.withdrawnAt = new Date().toISOString();
        return [200, { data: { sample, batch: viewBatch(db, batch) } }];
      });
      return send(res, status, payload);
    }

    return send(res, 404, { error: "接口不存在", routes });
  }

  const handler = (req, res) => {
    handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
  };

  return { handler, storage, ready: load() };
}

module.exports = { createApp, routes, DEFAULT_DB_FILE };
