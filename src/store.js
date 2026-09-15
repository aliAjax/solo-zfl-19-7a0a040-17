const { readFile, mkdir, rename, unlink, open } = require("fs/promises");
const path = require("path");

// 初始数据：原有曲目演示数据 + 抽检集合。已有 db.json 由 normalizeDb 补齐新集合。
const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: "2026-06-16T00:00:00.000Z",
      resolvedAt: null
    }
  ],
  inspectionPlans: [
    {
      id: "plan_demo_70",
      name: "常规抽检",
      holeCount: 70,
      paperType: "半透明纸带",
      sampleSize: 2,
      majorAllowed: 1,
      minorAllowed: 3,
      version: 1,
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  inspectionBatches: [],
  inspectionSamples: []
};

const COLLECTIONS = [
  "tunes",
  "sections",
  "issues",
  "inspectionPlans",
  "inspectionBatches",
  "inspectionSamples"
];

// 兼容旧版 db.json：缺失的集合补空数组，其余字段原样保留。
function normalizeDb(data) {
  const db = data && typeof data === "object" ? data : {};
  for (const key of COLLECTIONS) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  return db;
}

// JSON 文件存储：写临时文件 + fsync + rename，保证落库要么完整要么不变。
function createJsonFileStorage(file) {
  let tmpCounter = 0;

  async function read() {
    await mkdir(path.dirname(file), { recursive: true });
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const seeded = normalizeDb(JSON.parse(JSON.stringify(initialData)));
      await write(seeded);
      return seeded;
    }
    try {
      return normalizeDb(JSON.parse(raw));
    } catch {
      // 保持旧服务行为：文件损坏时回退到初始数据
      const seeded = normalizeDb(JSON.parse(JSON.stringify(initialData)));
      await write(seeded);
      return seeded;
    }
  }

  async function write(data) {
    const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(data, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  return { read, write, file };
}

module.exports = { initialData, normalizeDb, createJsonFileStorage };
