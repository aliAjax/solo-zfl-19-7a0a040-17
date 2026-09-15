# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题，以及成品孔位抽检的方案、批次、样本与判定。

## 启动

```bash
PORT=3019 node server.js   # 或 npm start
```

## 测试

```bash
npm test                   # node --test test/
```

## 原有接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

## 成品孔位抽检

### 规则

- 每批纸带按 **孔数 + 纸型** 匹配唯一检验方案；没有匹配方案的批次不能创建。
- 批次在 **开始登记样本时冻结方案快照**，之后方案切换（更新阈值升版本）只影响未冻结批次。
- 缺陷分 **致命 / 主要 / 次要**（也接受 `critical` / `major` / `minor`）：
  - 致命缺陷 **直接否决**；
  - 主要、次要缺陷按方案的允收数 `majorAllowed` / `minorAllowed` 判定。
- 有效样本数达到方案样本量 `sampleSize` 时自动判定，批次进入 `judged`。
- 样本带编号在批内唯一，**重复提交返回原结果**（幂等）。
- **撤回样本后按剩余有效样本重算**统计；**已判定批次不能撤回**，也不能再登记新样本。
- 方案快照、样本缺陷和判定在同一事务落库（临时文件 + rename 原子写），**写入失败不留半批**；重启后批次、样本、判定保持一致。

### 接口

- `GET /inspection-plans` — 方案列表
- `POST /inspection-plans` — 新建方案 `{ holeCount, paperType, sampleSize, majorAllowed, minorAllowed, name? }`；同一 孔数+纸型 重复创建返回 409
- `PUT /inspection-plans/:id` — 方案切换（更新阈值，版本 +1）；孔数、纸型不可修改
- `GET /inspection-batches` — 批次列表（含实时统计）
- `POST /inspection-batches` — 新建批次 `{ holeCount, paperType, batchNo?, quantity? }`
- `GET /inspection-batches/:id` — 批次详情（含样本、冻结快照、判定）
- `POST /inspection-batches/:id/samples` — 登记样本 `{ sampleNo, defects: [{ severity, count?, code?, description? }] }`
- `POST /inspection-batches/:id/samples/:sampleId/withdraw` — 撤回样本

### 闭环示例

```bash
# 1. 登记检验方案：70孔半透明纸带，抽2条，主要缺陷允收1、次要允收3
curl -X POST http://127.0.0.1:3019/inspection-plans \
  -H 'Content-Type: application/json' \
  -d '{"holeCount":70,"paperType":"半透明纸带","sampleSize":2,"majorAllowed":1,"minorAllowed":3}'

# 2. 创建批次（自动匹配方案）
curl -X POST http://127.0.0.1:3019/inspection-batches \
  -H 'Content-Type: application/json' \
  -d '{"holeCount":70,"paperType":"半透明纸带","batchNo":"LOT-001","quantity":200}'

# 3. 登记样本（首个样本登记后方案冻结）
curl -X POST http://127.0.0.1:3019/inspection-batches/<批次ID>/samples \
  -H 'Content-Type: application/json' \
  -d '{"sampleNo":"S-001","defects":[{"severity":"主要","count":1}]}'

# 4. 达到样本量自动判定；撤回（未判定时）
curl -X POST http://127.0.0.1:3019/inspection-batches/<批次ID>/samples/<样本ID>/withdraw
```

## 原闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'
```

## 代码结构

- `server.js` — 启动入口
- `src/app.js` — 路由与串行事务队列（所有请求经同一 promise 链，写操作先改草稿、落库成功才提交）
- `src/store.js` — JSON 文件原子存储与旧库迁移
- `src/inspection.js` — 抽检领域逻辑（方案匹配/快照、缺陷统计、判定）
- `test/` — `node:test` 集成测试（方案切换、撤回、并发、失败恢复、重启一致、原接口回归）
