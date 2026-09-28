<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { CollectPoint } from '@/types'
import GeoPointForm from '@/components/common/GeoPointForm.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { pointStore } from '@/stores/pointStore'
import { recordStore } from '@/stores/recordStore'
import { PointMergeError } from '@/utils/pointMerge'
import { uid } from '@/utils/id'

const pointState = useStore(pointStore)
const recordState = useStore(recordStore)

const editingId = ref<string | null>(null)
const draft = reactive<CollectPoint>({
  id: '',
  name: '',
  longitude: 116.4,
  latitude: 39.9,
  altitude: 800,
  vegetation: '针阔混交林',
  substrate: '落叶层',
  companionTrees: '',
  collectDate: new Date().toISOString().slice(0, 10),
  collector: '',
  aliases: []
})

const coordError = computed<string | null>(() => {
  const { longitude, latitude } = draft
  if (longitude < -180 || longitude > 180) return '经度必须在 -180 ~ 180 之间'
  if (latitude < -90 || latitude > 90) return '纬度必须在 -90 ~ 90 之间'
  if (longitude === 0 && latitude === 0) return '经纬度不能同时为 0'
  return null
})

watch(
  () => pointState.loaded,
  () => {
    if (!editingId.value && !draft.name && pointState.points.length > 0) {
      draft.name = ''
    }
  }
)

function resetDraft(): void {
  editingId.value = null
  draft.id = ''
  draft.name = ''
  draft.longitude = 116.4
  draft.latitude = 39.9
  draft.altitude = 800
  draft.vegetation = '针阔混交林'
  draft.substrate = '落叶层'
  draft.companionTrees = ''
  draft.collector = ''
  draft.collectDate = new Date().toISOString().slice(0, 10)
  draft.aliases = []
}

function edit(point: CollectPoint): void {
  editingId.value = point.id
  Object.assign(draft, point)
}

async function submit(): Promise<void> {
  if (!draft.name.trim()) {
    ElMessage.warning('请填写采集点名称')
    return
  }
  if (coordError.value) {
    ElMessage.warning(coordError.value)
    return
  }
  const row: CollectPoint = {
    ...draft,
    id: editingId.value ?? uid('pt'),
    name: draft.name.trim(),
    companionTrees: draft.companionTrees.trim(),
    collector: draft.collector.trim()
  }
  await pointStore.getState().save(row)
  ElMessage.success(editingId.value ? '采集点已更新' : '采集点已建立')
  resetDraft()
}

function recordsOf(pointId: string): number {
  return recordState.records.filter((record) => record.pointId === pointId).length
}

/** 主要基物：该采集点下条目最常见的基物（采集点自身基物优先） */
function mainSubstrate(point: CollectPoint): string {
  const list = recordState.records.filter((record) => record.pointId === point.id)
  if (list.length === 0) return point.substrate
  return point.substrate
}

async function remove(point: CollectPoint): Promise<void> {
  const count = recordsOf(point.id)
  if (count > 0) {
    ElMessage.error(`「${point.name}」下仍有 ${count} 条菌物条目，请先清理条目`)
    return
  }
  await ElMessageBox.confirm(`确认删除采集点「${point.name}」？`, '删除确认', { type: 'warning' })
  await pointStore.getState().remove(point.id)
  ElMessage.success('采集点已删除')
}

/* ---------------- 采集点合并 ---------------- */

const mergeVisible = ref(false)
const mergeKeepId = ref('')
const mergeSourceIds = ref<string[]>([])
const merging = ref(false)

function openMerge(): void {
  mergeKeepId.value = ''
  mergeSourceIds.value = []
  mergeVisible.value = true
}

// 保留点变化时，把它自己从待并入勾选里剔除（并入自己无意义）
watch(mergeKeepId, (keepId) => {
  if (keepId && mergeSourceIds.value.includes(keepId)) {
    mergeSourceIds.value = mergeSourceIds.value.filter((id) => id !== keepId)
  }
})

const mergeKeepPoint = computed<CollectPoint | null>(
  () => pointState.points.find((point) => point.id === mergeKeepId.value) ?? null
)

const mergeSourcePoints = computed<CollectPoint[]>(() =>
  mergeSourceIds.value
    .map((id) => pointState.points.find((point) => point.id === id))
    .filter((point): point is CollectPoint => Boolean(point))
)

/** 待并入点合计菌物记录条数（确认前必须让用户看清） */
const mergeMoveCount = computed(() =>
  mergeSourcePoints.value.reduce((sum, point) => sum + recordsOf(point.id), 0)
)

const mergeSelfSelected = computed(() => mergeSourceIds.value.includes(mergeKeepId.value))

/** 合并后保留点将拥有的旧称（被并点名 + 其原有旧称，去重） */
const mergeAliasesPreview = computed<string[]>(() => {
  const keep = mergeKeepPoint.value
  if (!keep) return []
  const used = new Set([keep.name.trim(), ...keep.aliases.map((name) => name.trim())])
  const result = [...keep.aliases]
  for (const source of mergeSourcePoints.value) {
    if (!used.has(source.name.trim())) {
      used.add(source.name.trim())
      result.push(source.name)
    }
    for (const alias of source.aliases) {
      if (!used.has(alias.trim())) {
        used.add(alias.trim())
        result.push(alias)
      }
    }
  }
  return result
})

/** 合并去重后的伴生树种预览 */
const mergeTreesPreview = computed<string[]>(() => {
  const keep = mergeKeepPoint.value
  if (!keep) return []
  const seen = new Set<string>()
  const result: string[] = []
  const collect = (text: string): void => {
    for (const tree of text.split(/[、,，;；\s]+/).map((item) => item.trim()).filter(Boolean)) {
      if (!seen.has(tree)) {
        seen.add(tree)
        result.push(tree)
      }
    }
  }
  collect(keep.companionTrees)
  for (const source of mergeSourcePoints.value) collect(source.companionTrees)
  return result
})

const mergeBlocked = computed(() => {
  if (!mergeKeepId.value) return '请先选择要保留的采集点'
  if (mergeSourceIds.value.length === 0) return '请勾选至少一个待并入的采集点'
  if (mergeSelfSelected.value) return '不能把采集点并入它自己，请取消勾选保留点'
  return null
})

async function confirmMerge(): Promise<void> {
  if (mergeBlocked.value) {
    ElMessage.warning(mergeBlocked.value)
    return
  }
  const keep = mergeKeepPoint.value
  if (!keep) {
    ElMessage.error('要保留的采集点已不存在（目标为空），已中止，两个采集点保持原样')
    return
  }
  const sourceNames = mergeSourcePoints.value.map((point) => `「${point.name}」`).join('、')
  try {
    await ElMessageBox.confirm(
      `将把 ${sourceNames} 并入保留点「${keep.name}」，预计迁移 ${mergeMoveCount.value} 条菌物记录；` +
        `合并后待并入点将从清单消失，其名称会作为原称保留在保留点上。确认继续？`,
      `合并确认：迁移 ${mergeMoveCount.value} 条菌物记录`,
      { type: 'warning', confirmButtonText: '确认合并', cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  merging.value = true
  try {
    const result = await pointStore
      .getState()
      .merge(keep.id, [...mergeSourceIds.value])
    mergeVisible.value = false
    ElMessage.success(`已合并：${result.movedRecords} 条菌物记录归入「${keep.name}」，清单减少 ${result.removedIds.length} 个采集点`)
  } catch (error) {
    // PointMergeError：目标为空 / 并入自己 / 只搬一部分 —— 事务已回滚，两个点保持原样
    ElMessage.error(error instanceof PointMergeError ? error.message : '合并失败，两个采集点保持原样')
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">采集点管理</h2>
        <p class="page-sub">
          经纬度与海拔表单带格式校验；每个采集点展示条目数与主要基物，删除前校验下级条目数。
        </p>
      </div>
      <div class="head-btns">
        <el-button type="warning" plain @click="openMerge">合并采集点</el-button>
        <el-button @click="resetDraft">清空表单</el-button>
      </div>
    </div>

    <el-card shadow="never" class="form-card">
      <template #header>{{ editingId ? '编辑采集点' : '新增采集点' }}</template>
      <GeoPointForm v-model="draft" with-meta />
      <div class="actions">
        <el-button type="primary" @click="submit">{{ editingId ? '保存修改' : '新增采集点' }}</el-button>
      </div>
    </el-card>

    <h3 class="section-title">采集点清单（{{ pointState.points.length }}）</h3>
    <div class="card-grid">
      <el-card v-for="point in pointState.points" :key="point.id" shadow="hover" class="point-card">
        <div class="point-head">
          <div>
            <div class="point-name">{{ point.name }}</div>
            <div v-if="point.aliases.length > 0" class="point-aliases">
              <span class="aliases-lab">原称</span>
              <el-tag
                v-for="alias in point.aliases"
                :key="alias"
                size="small"
                type="info"
                effect="plain"
                class="alias-tag"
              >
                {{ alias }}
              </el-tag>
            </div>
            <div class="muted">
              {{ point.longitude.toFixed(4) }}, {{ point.latitude.toFixed(4) }} · {{ point.altitude }} m
            </div>
          </div>
          <el-tag effect="plain" size="small">条目 {{ recordsOf(point.id) }}</el-tag>
        </div>
        <el-descriptions :column="1" size="small" border class="desc">
          <el-descriptions-item label="植被类型">{{ point.vegetation }}</el-descriptions-item>
          <el-descriptions-item label="主要基物">{{ mainSubstrate(point) }}</el-descriptions-item>
          <el-descriptions-item label="伴生树种">{{ point.companionTrees || '—' }}</el-descriptions-item>
          <el-descriptions-item label="采集日期">{{ point.collectDate }}</el-descriptions-item>
          <el-descriptions-item label="采集人">{{ point.collector || '—' }}</el-descriptions-item>
        </el-descriptions>
        <div class="point-actions">
          <el-button size="small" @click="edit(point)">编辑</el-button>
          <el-button size="small" type="danger" plain @click="remove(point)">删除</el-button>
        </div>
      </el-card>
      <el-empty v-if="pointState.points.length === 0" description="暂无采集点" />
    </div>

    <el-dialog v-model="mergeVisible" title="合并采集点" width="640px" :close-on-click-modal="false">
      <div class="merge-body">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="同一样线被登记成多个点时使用：待并入点名下的菌物记录全部迁到保留点，伴生树种合并去重，被并点名作为原称保留，被并点从清单删除。"
          class="merge-tip"
        />
        <div class="merge-field">
          <span class="merge-lab">① 选择保留点</span>
          <el-select v-model="mergeKeepId" placeholder="合并后保留这一个" style="width: 100%">
            <el-option
              v-for="point in pointState.points"
              :key="point.id"
              :label="`${point.name}（条目 ${recordsOf(point.id)}）`"
              :value="point.id"
            />
          </el-select>
        </div>
        <div class="merge-field">
          <span class="merge-lab">② 勾选待并入点（从清单消失）</span>
          <el-checkbox-group v-model="mergeSourceIds" class="merge-checks">
            <el-checkbox
              v-for="point in pointState.points.filter((item) => item.id !== mergeKeepId)"
              :key="point.id"
              :value="point.id"
              border
              class="merge-check"
            >
              <span class="check-name">{{ point.name }}</span>
              <span class="muted">条目 {{ recordsOf(point.id) }} · 伴生 {{ point.companionTrees || '—' }}</span>
            </el-checkbox>
          </el-checkbox-group>
          <el-empty
            v-if="pointState.points.filter((item) => item.id !== mergeKeepId).length === 0"
            description="没有可并入的其他采集点"
            :image-size="60"
          />
        </div>

        <div v-if="mergeKeepPoint && mergeSourcePoints.length > 0" class="merge-preview">
          <div class="preview-row">
            <span class="preview-lab">菌物记录迁移</span>
            <span class="preview-count">{{ mergeMoveCount }} 条</span>
            <span class="muted">
              （保留点现有 {{ recordsOf(mergeKeepPoint.id) }} 条，合并后共
              {{ recordsOf(mergeKeepPoint.id) + mergeMoveCount }} 条）
            </span>
          </div>
          <div class="preview-row">
            <span class="preview-lab">保留点原称</span>
            <span v-if="mergeAliasesPreview.length === 0" class="muted">无</span>
            <el-tag
              v-for="alias in mergeAliasesPreview"
              :key="alias"
              size="small"
              type="info"
              effect="plain"
            >
              {{ alias }}
            </el-tag>
          </div>
          <div class="preview-row">
            <span class="preview-lab">伴生树种</span>
            <span v-if="mergeTreesPreview.length === 0" class="muted">—</span>
            <el-tag
              v-for="tree in mergeTreesPreview"
              :key="tree"
              size="small"
              type="success"
              effect="plain"
            >
              {{ tree }}
            </el-tag>
          </div>
        </div>

        <el-alert
          v-if="mergeBlocked"
          :title="mergeBlocked"
          type="warning"
          :closable="false"
          show-icon
          class="merge-tip"
        />
      </div>
      <template #footer>
        <el-button @click="mergeVisible = false">取消</el-button>
        <el-button type="warning" :loading="merging" :disabled="mergeBlocked !== null" @click="confirmMerge">
          确认合并（迁移 {{ mergeMoveCount }} 条）
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.form-card {
  border-radius: 12px;
}
.actions {
  margin-top: 12px;
}
.point-card {
  border-radius: 12px;
}
.point-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 10px;
}
.point-name {
  font-size: 15px;
  font-weight: 600;
}
.desc {
  margin-bottom: 10px;
}
.point-actions {
  display: flex;
  gap: 8px;
}
.head-btns {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.point-aliases {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0;
}
.aliases-lab {
  font-size: 11px;
  color: #8a94a0;
}
.alias-tag {
  border-style: dashed;
}
.merge-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.merge-tip {
  line-height: 1.6;
}
.merge-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.merge-lab {
  font-size: 13px;
  font-weight: 600;
  color: #4b5b50;
}
.merge-checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.merge-check {
  margin-right: 0;
  width: 100%;
  height: auto;
  display: flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 8px;
}
.check-name {
  margin-right: 8px;
  font-weight: 600;
}
.merge-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 10px;
  background: #f7f5f0;
  border: 1px solid #e8e2d6;
}
.preview-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
}
.preview-lab {
  min-width: 84px;
  color: #6f7d72;
}
.preview-count {
  font-size: 15px;
  font-weight: 700;
  color: #c96f3a;
}
</style>
