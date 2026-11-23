export interface DesktopSettings {
  /** backend 地址，本地开发默认 http://127.0.0.1:8080 */
  server: string
  /** language_learner_backend/builder 的绝对路径 */
  builderRoot: string
  /** 可选：uv 不可用时的 Python 解释器 */
  python: string
  /** 可选：解析临时目录，留空使用系统临时目录 */
  workDir: string
}

const STORAGE_KEY = 'll-desktop-settings'

const DEFAULTS: DesktopSettings = {
  server: 'http://127.0.0.1:8080',
  builderRoot: '',
  python: '',
  workDir: '',
}

export function loadSettings(): DesktopSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<DesktopSettings>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: DesktopSettings): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}
