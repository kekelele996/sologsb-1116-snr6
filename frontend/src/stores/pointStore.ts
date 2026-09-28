import { createStore } from 'zustand/vanilla'
import type { CollectPoint } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { mergePoints as runMerge, type MergePointsResult } from '@/utils/pointMerge'
import { recordStore } from '@/stores/recordStore'

export interface PointState {
  points: CollectPoint[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (point: CollectPoint) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 合并采集点：sourceIds 全部并入 keepId，成功后刷新点与菌物条目 */
  merge: (keepId: string, sourceIds: string[]) => Promise<MergePointsResult>
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
  merge: async (keepId, sourceIds) => {
    // 事务内完成迁移/合并/删除；抛错（目标为空、并入自己、只搬一部分）时事务整体回滚，
    // 因此这里只在成功后刷新两个 store，失败时内存与数据库都保持原样
    const result = await runMerge(keepId, sourceIds)
    await get().hydrate()
    await recordStore.getState().hydrate()
    return result
  }
}))
