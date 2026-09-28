/**
 * 伴生树种为自由填写的文本，用「、，,；; / /」等分隔。
 * 这里按常见中英文分隔符拆分，便于合并时去重。
 */
const TREE_SEPARATORS = /[、，,；;／/]+/

/** 拆分伴生树种文本为单个树种，去掉空白与空项 */
export function splitTrees(text: string): string[] {
  return text
    .split(TREE_SEPARATORS)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * 合并两处伴生树种并去重，保留点原有树种顺序在前，并入点的新树种追加在后。
 * @returns 用中文顿号连接的树种字符串
 */
export function mergeTrees(keep: string, absorb: string): string {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const tree of [...splitTrees(keep), ...splitTrees(absorb)]) {
    if (!seen.has(tree)) {
      seen.add(tree)
      merged.push(tree)
    }
  }
  return merged.join('、')
}

/** 合并曾用名列表并去重，保留先后顺序 */
export function mergeFormerNames(names: string[][]): string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const name of names.flat()) {
    const trimmed = name.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      merged.push(trimmed)
    }
  }
  return merged
}
