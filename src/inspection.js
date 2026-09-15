// 成品孔位抽检领域逻辑（纯函数，便于单测与复用）

const SEVERITIES = ["critical", "major", "minor"];

const SEVERITY_ALIAS = {
  critical: "critical",
  致命: "critical",
  major: "major",
  主要: "major",
  minor: "minor",
  次要: "minor"
};

const SEVERITY_LABEL = { critical: "致命", major: "主要", minor: "次要" };

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function normalizeSeverity(value) {
  if (typeof value !== "string") return null;
  return SEVERITY_ALIAS[value.trim()] || null;
}

function toInteger(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value))) {
    return Number(value);
  }
  return null;
}

function toCleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

// 校验方案字段。partial=true 时只校验出现的字段（用于方案更新/切换）。
function validatePlanFields(body, { partial = false } = {}) {
  const cleaned = {};
  const need = (field) => !partial || body[field] !== undefined;

  if (need("holeCount")) {
    const holeCount = toInteger(body.holeCount);
    if (holeCount === null || holeCount <= 0) fail(400, "孔数 holeCount 必须是正整数");
    cleaned.holeCount = holeCount;
  }
  if (need("paperType")) {
    const paperType = toCleanString(body.paperType);
    if (!paperType) fail(400, "纸型 paperType 不能为空");
    cleaned.paperType = paperType;
  }
  if (need("sampleSize")) {
    const sampleSize = toInteger(body.sampleSize);
    if (sampleSize === null || sampleSize < 1) fail(400, "样本量 sampleSize 必须是大于等于1的整数");
    cleaned.sampleSize = sampleSize;
  }
  for (const field of ["majorAllowed", "minorAllowed"]) {
    if (need(field)) {
      const value = toInteger(body[field]);
      if (value === null || value < 0) fail(400, `${field} 必须是大于等于0的整数`);
      cleaned[field] = value;
    }
  }
  if (body.name !== undefined) cleaned.name = toCleanString(body.name);
  return cleaned;
}

// 按孔数 + 纸型匹配唯一检验方案
function matchPlan(db, { holeCount, paperType }) {
  return db.inspectionPlans.find(
    (plan) => plan.holeCount === holeCount && plan.paperType === paperType
  );
}

// 开始登记样本时对方案拍快照，之后方案切换不影响该批次
function snapshotPlan(plan, now) {
  return {
    planId: plan.id,
    version: plan.version,
    name: plan.name || "",
    holeCount: plan.holeCount,
    paperType: plan.paperType,
    sampleSize: plan.sampleSize,
    majorAllowed: plan.majorAllowed,
    minorAllowed: plan.minorAllowed,
    frozenAt: now
  };
}

// 校验并规范化缺陷列表：severity 支持 致命/主要/次要 或 critical/major/minor
function normalizeDefects(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) fail(400, "defects 必须是数组");
  return input.map((item, index) => {
    if (!item || typeof item !== "object") fail(400, `第 ${index + 1} 条缺陷格式不正确`);
    const severity = normalizeSeverity(item.severity);
    if (!severity) {
      fail(400, `第 ${index + 1} 条缺陷等级无效，应为 致命/主要/次要（critical/major/minor）`);
    }
    let count = 1;
    if (item.count !== undefined) {
      count = toInteger(item.count);
      if (count === null || count < 1) fail(400, `第 ${index + 1} 条缺陷数量 count 必须是正整数`);
    }
    return {
      severity,
      code: toCleanString(item.code),
      description: toCleanString(item.description),
      count
    };
  });
}

// 只统计有效（未撤回）样本的缺陷
function tallyDefects(activeSamples) {
  const tallies = { critical: 0, major: 0, minor: 0 };
  for (const sample of activeSamples) {
    for (const defect of sample.defects) {
      tallies[defect.severity] += defect.count;
    }
  }
  return tallies;
}

// 判定：致命缺陷直接否决；主要、次要按允收数判定
function computeVerdict(plan, tallies, sampleCount, now) {
  const reasons = [];
  if (tallies.critical > 0) {
    reasons.push(`致命缺陷 ${tallies.critical} 项，直接否决`);
  }
  if (tallies.major > plan.majorAllowed) {
    reasons.push(`主要缺陷 ${tallies.major} 项，超过允收数 ${plan.majorAllowed}`);
  }
  if (tallies.minor > plan.minorAllowed) {
    reasons.push(`次要缺陷 ${tallies.minor} 项，超过允收数 ${plan.minorAllowed}`);
  }
  const result = reasons.length ? "rejected" : "accepted";
  return {
    result,
    label: result === "accepted" ? "合格" : "不合格",
    reasons,
    tallies: { ...tallies },
    limits: { critical: 0, major: plan.majorAllowed, minor: plan.minorAllowed },
    sampleSize: plan.sampleSize,
    sampleCount,
    planVersion: plan.version,
    judgedAt: now
  };
}

// 批次视图：缺陷统计始终按当前剩余有效样本重算
function viewBatch(db, batch) {
  const samples = db.inspectionSamples.filter((item) => item.batchId === batch.id);
  const active = samples.filter((item) => item.status === "active");
  const tallies = tallyDefects(active);
  const effectivePlan = batch.planSnapshot || matchPlan(db, batch) || null;
  return {
    ...batch,
    effectivePlan,
    tallies,
    activeSampleCount: active.length,
    withdrawnSampleCount: samples.length - active.length,
    remainingSamples:
      batch.status === "judged" || !effectivePlan
        ? 0
        : Math.max(0, effectivePlan.sampleSize - active.length)
  };
}

module.exports = {
  SEVERITIES,
  SEVERITY_LABEL,
  fail,
  normalizeSeverity,
  toInteger,
  toCleanString,
  validatePlanFields,
  matchPlan,
  snapshotPlan,
  normalizeDefects,
  tallyDefects,
  computeVerdict,
  viewBatch
};
