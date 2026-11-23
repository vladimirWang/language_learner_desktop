import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Form,
  Input,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd'
import { PlayCircleOutlined } from '@ant-design/icons'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { loadSettings, saveSettings, type DesktopSettings } from '../settings'
import {
  getDefaultBuilderRoot,
  onParseDone,
  onParseLog,
  onParseStage,
  startParse,
  type ParseStage,
  type UploadedMaterial,
} from '../tauri'

interface FormValues {
  url: string
  examId: string
  lang: string
  model: string
  profile: string
  level: string
  answers?: string
  cookies?: string
  overwrite?: boolean
}

const LANG_OPTIONS = [
  { value: 'de', label: '德语' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
]

const LEVEL_OPTIONS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((value) => ({ value, label: value }))

const MODEL_OPTIONS = [
  { value: 'tiny', label: 'tiny（最快，精度最低）' },
  { value: 'base', label: 'base' },
  { value: 'small', label: 'small（推荐）' },
  { value: 'medium', label: 'medium（更准，更慢）' },
]

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const STAGE_TEXT: Record<string, string> = {
  start: '已提交解析',
  downloading: '下载音视频',
  downloaded: '下载完成',
  parsing_pending: '等待转写',
  parsing: '语音转写中',
  packaging: '打包素材',
  uploading: '上传素材',
  done: '已上传',
  failed: '失败',
}

function stageLabel(stage: ParseStage): string {
  return stage.message || STAGE_TEXT[stage.stage] || stage.stage
}

export default function ParsePage() {
  const { message } = AntApp.useApp()
  const [settings, setSettings] = useState<DesktopSettings>(() => loadSettings())
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [stage, setStage] = useState<ParseStage | null>(null)
  const [result, setResult] = useState<UploadedMaterial | null>(null)
  const [zipPath, setZipPath] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const logsRef = useRef<string[]>([])
  const logPanelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const initial = loadSettings()
    if (initial.builderRoot) return
    void getDefaultBuilderRoot()
      .then((root) => {
        setSettings((prev) => {
          const next = { ...prev, builderRoot: root }
          // localStorage 不可用（如 WebKit 目录无权限）时也要能继续解析
          try {
            saveSettings(next)
          } catch {
            // 忽略持久化失败，仅影响下次启动的默认值
          }
          return next
        })
      })
      .catch(() => {
        // 浏览器里直接打开时没有 Tauri 环境，忽略即可
      })
  }, [])

  useEffect(() => {
    let disposed = false
    let unlistenLog: (() => void) | undefined
    let unlistenStage: (() => void) | undefined
    let unlistenDone: (() => void) | undefined

    void onParseLog((line) => {
      if (disposed) return
      logsRef.current = [...logsRef.current, line]
      setLogs(logsRef.current)
    }).then((unlisten) => {
      if (disposed) unlisten()
      else unlistenLog = unlisten
    })

    void onParseStage((payload) => {
      if (disposed) return
      setStage(payload)
    }).then((unlisten) => {
      if (disposed) unlisten()
      else unlistenStage = unlisten
    })

    void onParseDone((payload) => {
      if (disposed) return
      setRunning(false)
      if (payload.code !== 0) {
        setFailure(payload.error ?? `解析进程退出码 ${payload.code}`)
        return
      }
      const resultLine = [...logsRef.current].reverse().find((line) => line.startsWith('RESULT '))
      if (!resultLine) {
        setFailure('解析结束但没有收到上传结果')
        return
      }
      try {
        const parsed = JSON.parse(resultLine.slice('RESULT '.length)) as {
          ok: boolean
          error?: string
          response?: UploadedMaterial
          zip_path?: string
        }
        if (parsed.ok && parsed.response) {
          setResult(parsed.response)
          setZipPath(parsed.zip_path ?? null)
          setStage({ stage: 'done', message: '已上传' })
          message.success(`素材已上传：${parsed.response.exam_id}`)
        } else {
          setFailure(parsed.error ?? '上传失败')
        }
      } catch (error) {
        setFailure('解析结果格式错误：' + errorText(error))
      }
    }).then((unlisten) => {
      if (disposed) unlisten()
      else unlistenDone = unlisten
    })

    return () => {
      disposed = true
      unlistenLog?.()
      unlistenStage?.()
      unlistenDone?.()
    }
  }, [message])

  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight
    }
  }, [logs.length])

  const handleStart = async (values: FormValues) => {
    if (!settings.builderRoot.trim()) {
      message.error('请先在「设置」中填写 builder 目录')
      return
    }
    setRunning(true)
    setFailure(null)
    setResult(null)
    setZipPath(null)
    setStage({ stage: 'start', message: '已提交解析' })
    logsRef.current = []
    setLogs([])

    try {
      await startParse({
        url: values.url.trim(),
        examId: values.examId.trim(),
        lang: values.lang,
        model: values.model,
        profile: values.profile,
        level: values.level,
        answers: values.answers?.trim() ?? '',
        cookies: values.cookies?.trim() ?? '',
        server: settings.server.trim(),
        builderRoot: settings.builderRoot.trim(),
        workDir: settings.workDir.trim(),
        overwrite: Boolean(values.overwrite),
        python: settings.python.trim(),
      })
    } catch (error) {
      setRunning(false)
      message.error('启动解析失败：' + errorText(error))
    }
  }

  return (
    <div className="page">
      {!settings.builderRoot ? (
        <Alert
          type="warning"
          showIcon
          message="尚未配置 builder 目录"
          description={
            <span>
              请先到 <Link to="/settings">设置</Link> 填写 language_learner_backend/builder 的路径。
            </span>
          }
        />
      ) : null}

      <Card title="解析听力素材">
        <Form<FormValues>
          layout="vertical"
          initialValues={{
            lang: 'de',
            model: 'small',
            profile: 'goethe-a1',
            level: 'A1',
            examId: '',
          }}
          onFinish={(values) => void handleStart(values)}
          disabled={running}
        >
          <Form.Item
            name="url"
            label="视频 / 音频地址"
            rules={[{ required: true, message: '请填写 URL' }]}
          >
            <Input placeholder="https://www.bilibili.com/video/BV..." allowClear />
          </Form.Item>

          <Space size={16} style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Form.Item
              name="examId"
              label="exam_id（输出目录名）"
              rules={[
                { required: true, message: '请填写 exam_id' },
                { pattern: /^[A-Za-z0-9_-]{1,64}$/, message: '仅支持字母、数字、下划线和中划线' },
              ]}
              style={{ minWidth: 260 }}
            >
              <Input placeholder="goethe-a1-hoeren-01" allowClear />
            </Form.Item>
            <Form.Item name="lang" label="语种" style={{ minWidth: 140 }}>
              <Select options={LANG_OPTIONS} />
            </Form.Item>
            <Form.Item name="level" label="等级" style={{ minWidth: 120 }}>
              <Select options={LEVEL_OPTIONS} />
            </Form.Item>
            <Form.Item name="profile" label="考试类型" style={{ minWidth: 240 }}>
              <Select
                options={[
                  { value: 'goethe-a1', label: 'Goethe A1（Teil 1–3，1–15 题）' },
                  { value: '', label: '通用规则（仅按题号提示切分）' },
                ]}
              />
            </Form.Item>
            <Form.Item name="model" label="Whisper 模型" style={{ minWidth: 220 }}>
              <Select options={MODEL_OPTIONS} />
            </Form.Item>
          </Space>

          <Space size={16} style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Form.Item name="cookies" label="cookies.txt（可选）" style={{ minWidth: 320 }}>
              <Input placeholder="/Users/you/cookies.txt" allowClear />
            </Form.Item>
            <Form.Item name="answers" label="答案 CSV（可选）" style={{ minWidth: 320 }}>
              <Input placeholder="/Users/you/answers.csv" allowClear />
            </Form.Item>
          </Space>

          <Form.Item name="overwrite" valuePropName="checked">
            <Checkbox>服务端已存在同名 exam_id 时覆盖</Checkbox>
          </Form.Item>

          <Space>
            <Button
              type="primary"
              htmlType="submit"
              icon={<PlayCircleOutlined />}
              loading={running}
            >
              {running ? '解析中…' : '开始解析并上传'}
            </Button>
            <Typography.Text type="secondary">
              本地 faster-whisper 解析，完成后自动打包上传到 {settings.server || '未配置服务端'}
            </Typography.Text>
          </Space>
        </Form>
      </Card>

      {stage && running ? (
        <Alert type="info" showIcon message={`当前阶段：${stageLabel(stage)}`} />
      ) : null}

      {failure ? <Alert type="error" showIcon message="执行失败" description={failure} /> : null}

      {result ? (
        <Card
          title={
            <Space>
              <Tag color="success">已上传</Tag>
              {result.exam_id}
            </Space>
          }
        >
          <Descriptions column={2} size="small">
            <Descriptions.Item label="job_id">{result.job_id}</Descriptions.Item>
            <Descriptions.Item label="语种">{result.lang}</Descriptions.Item>
            <Descriptions.Item label="等级">{result.level}</Descriptions.Item>
            <Descriptions.Item label="文件数">{result.files}</Descriptions.Item>
            <Descriptions.Item label="大小">
              {(result.bytes / 1024 / 1024).toFixed(1)} MB
            </Descriptions.Item>
            <Descriptions.Item label="manifest">{result.manifest}</Descriptions.Item>
            {zipPath ? (
              <Descriptions.Item label="ZIP 文件" span={2}>
                <Typography.Text copyable>{zipPath}</Typography.Text>
              </Descriptions.Item>
            ) : null}
          </Descriptions>
        </Card>
      ) : null}

      <Card
        title="运行日志"
        extra={<Typography.Text type="secondary">{logs.length} 行</Typography.Text>}
      >
        <div className="log-panel" ref={logPanelRef}>
          {logs.length === 0 ? (
            <span className="log-empty">等待开始…</span>
          ) : (
            logs.map((line, index) => <div key={index}>{line}</div>)
          )}
        </div>
      </Card>
    </div>
  )
}
