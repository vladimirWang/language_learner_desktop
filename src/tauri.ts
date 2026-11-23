import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface ParseRequest {
  url: string
  examId: string
  lang: string
  model: string
  profile: string
  level: string
  answers: string
  cookies: string
  server: string
  builderRoot: string
  workDir: string
  overwrite: boolean
  python: string
}

export interface ParseDonePayload {
  code: number
  error?: string
}

export interface ParseStage {
  stage: string
  message?: string
}

/** 本地 SQLite 中的一条已解析听力记录。 */
export interface MaterialRecord {
  examId: string
  title: string | null
  lang: string
  level: string | null
  sourceUrl: string | null
  status: 'parsing' | 'uploaded' | 'failed' | string
  stage: string | null
  stageMessage: string | null
  serverJobId: string | null
  zipPath: string | null
  questionCount: number | null
  fileCount: number | null
  sizeBytes: number | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface UploadedMaterial {
  job_id: string
  exam_id: string
  lang: string
  level: string
  status: string
  files: number
  bytes: number
  manifest: string
}

/** 手动补传一个已解析好的 zip。 */
export interface UploadMaterialRequest {
  examId: string
  zipPath: string
  server: string
  lang: string
  level: string
  overwrite: boolean
  python: string
}

export interface UploadMaterialResult {
  ok: boolean
  response?: UploadedMaterial
  zip_path?: string
  title?: string | null
  question_count?: number | null
}

export const startParse = (req: ParseRequest) => invoke<void>('start_parse', { req })

export const uploadMaterial = (req: UploadMaterialRequest) =>
  invoke<UploadMaterialResult>('upload_material', { req })

/** 删除一条本地解析记录（不动 Downloads 里的 zip）。 */
export const deleteMaterial = (examId: string) =>
  invoke<void>('delete_material', { examId })

export const getDefaultBuilderRoot = () => invoke<string>('default_builder_root')

export const listMaterials = () => invoke<MaterialRecord[]>('list_materials')

export const onParseLog = (handler: (line: string) => void): Promise<UnlistenFn> =>
  listen<string>('parse-log', (event) => handler(event.payload))

export const onParseStage = (handler: (stage: ParseStage) => void): Promise<UnlistenFn> =>
  listen<ParseStage>('parse-stage', (event) => handler(event.payload))

export const onParseDone = (handler: (payload: ParseDonePayload) => void): Promise<UnlistenFn> =>
  listen<ParseDonePayload>('parse-done', (event) => handler(event.payload))
