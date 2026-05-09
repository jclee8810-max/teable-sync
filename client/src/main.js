import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import {
  ArrowDown,
  Bell,
  Check,
  Connection,
  DataAnalysis,
  Delete,
  Document,
  Edit,
  FirstAidKit,
  Key,
  Link,
  Loading,
  MagicStick,
  MoreFilled,
  Plus,
  Promotion,
  Refresh,
  RefreshRight,
  Search,
  SwitchButton,
  User,
  VideoPlay,
  View,
} from '@element-plus/icons-vue'
import App from './App.vue'

const app = createApp(App)
app.use(ElementPlus, { namespace: 'el' })

const icons = {
  ArrowDown,
  Bell,
  Check,
  Connection,
  DataAnalysis,
  Delete,
  Document,
  Edit,
  FirstAidKit,
  Key,
  Link,
  Loading,
  MagicStick,
  MoreFilled,
  Plus,
  Promotion,
  Refresh,
  RefreshRight,
  Search,
  SwitchButton,
  User,
  VideoPlay,
  View,
}

for (const [key, component] of Object.entries(icons)) {
  app.component(key, component)
}

app.mount('#app')
