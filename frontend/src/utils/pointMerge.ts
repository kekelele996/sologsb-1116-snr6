import { db } from '@/hooks/usePersistentStore'
import type { CollectPoint } from '@/types'

/** 合并中止错误：message 为可直接展示给用户的原因说明 */
export class PointMergeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PointMergeError'
  }
}

/** 伴生树种分隔符：顿号 / 中英文逗号 / 分号 / 空白（含换行） */
const TREE_SPLIT_RE = /[、,，;；\s]+/

/** 把伴生树种字符串拆成去空白后的清单 */
export function splitTrees(text: string): string[] {
  return text
    .split(TREE_SPLIT_RE)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 多份伴生树种清单合并去重，先出现的在前（保留点原树种优先） */
export function mergeTrees(...texts: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const text of texts) {
    for (const tree of splitTrees(text)) {
      if (!seen.has(tree)) {
        seen.add(tree)
        result.push(tree)
      }
    }
  }
  return result
}

export interface MergePointsResult {
  keepId: string
  removedIds: string[]
  /** 实际迁移到保留点的菌物记录条数 */
  movedRecords: number
  /** 合并后的伴生树种字符串 */
  companionTrees: string
  /** 合并后保留点的旧称清单 */
  aliases: string[]
}

function appendAlias(list: string[], value: string, used: Set<string>): void {
  const name = value.trim()
  if (name && !used.has(name) && !list.includes(name)) {
    list.push(name)
    used.add(name)
  }
}

/**
 * 把若干待并入采集点合并进一个保留点（同一个读写事务内完成）：
 * 1. 被并点名下全部菌物记录的 pointId 迁到保留点；
 * 2. 被并点名称（连同其自带旧称）追加到保留点 aliases；
 * 3. 伴生树种合并去重；
 * 4. 删除被并点。
 *
 * 任一前置条件不满足或记录只迁移了一部分，都抛出 PointMergeError，
 * IndexedDB 事务整体回滚，两个点保持原样。
 */
export async function mergePoints(
  keepIdRaw: string | null | undefined,
  sourceIdsRaw: string[]
): Promise<MergePointsResult> {
  const keepId = keepIdRaw?.trim() ?? ''
  const sourceIds = (sourceIdsRaw ?? []).map((id) => id.trim()).filter(Boolean)

  if (!keepId) {
    throw new PointMergeError('请先选择要保留的采集点（目标为空，未执行合并）')
  }
  if (sourceIds.length === 0) {
    throw new PointMergeError('请先勾选至少一个待并入的采集点')
  }
  if (sourceIds.includes(keepId)) {
    throw new PointMergeError('不能把采集点并入它自己，请重新选择待并入点')
  }

  return db.transaction('rw', db.points, db.records, async () => {
    const keep = await db.points.get(keepId)
    if (!keep) {
      throw new PointMergeError('要保留的采集点已不存在（目标为空），未执行合并，两个采集点保持原样')
    }

    const sources: CollectPoint[] = []
    for (const sourceId of sourceIds) {
      const source = await db.points.get(sourceId)
      if (!source) {
        throw new PointMergeError(`待并入的采集点（${sourceId}）已不存在，未执行合并，两个采集点保持原样`)
      }
      if (source.id === keep.id) {
        throw new PointMergeError('不能把采集点并入它自己，请重新选择待并入点')
      }
      sources.push(source)
    }

    let movedRecords = 0
    for (const source of sources) {
      const expected = await db.records.where('pointId').equals(source.id).count()
      const modified = await db.records
        .where('pointId')
        .equals(source.id)
        .modify({ pointId: keep.id })
      movedRecords += modified

      // 「只搬了一部分」立即中止：改动条数与预期不符，或仍有条目挂在被并点上
      if (modified !== expected) {
        throw new PointMergeError(
          `「${source.name}」的菌物记录只迁移了一部分（预期 ${expected} 条，实际迁移 ${modified} 条），已中止，两个采集点保持原样`
        )
      }
      const remaining = await db.records.where('pointId').equals(source.id).count()
      if (remaining !== 0) {
        throw new PointMergeError(
          `「${source.name}」仍有 ${remaining} 条菌物记录未迁移，已中止，两个采集点保持原样`
        )
      }
    }

    // 伴生树种合并去重（保留点原树种优先，随后按被并点顺序追加）
    const trees = mergeTrees(keep.companionTrees, ...sources.map((source) => source.companionTrees))

    // 旧称保留：被并点名 + 其自带旧称，与保留点现名、现有旧称去重
    const aliases = Array.isArray(keep.aliases) ? [...keep.aliases] : []
    const usedNames = new Set([keep.name.trim(), ...aliases.map((name) => name.trim())])
    for (const source of sources) {
      appendAlias(aliases, source.name, usedNames)
      for (const oldName of Array.isArray(source.aliases) ? source.aliases : []) {
        appendAlias(aliases, oldName, usedNames)
      }
    }

    const mergedPoint: CollectPoint = {
      ...keep,
      companionTrees: trees.join('、'),
      aliases
    }
    await db.points.put(mergedPoint)
    await db.points.bulkDelete(sources.map((source) => source.id))

    return {
      keepId: keep.id,
      removedIds: sources.map((source) => source.id),
      movedRecords,
      companionTrees: mergedPoint.companionTrees,
      aliases
    }
  })
}
