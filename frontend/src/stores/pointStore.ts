import { createStore } from 'zustand/vanilla'
import type { CollectPoint, FungusRecord } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { recordStore } from '@/stores/recordStore'
import { mergeFormerNames, mergeTrees } from '@/utils/point'

/** 合并结果，供界面提示 */
export interface MergeResult {
  moved: number
  keptPoint: CollectPoint
}

export interface PointState {
  points: CollectPoint[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (point: CollectPoint) => Promise<void>
  remove: (id: string) => Promise<void>
  /**
   * 把待并入点（absorbId）合并到保留点（keepId）：
   * - 被并点下的菌物条目全部迁移到保留点；
   * - 被并点名称作为「曾用名」留在保留点；
   * - 伴生树种合并去重；
   * - 删除被并点。
   * 整过程在同一个 IndexedDB 事务内完成，任何一步失败整体回滚，两个点保持原样。
   */
  merge: (keepId: string, absorbId: string) => Promise<MergeResult>
}

/** 合并前的硬性校验，不通过则抛出带中文原因的错误，不写任何数据 */
function validateMerge(keepId: string, absorbId: string, points: CollectPoint[]): {
  keep: CollectPoint
  absorb: CollectPoint
} {
  if (!keepId) {
    throw new Error('尚未选择要保留的采集点，已取消合并，两个采集点均未改动。')
  }
  if (!absorbId) {
    throw new Error('尚未选择待并入的采集点，已取消合并，两个采集点均未改动。')
  }
  if (keepId === absorbId) {
    throw new Error('保留点与待并入点不能是同一个采集点，已取消合并，两个采集点均未改动。')
  }
  const keep = points.find((point) => point.id === keepId)
  const absorb = points.find((point) => point.id === absorbId)
  if (!keep) {
    throw new Error('要保留的采集点已不存在，已取消合并，两个采集点均未改动。')
  }
  if (!absorb) {
    throw new Error('待并入的采集点已不存在，已取消合并，两个采集点均未改动。')
  }
  return { keep, absorb }
}

export const pointStore = createStore<PointState>((set, get) => ({
  points: [],
  loaded: false,
  hydrate: async () => {
    const points = await syncAll<CollectPoint>(db.points)
    points.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    set({ points, loaded: true })
  },
  save: async (point) => {
    await syncPut<CollectPoint>(db.points, point)
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete<CollectPoint>(db.points, id)
    await get().hydrate()
  },
  merge: async (keepId, absorbId) => {
    // 先基于当前已加载数据做校验；事务内会再以库内最新数据复核
    validateMerge(keepId, absorbId, get().points)

    let moved = 0
    await db.transaction('rw', db.points, db.records, async () => {
      // 事务内重新读取，避免与其他操作竞争导致只迁移一部分
      const liveKeep = await db.points.get(keepId)
      const liveAbsorb = await db.points.get(absorbId)
      if (!liveKeep || !liveAbsorb || keepId === absorbId) {
        throw new Error('采集点状态已变化，已取消合并，两个采集点均未改动。')
      }

      const beforeCount = await db.records.where('pointId').equals(absorbId).count()

      // 1. 被并点下的菌物条目全部改挂到保留点
      await db.records
        .where('pointId')
        .equals(absorbId)
        .modify((record: FungusRecord) => {
          record.pointId = keepId
        })

      // 2. 复核条目是否全部迁移成功；仍有残留说明只迁移了一部分，抛错让整个事务回滚
      const leftAbsorb = await db.records.where('pointId').equals(absorbId).count()
      if (leftAbsorb !== 0) {
        throw new Error(`仅有部分菌物条目完成迁移（${beforeCount - leftAbsorb}/${beforeCount}），已回滚，两个采集点均未改动。`)
      }
      moved = beforeCount

      // 3. 伴生树种合并去重；被并点名称并入曾用名（含其自身曾用名）
      const mergedPoint: CollectPoint = {
        ...liveKeep,
        companionTrees: mergeTrees(liveKeep.companionTrees, liveAbsorb.companionTrees),
        formerNames: mergeFormerNames([
          liveKeep.formerNames ?? [],
          liveAbsorb.formerNames ?? [],
          [liveAbsorb.name]
        ])
      }
      await db.points.put(mergedPoint)

      // 4. 删除被并点
      await db.points.delete(absorbId)
    })

    // 事务成功提交后再刷新内存状态，保证界面与库一致
    await get().hydrate()
    await recordStore.getState().hydrate()
    const keptPoint = get().points.find((point) => point.id === keepId)
    if (!keptPoint) {
      throw new Error('合并已提交但未读到保留点，请刷新页面后核对。')
    }
    return { moved, keptPoint }
  }
}))
