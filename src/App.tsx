import { Layout, Menu } from 'antd'
import { Link, Route, Routes, useLocation } from 'react-router-dom'
import MaterialsPage from './pages/MaterialsPage'
import ParsePage from './pages/ParsePage'
import SettingsPage from './pages/SettingsPage'

const items = [
  { key: '/', label: <Link to="/">解析与上传</Link> },
  { key: '/materials', label: <Link to="/materials">已解析听力</Link> },
  { key: '/settings', label: <Link to="/settings">设置</Link> },
]

export default function App() {
  const location = useLocation()
  return (
    <Layout className="app-shell">
      <Layout.Header className="app-header">
        <div className="brand">听力素材工作台</div>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[location.pathname]}
          items={items}
          className="app-menu"
        />
      </Layout.Header>
      <Layout.Content className="app-content">
        <Routes>
          <Route path="/" element={<ParsePage />} />
          <Route path="/materials" element={<MaterialsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Layout.Content>
    </Layout>
  )
}
