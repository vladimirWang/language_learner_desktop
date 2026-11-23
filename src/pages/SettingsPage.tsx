import { App as AntApp, Alert, Button, Card, Form, Input, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { loadSettings, saveSettings, type DesktopSettings } from '../settings'
import { getDefaultBuilderRoot } from '../tauri'

export default function SettingsPage() {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm<DesktopSettings>()
  const [testing, setTesting] = useState(false)
  const [autoFilling, setAutoFilling] = useState(false)

  useEffect(() => {
    form.setFieldsValue(loadSettings())
  }, [form])

  const handleSave = (values: DesktopSettings) => {
    saveSettings({
      server: values.server.trim(),
      builderRoot: values.builderRoot.trim(),
      python: values.python?.trim() ?? '',
      workDir: values.workDir?.trim() ?? '',
    })
    message.success('设置已保存')
  }

  const handleTest = async () => {
    const server = (form.getFieldValue('server') as string | undefined)?.trim()
    if (!server) {
      message.warning('请先填写服务端地址')
      return
    }
    setTesting(true)
    try {
      const response = await fetch(server.replace(/\/$/, '') + '/api/health')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { status?: string }
      message.success(`服务端可用：${body.status ?? 'ok'}`)
    } catch (error) {
      message.error('连接失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setTesting(false)
    }
  }

  const handleAutoFill = async () => {
    setAutoFilling(true)
    try {
      const root = await getDefaultBuilderRoot()
      form.setFieldValue('builderRoot', root)
      message.success('已填入 builder 目录')
    } catch (error) {
      message.error('自动探测失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setAutoFilling(false)
    }
  }

  return (
    <div className="page">
      <Card title="设置">
        <Alert
          type="info"
          showIcon
          message="仅影响本机开发"
          description="解析记录保存在本机 SQLite；生成的 zip 保留在系统下载目录，解析临时目录在上传成功后会清理。"
          style={{ marginBottom: 16 }}
        />
        <Form<DesktopSettings> form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item
            name="server"
            label="服务端地址"
            rules={[{ required: true, message: '请填写服务端地址' }]}
          >
            <Input placeholder="http://127.0.0.1:8080" allowClear />
          </Form.Item>

          <Form.Item
            name="builderRoot"
            label="builder 目录"
            rules={[{ required: true, message: '请填写 builder 目录' }]}
            extra="指向 language_learner_backend/builder，侧车通过 uv 复用其中的 faster-whisper 解析逻辑。"
          >
            <Input
              placeholder="/Users/you/fullstack_workspace/language_learn/language_learner_backend/builder"
              allowClear
              addonAfter={
                <Button type="link" size="small" loading={autoFilling} onClick={() => void handleAutoFill()}>
                  自动填入
                </Button>
              }
            />
          </Form.Item>

          <Form.Item
            name="python"
            label="Python 解释器（可选）"
            extra="留空时优先使用 desktop/.venv/bin/python（由 uv sync 生成），其次使用 uv；两者都不可用时才回退系统 Python。"
          >
            <Input placeholder="python3" allowClear />
          </Form.Item>

          <Form.Item
            name="workDir"
            label="工作目录（可选）"
            extra="留空使用 ~/.cache/language-learner-desktop/work；Whisper 模型缓存在此保留，解析产物上传后删除，zip 保留在下载目录。"
          >
            <Input placeholder="/tmp/ll-desktop" allowClear />
          </Form.Item>

          <Space>
            <Button type="primary" htmlType="submit">
              保存
            </Button>
            <Button loading={testing} onClick={() => void handleTest()}>
              测试服务端连接
            </Button>
          </Space>
        </Form>
      </Card>

      <Card title="上传契约" size="small">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          desktop 与 backend 之间只传一个 zip：解压后需包含 manifest.json，以及
          manifest 引用的 media_file、audio/、images/ 等文件。上传接口为
          <Typography.Text code>POST /api/listening/upload</Typography.Text>
          ，服务端校验通过后直接登记为 built 任务，不再跑 Python。
        </Typography.Paragraph>
      </Card>
    </div>
  )
}
