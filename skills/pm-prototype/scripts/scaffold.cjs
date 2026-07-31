#!/usr/bin/env node
/**
 * pm-prototype 脚手架:读取确认后的模块清单 JSON,生成原型项目骨架。
 * 用法: node scaffold.cjs <modules.json> <target-dir>
 * 前置: target-dir 已由 `npm create vite@latest <dir> -- --template vue && npm install` 创建。
 */
const fs = require('fs')
const path = require('path')

const [modulesFile, targetDir] = process.argv.slice(2)
if (!modulesFile || !targetDir) {
  console.error('Usage: node scaffold.cjs <modules.json> <target-dir>')
  process.exit(1)
}

const config = JSON.parse(fs.readFileSync(modulesFile, 'utf8'))
const modules = config.modules
if (!Array.isArray(modules) || modules.length === 0) {
  console.error('modules.json 必须包含非空 modules 数组')
  process.exit(1)
}
for (const m of modules) {
  if (!m.id || !m.name) {
    console.error(`模块缺少 id 或 name: ${JSON.stringify(m)}`)
    process.exit(1)
  }
}

const src = path.join(targetDir, 'src')
const ensure = (d) => fs.mkdirSync(d, { recursive: true })
ensure(path.join(src, 'components'))
ensure(path.join(src, 'mocks'))
ensure(path.join(src, 'views'))
ensure(path.join(src, 'router'))

// 1. 复制 ModuleSpec.vue(已存在则跳过,避免覆盖自定义版本)
const assetDir = path.join(__dirname, '..', 'assets')
const moduleSpecDest = path.join(src, 'components', 'ModuleSpec.vue')
const skipped = []
if (fs.existsSync(moduleSpecDest)) {
  skipped.push('components/ModuleSpec.vue(已存在)')
} else {
  fs.copyFileSync(path.join(assetDir, 'ModuleSpec.vue'), moduleSpecDest)
}

// 2. 生成 specs.js(已存在则跳过,需手动合并)
const specsPath = path.join(src, 'specs.js')
const specEntries = modules
  .map((m) => {
    const fields = ['goal', 'interaction', 'data', 'notes']
      .filter((f) => m[f])
      .map((f) => `    ${f}: ${JSON.stringify(m[f])}`)
      .join(',\n')
    return `  '${m.id}': {\n${fields}\n  }`
  })
  .join(',\n')
const specsContent = `// 由 scaffold.cjs 自动生成,内容与用户确认版一致,勿手动修改措辞。\nexport const specs = {\n${specEntries}\n}\n`
if (fs.existsSync(specsPath)) {
  skipped.push('specs.js(已存在,请手动合并以下条目)')
  console.log('\n[specs.js 已存在] 请将以下条目手动合并到现有 specs.js:')
  console.log(specEntries)
} else {
  fs.writeFileSync(specsPath, specsContent)
}

// 3. 生成 mock 骨架
for (const m of modules) {
  const mockPath = path.join(src, 'mocks', `${m.id}.js`)
  if (fs.existsSync(mockPath)) continue
  fs.writeFileSync(
    mockPath,
    `// ${m.name} mock — 参照 assets/mock.example.js 实现分页/搜索/筛选等模拟接口\nexport function fetch${toPascal(m.id)}List(params = {}) {\n  return new Promise((resolve) => {\n    setTimeout(() => resolve({ list: [], total: 0 }), 300)\n  })\n}\n`,
  )
}

// 4. 生成 views
for (const m of modules) {
  const viewPath = path.join(src, 'views', `${toPascal(m.id)}.vue`)
  if (fs.existsSync(viewPath)) continue
  fs.writeFileSync(
    viewPath,
    `<script setup>\nimport ModuleSpec from '../components/ModuleSpec.vue'\nimport { specs } from '../specs'\n</script>\n\n<template>\n  <ModuleSpec title="${m.name}" :spec="specs['${m.id}']">\n    <div class="${m.id}-placeholder">\n      <!-- TODO: 实现 ${m.name} 模块 UI -->\n      <p>${m.name}(待实现)</p>\n    </div>\n  </ModuleSpec>\n</template>\n`,
  )
}

// 5. 生成 router(已存在则输出路由片段供手动合并)
const routerPath = path.join(src, 'router', 'index.js')
const routes = modules
  .map(
    (m) =>
      `  { path: '/${m.id}', name: '${m.id}', component: () => import('../views/${toPascal(m.id)}.vue') }`,
  )
  .join(',\n')
const routerContent = `import { createRouter, createWebHistory } from 'vue-router'\n\nexport default createRouter({\n  history: createWebHistory(),\n  routes: [\n    { path: '/', redirect: '/${modules[0].id}' },\n${routes}\n  ],\n})\n`
if (fs.existsSync(routerPath)) {
  skipped.push('router/index.js(已存在)')
  console.log('\n[router 已存在] 请将以下路由合并到现有 router:')
  console.log(routes)
} else {
  fs.writeFileSync(routerPath, routerContent)
}

// 6. 生成 App.vue(已存在则输出导航片段供手动合并)
const appPath = path.join(src, 'App.vue')
const navItems = modules
  .map((m) => `      <router-link to="/${m.id}">${m.name}</router-link>`)
  .join('\n')
const appContent = `<script setup>\n</script>\n\n<template>\n  <div id="app-shell">\n    <nav class="app-nav">\n${navItems}\n    </nav>\n    <main class="app-main">\n      <router-view />\n    </main>\n  </div>\n</template>\n\n<style>\n* { margin: 0; padding: 0; box-sizing: border-box; }\nbody { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #f5f5f5; }\n.app-nav { display: flex; gap: 4px; padding: 12px 20px; background: #fff; border-bottom: 1px solid #e5e7eb; }\n.app-nav a { padding: 6px 14px; border-radius: 6px; text-decoration: none; color: #374151; font-size: 14px; }\n.app-nav a.router-link-active { background: #f59e0b; color: #fff; }\n.app-main { padding: 20px; max-width: 1200px; margin: 0 auto; }\n</style>\n`
if (fs.existsSync(appPath)) {
  skipped.push('App.vue(已存在)')
  console.log('\n[App.vue 已存在] 请将以下导航项合并到现有模板:')
  console.log(navItems)
} else {
  fs.writeFileSync(appPath, appContent)
}

// 7. 生成 main.js(已存在则输出 router 注册片段供手动合并)
const mainPath = path.join(src, 'main.js')
const mainContent = `import { createApp } from 'vue'\nimport App from './App.vue'\nimport router from './router'\n\ncreateApp(App).use(router).mount('#app')\n`
if (fs.existsSync(mainPath)) {
  skipped.push('main.js(已存在)')
  console.log("\n[main.js 已存在] 请确保已注册 router: import router from './router'; app.use(router)")
} else {
  fs.writeFileSync(mainPath, mainContent)
}

console.log(`\nscaffold 完成: ${modules.length} 个模块`)
console.log(`  specs.js  ← ${modules.map((m) => m.id).join(', ')}`)
console.log(`  mocks/    ← ${modules.map((m) => m.id + '.js').join(', ')}`)
console.log(`  views/    ← ${modules.map((m) => toPascal(m.id) + '.vue').join(', ')}`)
if (skipped.length) {
  console.log(`\n⚠ 以下文件已存在,未覆盖(请根据上方提示手动合并):`)
  skipped.forEach((s) => console.log(`  - ${s}`))
} else {
  console.log('下一步: 安装 vue-router (npm i vue-router),然后逐模块实现 views/ 下的 UI。')
}

function toPascal(s) {
  return s.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())
}
