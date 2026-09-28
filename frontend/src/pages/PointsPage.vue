<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { CollectPoint } from '@/types'
import GeoPointForm from '@/components/common/GeoPointForm.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { pointStore } from '@/stores/pointStore'
import { recordStore } from '@/stores/recordStore'
import { mergeTrees } from '@/utils/point'
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
  formerNames: [],
  collectDate: new Date().toISOString().slice(0, 10),
  collector: ''
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
  draft.formerNames = []
  draft.collector = ''
  draft.collectDate = new Date().toISOString().slice(0, 10)
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

/* ---------- 采集点合并 ---------- */
const mergeVisible = ref(false)
/** 要保留的采集点 id */
const mergeKeepId = ref('')
/** 待并入（会消失）的采集点 id */
const mergeAbsorbId = ref('')
const merging = ref(false)

const mergeKeepPoint = computed<CollectPoint | null>(
  () => pointState.points.find((point) => point.id === mergeKeepId.value) ?? null
)
const mergeAbsorbPoint = computed<CollectPoint | null>(
  () => pointState.points.find((point) => point.id === mergeAbsorbId.value) ?? null
)

/** 确认前让用户看清：待并入点名下将迁移多少条菌物记录 */
const mergeRecordCount = computed<number>(() => {
  if (!mergeAbsorbId.value || mergeAbsorbId.value === mergeKeepId.value) return 0
  return recordState.records.filter((record) => record.pointId === mergeAbsorbId.value).length
})

/** 合并后保留点将拥有的条目数 */
const mergeTargetCount = computed<number>(() => {
  if (!mergeKeepId.value || mergeKeepId.value === mergeAbsorbId.value) return 0
  return recordState.records.filter((record) => record.pointId === mergeKeepId.value).length
})

/** 合并去重后的伴生树种预览 */
const mergedTreesPreview = computed<string>(() => {
  if (!mergeKeepPoint.value || !mergeAbsorbPoint.value) return ''
  return mergeTrees(mergeKeepPoint.value.companionTrees, mergeAbsorbPoint.value.companionTrees)
})

/** 合并后保留点的曾用名预览（被并点名称变成原称保留下来） */
const mergedFormerNamesPreview = computed<string[]>(() => {
  if (!mergeKeepPoint.value || !mergeAbsorbPoint.value) return []
  const names = new Set<string>(mergeKeepPoint.value.formerNames ?? [])
  for (const name of mergeAbsorbPoint.value.formerNames ?? []) names.add(name)
  names.add(mergeAbsorbPoint.value.name)
  return [...names]
})

const mergeError = computed<string | null>(() => {
  if (!mergeKeepId.value) return '请先选择要保留的采集点'
  if (!mergeAbsorbId.value) return '请再选择待并入的采集点'
  if (mergeKeepId.value === mergeAbsorbId.value) return '保留点与待并入点不能是同一个采集点'
  return null
})

/** 从某张卡片发起合并：该卡默认作为「待并入点」，再选一个保留点 */
function openMerge(absorb?: CollectPoint): void {
  if (pointState.points.length < 2) {
    ElMessage.warning('至少需要两个采集点才能合并')
    return
  }
  mergeAbsorbId.value = absorb?.id ?? ''
  mergeKeepId.value = pointState.points.find((point) => point.id !== mergeAbsorbId.value)?.id ?? ''
  mergeVisible.value = true
}

function resetMerge(): void {
  mergeVisible.value = false
  mergeKeepId.value = ''
  mergeAbsorbId.value = ''
  merging.value = false
}

async function confirmMerge(): Promise<void> {
  if (mergeError.value) {
    // 校验未过时停下来说明原因，不写任何数据
    ElMessage.warning(mergeError.value)
    return
  }
  const keep = mergeKeepPoint.value
  const absorb = mergeAbsorbPoint.value
  if (!keep || !absorb) return
  try {
    await ElMessageBox.confirm(
      `将把「${absorb.name}」并入「${keep.name}」：迁移 ${mergeRecordCount.value} 条菌物记录，` +
        `「${absorb.name}」名称保留为曾用名，伴生树种合并去重，并入后该点从清单消失。确认继续？`,
      '合并确认',
      { type: 'warning', confirmButtonText: '确认合并', cancelButtonText: '再想想' }
    )
  } catch {
    return // 用户在系统确认框取消，什么都不做
  }

  merging.value = true
  try {
    const result = await pointStore.getState().merge(mergeKeepId.value, mergeAbsorbId.value)
    ElMessage.success(
      `已并入「${result.keptPoint.name}」：迁移 ${result.moved} 条菌物记录，合并后共 ${recordsOf(result.keptPoint.id)} 条`
    )
    resetMerge()
  } catch (error) {
    // 只搬了一部分 / 目标为空 / 并入自己等情况：停下来说明原因，两个点保持原样
    ElMessage.error(error instanceof Error ? error.message : '合并失败，两个采集点均未改动')
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
          经纬度与海拔表单带格式校验；每个采集点展示条目数与主要基物，删除前校验下级条目数；同一条样线被重复登记时可用「合并」归并条目并保留旧名称。
        </p>
      </div>
      <el-button @click="resetDraft">清空表单</el-button>
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
            <div v-if="point.formerNames && point.formerNames.length > 0" class="former-names">
              曾用名：
              <el-tag
                v-for="former in point.formerNames"
                :key="former"
                size="small"
                type="info"
                effect="plain"
                class="former-tag"
              >
                {{ former }}
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
          <el-button size="small" type="warning" plain :disabled="pointState.points.length < 2" @click="openMerge(point)">
            合并
          </el-button>
          <el-button size="small" type="danger" plain @click="remove(point)">删除</el-button>
        </div>
      </el-card>
      <el-empty v-if="pointState.points.length === 0" description="暂无采集点" />
    </div>

    <el-dialog v-model="mergeVisible" title="合并采集点" width="600px" @closed="resetMerge">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="同一条样线被多人重复登记时，把待并入点归并到要保留的点：菌物记录全部迁移，旧名称作为曾用名保留，伴生树种合并去重，待并入点从清单消失。"
        class="merge-tip"
      />
      <el-form label-width="130px" class="merge-form">
        <el-form-item label="保留的采集点" required>
          <el-select v-model="mergeKeepId" placeholder="选择合并后保留的采集点" style="width: 100%">
            <el-option
              v-for="point in pointState.points.filter((item) => item.id !== mergeAbsorbId)"
              :key="point.id"
              :label="`${point.name}（现有 ${recordsOf(point.id)} 条）`"
              :value="point.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="待并入的采集点" required>
          <el-select v-model="mergeAbsorbId" placeholder="选择将被并入并消失的采集点" style="width: 100%">
            <el-option
              v-for="point in pointState.points.filter((item) => item.id !== mergeKeepId)"
              :key="point.id"
              :label="`${point.name}（现有 ${recordsOf(point.id)} 条）`"
              :value="point.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <p v-if="mergeError" class="merge-err">{{ mergeError }}</p>

      <div v-if="!mergeError && mergeKeepPoint && mergeAbsorbPoint" class="merge-preview">
        <div class="preview-row">
          <span class="preview-lab">将迁移菌物记录</span>
          <el-tag type="warning" effect="dark" size="small">{{ mergeRecordCount }} 条</el-tag>
          <span class="muted">
            合并后「{{ mergeKeepPoint.name }}」共 {{ mergeTargetCount + mergeRecordCount }} 条
          </span>
        </div>
        <div class="preview-row">
          <span class="preview-lab">保留点曾用名</span>
          <span>
            <el-tag
              v-for="former in mergedFormerNamesPreview"
              :key="former"
              size="small"
              type="info"
              effect="plain"
              class="former-tag"
            >
              {{ former }}
            </el-tag>
          </span>
        </div>
        <div class="preview-row">
          <span class="preview-lab">伴生树种（去重）</span>
          <span>{{ mergedTreesPreview || '—' }}</span>
        </div>
        <div class="preview-row">
          <span class="preview-lab">并入后消失</span>
          <el-tag type="danger" effect="plain" size="small">{{ mergeAbsorbPoint.name }}</el-tag>
        </div>
      </div>

      <template #footer>
        <el-button @click="mergeVisible = false">取消</el-button>
        <el-button type="primary" :loading="merging" :disabled="Boolean(mergeError)" @click="confirmMerge">
          确认合并
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
.former-names {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0;
  font-size: 12px;
  color: #8a93a0;
}
.former-tag {
  margin: 0;
}
.merge-tip {
  margin-bottom: 14px;
}
.merge-err {
  margin: 4px 0 0;
  font-size: 12px;
  color: #c0392b;
}
.merge-preview {
  margin-top: 4px;
  padding: 12px 14px;
  border: 1px solid #e8e2d6;
  border-radius: 10px;
  background: #faf8f3;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.preview-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}
.preview-lab {
  min-width: 118px;
  color: #6f7d72;
}
</style>
