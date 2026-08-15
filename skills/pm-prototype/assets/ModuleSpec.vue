<script setup>
import { ref, watch, onUnmounted } from 'vue'

defineProps({
  title: { type: String, required: true },
  spec: { type: Object, required: true },
})

const open = ref(false)

const onKeydown = (e) => {
  if (e.key === 'Escape') open.value = false
}
watch(open, (v) => {
  if (v) window.addEventListener('keydown', onKeydown)
  else window.removeEventListener('keydown', onKeydown)
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

/**
 * 零依赖 Markdown → HTML 渲染
 * 支持：双换行分段、**粗体**、- 列表
 */
function renderSpec(text) {
  if (!text) return ''
  return text
    .split(/\n\n+/)
    .map((para) => {
      const lines = para.split('\n')
      // 以 - 开头的连续行 → <ul>
      if (lines.every((l) => /^-\s/.test(l) || l === '')) {
        const items = lines
          .filter((l) => /^-\s/.test(l))
          .map((l) => `<li>${l.replace(/^-\s/, '')}</li>`)
          .join('')
        return `<ul>${items}</ul>`
      }
      // **粗体**
      const bold = para.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      return `<p>${bold}</p>`
    })
    .join('')
}
</script>

<template>
  <div class="module-spec-wrapper">
    <slot />
    <button class="module-spec-badge" title="查看产品说明" @click="open = true">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="11" x2="12" y2="16" />
        <circle cx="12" cy="7.5" r="0.5" fill="currentColor" />
      </svg>
    </button>

    <Teleport to="body">
      <div v-if="open" class="module-spec-mask" @click.self="open = false">
        <div class="module-spec-panel">
          <div class="module-spec-header">
            <h3>{{ title }} · 产品说明</h3>
            <button class="module-spec-close" @click="open = false">&times;</button>
          </div>
          <div class="module-spec-body">
            <section v-if="spec.goal">
              <h4>模块目标</h4>
              <div v-html="renderSpec(spec.goal)"></div>
            </section>
            <section v-if="spec.interaction">
              <h4>交互说明</h4>
              <div v-html="renderSpec(spec.interaction)"></div>
            </section>
            <section v-if="spec.data">
              <h4>数据说明</h4>
              <div v-html="renderSpec(spec.data)"></div>
            </section>
            <section v-if="spec.notes">
              <h4>边界与备注</h4>
              <div v-html="renderSpec(spec.notes)"></div>
            </section>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.module-spec-wrapper {
  position: relative;
}
.module-spec-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 10;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: #f59e0b;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.15s, transform 0.15s;
}
.module-spec-badge:hover {
  opacity: 1;
  transform: scale(1.1);
}
.module-spec-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}
.module-spec-panel {
  width: min(560px, 92vw);
  max-height: 80vh;
  overflow-y: auto;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}
.module-spec-header {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
}
.module-spec-header h3 {
  margin: 0;
  font-size: 16px;
  color: #111827;
}
.module-spec-close {
  border: none;
  background: none;
  font-size: 22px;
  color: #6b7280;
  cursor: pointer;
  line-height: 1;
}
.module-spec-body {
  padding: 16px 20px 20px;
}
.module-spec-body section + section {
  margin-top: 14px;
}
.module-spec-body h4 {
  margin: 0 0 4px;
  font-size: 13px;
  color: #d97706;
}
.module-spec-body p {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: #374151;
  white-space: pre-wrap;
}
</style>
