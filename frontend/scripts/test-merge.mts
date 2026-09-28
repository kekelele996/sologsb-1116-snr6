import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import type { CollectPoint, FungusRecord } from '../src/types'

const { db } = await import('../src/hooks/usePersistentStore.ts')
const { mergePoints, PointMergeError, splitTrees } = await import('../src/utils/pointMerge.ts')

let n = 0
function makePoint(over: Partial<CollectPoint>): CollectPoint {
  n += 1
  return {
    id: `pt_${n}`,
    name: `点${n}`,
    longitude: 116,
    latitude: 39,
    altitude: 100,
    vegetation: '针阔混交林',
    substrate: '落叶层',
    companionTrees: '',
    collectDate: '2026-09-28',
    collector: '',
    aliases: [],
    ...over
  }
}

function makeRecord(pointId: string, code: string): FungusRecord {
  n += 1
  return {
    id: `rec_${n}`,
    code,
    tempName: 'x',
    fruitBodyCount: 1,
    pointId,
    capDiameter: 1,
    capShape: '平展',
    capMargin: '全缘',
    capTexture: '光滑',
    fleshThickness: 1,
    fleshReaction: '不变色',
    attachment: '离生',
    gillDensity: '中等',
    stipeLength: 1,
    stipeDiameter: 1,
    ring: '无菌环',
    volva: '无菌托',
    odor: '',
    hostTree: '',
    collectDate: '2026-09-28',
    collector: '',
    note: ''
  }
}

async function resetDb(): Promise<void> {
  await db.delete()
  await db.open()
}

/* ---------- 纯函数：树种拆分 / 去重 ---------- */
{
  assert.deepStrictEqual(splitTrees('辽东栎、油松， 麻栎;枫香；白桦 青冈'), [
    '辽东栎',
    '油松',
    '麻栎',
    '枫香',
    '白桦',
    '青冈'
  ])
  console.log('ok splitTrees 分隔符与空白')
}

/* ---------- 用例 1：正常合并：记录迁移、旧称保留、树种去重、被并点消失 ---------- */
await resetDb()
{
  const keep = makePoint({ id: 'pt_keep', name: '百花山栎树林样线', companionTrees: '辽东栎、油松' })
  const src = makePoint({
    id: 'pt_src',
    name: '百花山样线',
    companionTrees: '油松,白桦，辽东栎；山杨',
    aliases: ['旧登记名A']
  })
  await db.points.bulkPut([keep, src])
  await db.records.bulkPut([
    makeRecord('pt_keep', 'K-1'),
    makeRecord('pt_src', 'S-1'),
    makeRecord('pt_src', 'S-2')
  ])

  const result = await mergePoints('pt_keep', ['pt_src'])
  assert.strictEqual(result.movedRecords, 2)
  assert.deepStrictEqual(result.removedIds, ['pt_src'])
  assert.deepStrictEqual(result.companionTrees.split('、'), ['辽东栎', '油松', '白桦', '山杨'])
  assert.deepStrictEqual(result.aliases, ['百花山样线', '旧登记名A'])

  const points = await db.points.toArray()
  assert.strictEqual(points.length, 1, '被并点应从清单消失')
  assert.strictEqual(points[0].id, 'pt_keep')

  const recs = await db.records.toArray()
  assert.strictEqual(recs.length, 3)
  assert.ok(recs.every((r) => r.pointId === 'pt_keep'), '全部条目归到保留点')

  // 模拟重开浏览器：重新打开数据库后结果仍一致
  await db.close()
  await db.open()
  const points2 = await db.points.toArray()
  assert.strictEqual(points2.length, 1)
  assert.deepStrictEqual(points2[0].aliases, ['百花山样线', '旧登记名A'])
  assert.strictEqual(points2[0].companionTrees, '辽东栎、油松、白桦、山杨')
  assert.ok((await db.records.toArray()).every((r) => r.pointId === 'pt_keep'))
  console.log('ok 正常合并 + 重开浏览器后持久一致')
}

/* ---------- 用例 2：并入自己 → 中止，原样 ---------- */
await resetDb()
{
  const a = makePoint({ id: 'pt_a', name: 'A' })
  const b = makePoint({ id: 'pt_b', name: 'B' })
  await db.points.bulkPut([a, b])
  await db.records.put(makeRecord('pt_b', 'B-1'))
  await assert.rejects(
    () => mergePoints('pt_a', ['pt_a']),
    (err: unknown) => err instanceof PointMergeError && /自己/.test(err.message)
  )
  assert.strictEqual((await db.points.toArray()).length, 2)
  assert.strictEqual((await db.records.where('pointId').equals('pt_b').count()), 1)
  console.log('ok 并入自己中止且原样')
}

/* ---------- 用例 3：目标为空（未选 / 已不存在）→ 中止 ---------- */
await resetDb()
{
  const a = makePoint({ id: 'pt_a', name: 'A' })
  await db.points.put(a)
  await assert.rejects(
    () => mergePoints('', ['pt_a']),
    (err: unknown) => err instanceof PointMergeError && /保留的采集点/.test(err.message)
  )
  await assert.rejects(
    () => mergePoints('pt_missing', ['pt_a']),
    (err: unknown) => err instanceof PointMergeError && /不存在/.test(err.message)
  )
  assert.strictEqual((await db.points.toArray()).length, 1)
  console.log('ok 目标为空中止且原样')
}

/* ---------- 用例 4：多个待并入点之一不存在 → 整笔回滚，先并入的记录也要还原 ---------- */
await resetDb()
{
  const keep = makePoint({ id: 'pt_keep2', name: 'K' })
  const s1 = makePoint({ id: 'pt_s1', name: 'S1', companionTrees: '栎' })
  await db.points.bulkPut([keep, s1])
  await db.records.put(makeRecord('pt_s1', 'S1-1'))
  await assert.rejects(
    () => mergePoints('pt_keep2', ['pt_s1', 'pt_gone']),
    (err: unknown) => err instanceof PointMergeError
  )
  // 事务整体回滚：s1 仍在、其记录未被迁走、保留点树种未变
  assert.strictEqual((await db.points.toArray()).length, 2)
  assert.strictEqual((await db.records.where('pointId').equals('pt_s1').count()), 1)
  assert.strictEqual((await db.records.where('pointId').equals('pt_keep2').count()), 0)
  const k = await db.points.get('pt_keep2')
  assert.strictEqual(k?.companionTrees, '')
  assert.deepStrictEqual(k?.aliases, [])
  console.log('ok 中途失败整体回滚（两个点保持原样）')
}

/* ---------- 用例 5：零记录点也允许合并（仅去重点位） ---------- */
await resetDb()
{
  const keep = makePoint({ id: 'pt_k3', name: 'K3', companionTrees: '松' })
  const empty = makePoint({ id: 'pt_e3', name: 'E3', companionTrees: '桦' })
  await db.points.bulkPut([keep, empty])
  const result = await mergePoints('pt_k3', ['pt_e3'])
  assert.strictEqual(result.movedRecords, 0)
  assert.deepStrictEqual(result.aliases, ['E3'])
  assert.strictEqual((await db.points.toArray()).length, 1)
  console.log('ok 空记录点合并（0 条迁移）')
}

/* ---------- 用例 6：名称与保留点现名/旧称重复时去重 ---------- */
await resetDb()
{
  const keep = makePoint({ id: 'pt_k4', name: '正式名', companionTrees: '松', aliases: ['曾用名'] })
  const s1 = makePoint({ id: 'pt_s4a', name: '曾用名', companionTrees: '桦' })
  const s2 = makePoint({ id: 'pt_s4b', name: '另一个点', companionTrees: '桦', aliases: ['正式名'] })
  await db.points.bulkPut([keep, s1, s2])
  const result = await mergePoints('pt_k4', ['pt_s4a', 'pt_s4b'])
  assert.deepStrictEqual(result.aliases, ['曾用名', '另一个点'])
  assert.deepStrictEqual(result.companionTrees.split('、'), ['松', '桦'])
  console.log('ok 旧称与树种跨点去重')
}

console.log('\n全部合并逻辑测试通过 ✅')
process.exit(0)
