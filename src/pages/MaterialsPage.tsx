import { CloudUploadOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  App as AntApp,
  Button,
  Card,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useState } from 'react'
import { loadSettings } from '../settings'
import {
  deleteMaterial,
  listMaterials,
  onParseDone,
  onParseStage,
  uploadMaterial,
  type MaterialRecord,
} from '../tauri'

const STATUS_META: Record<string, { color: string; text: string }> = {
  parsing: { color: 'processing', text: '解析中' },
  uploading: { color: 'processing', text: '上传中' },
  uploaded: { color: 'success', text: '已上传' },
  failed: { color: 'error', text: '失败' },
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '-'
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function MaterialsPage() {
  const { message } = AntApp.useApp()
  const [rows, setRows] = useState<MaterialRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoading(true)
      try {
        setRows(await listMaterials())
      } catch (error) {
        message.error('读取本地记录失败：' + (error instanceof Error ? error.message : String(error)))
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [message],
  )

  useEffect(() => {
    void load()
  }, [load])

  // 解析阶段和结束事件都会更新本地 SQLite，这里顺带刷新列表。
  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const unlisteners: Array<() => void> = []
    const schedule = () => {
      if (disposed) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(false), 300)
    }
    void onParseStage(schedule).then((unlisten) => {
      if (disposed) unlisten()
      else unlisteners.push(unlisten)
    })
    void onParseDone(schedule).then((unlisten) => {
      if (disposed) unlisten()
      else unlisteners.push(unlisten)
    })
    return () => {
      disposed = true
      window.clearTimeout(timer)
      unlisteners.forEach((unlisten) => unlisten())
    }
  }, [load])

  const handleUpload = async (row: MaterialRecord) => {
    if (!row.zipPath) {
      message.error('这条记录没有可上传的 zip')
      return
    }
    const settings = loadSettings()
    if (!settings.server.trim()) {
      message.error('请先在「设置」中填写服务端地址')
      return
    }
    setUploadingId(row.examId)
    try {
      const result = await uploadMaterial({
        examId: row.examId,
        zipPath: row.zipPath,
        server: settings.server.trim(),
        lang: row.lang || 'de',
        level: row.level || 'A1',
        overwrite: true,
        python: settings.python.trim(),
      })
      message.success(
        result.response?.job_id
          ? `上传成功：${result.response.job_id}`
          : `上传成功：${row.examId}`,
      )
    } catch (error) {
      message.error(
        '上传失败：' + (error instanceof Error ? error.message : String(error)),
      )
    } finally {
      setUploadingId(null)
      void load(false)
    }
  }

  const handleDelete = async (row: MaterialRecord) => {
    setDeletingId(row.examId)
    try {
      await deleteMaterial(row.examId)
      message.success(`已删除：${row.examId}`)
    } catch (error) {
      message.error(
        '删除失败：' + (error instanceof Error ? error.message : String(error)),
      )
    } finally {
      setDeletingId(null)
      void load(false)
    }
  }

  const columns: ColumnsType<MaterialRecord> = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      render: (_, row) => {
        const meta = STATUS_META[row.status] ?? { color: 'default', text: row.status }
        return <Tag color={meta.color}>{meta.text}</Tag>
      },
    },
    {
      title: 'exam_id',
      dataIndex: 'examId',
      width: 210,
      render: (value: string) => <Typography.Text copyable>{value}</Typography.Text>,
    },
    { title: '标题', dataIndex: 'title', ellipsis: true, render: (value: string | null) => value || '-' },
    {
      title: '语种/等级',
      width: 110,
      render: (_, row) => `${row.lang || '-'} / ${row.level || '-'}`,
    },
    {
      title: '题目数',
      dataIndex: 'questionCount',
      width: 82,
      render: (value: number | null) => value ?? '-',
    },
    {
      title: '大小',
      dataIndex: 'sizeBytes',
      width: 92,
      render: (value: number | null) => formatBytes(value),
    },
    {
      title: 'ZIP',
      dataIndex: 'zipPath',
      width: 280,
      ellipsis: true,
      render: (value: string | null) =>
        value ? (
          <Typography.Text copyable={{ text: value }} ellipsis style={{ maxWidth: 260 }}>
            {value}
          </Typography.Text>
        ) : (
          '-'
        ),
    },
    {
      title: '服务端任务',
      dataIndex: 'serverJobId',
      width: 190,
      render: (value: string | null) => (value ? <Typography.Text copyable>{value}</Typography.Text> : '-'),
    },
    { title: '更新时间', dataIndex: 'updatedAt', width: 170 },
    {
      title: '备注',
      dataIndex: 'stageMessage',
      ellipsis: true,
      render: (_, row) => {
        if (row.error) {
          return (
            <Tooltip title={row.error}>
              <Typography.Text type="danger" ellipsis>
                {row.error}
              </Typography.Text>
            </Tooltip>
          )
        }
        return row.stageMessage || '-'
      },
    },
    {
      title: '操作',
      width: 150,
      fixed: 'right',
      render: (_, row) => {
        const busy = row.status === 'parsing' || row.status === 'uploading'
        return (
          <Space size={4}>
            {row.zipPath && row.status !== 'uploaded' ? (
              <Button
                size="small"
                icon={<CloudUploadOutlined />}
                loading={uploadingId === row.examId}
                disabled={row.status === 'parsing' || uploadingId !== null}
                onClick={() => void handleUpload(row)}
              >
                上传
              </Button>
            ) : row.status === 'uploaded' ? (
              <Typography.Text type="secondary">已上传</Typography.Text>
            ) : null}
            <Popconfirm
              title="删除这条解析记录？"
              description="只删除本地记录，Downloads 中的 zip 会保留。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={busy}
              onConfirm={() => void handleDelete(row)}
            >
              <Button
                size="small"
                danger
                type="text"
                icon={<DeleteOutlined />}
                loading={deletingId === row.examId}
                disabled={busy}
              >
                删除
              </Button>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <div className="page materials-page">
      <Card
        title="已解析听力"
        extra={
          <Space>
            <Typography.Text type="secondary">记录保存在本机 SQLite</Typography.Text>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<MaterialRecord>
          rowKey="examId"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows}
          scroll={{ x: 1600 }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
        />
      </Card>
    </div>
  )
}
