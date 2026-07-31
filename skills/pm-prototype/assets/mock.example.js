// src/mocks/orders.js — 订单列表 mock 示例
// 所有"接口"均为本地函数 + setTimeout 模拟延迟，禁止引入 axios / fetch 真实地址。

const NAMES = ['张伟', '李娜', '王强', '刘洋', '陈静', '赵磊', '孙悦', '周涛']
const STATUSES = ['待付款', '待发货', '已发货', '已完成', '已取消']

function generateOrders(count = 86) {
  return Array.from({ length: count }, (_, i) => ({
    id: `ORD-2026${String(i + 1).padStart(5, '0')}`,
    customer: NAMES[i % NAMES.length],
    amount: +(Math.random() * 5000 + 50).toFixed(2),
    status: STATUSES[i % STATUSES.length],
    createdAt: `2026-07-${String((i % 26) + 1).padStart(2, '0')} ${String(8 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
  }))
}

const ALL_ORDERS = generateOrders()

/**
 * 模拟分页 + 搜索 + 状态筛选
 * @returns Promise<{ list, total, page, pageSize }>
 */
export function fetchOrders({ page = 1, pageSize = 10, keyword = '', status = '' } = {}) {
  return new Promise((resolve) => {
    setTimeout(() => {
      let filtered = ALL_ORDERS
      if (keyword) {
        const kw = keyword.toLowerCase()
        filtered = filtered.filter(
          (o) => o.id.toLowerCase().includes(kw) || o.customer.includes(kw),
        )
      }
      if (status) filtered = filtered.filter((o) => o.status === status)
      const start = (page - 1) * pageSize
      resolve({
        list: filtered.slice(start, start + pageSize),
        total: filtered.length,
        page,
        pageSize,
      })
    }, 300)
  })
}

/** 模拟删除（仅从内存移除，刷新页面恢复） */
export function deleteOrder(id) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const idx = ALL_ORDERS.findIndex((o) => o.id === id)
      if (idx !== -1) ALL_ORDERS.splice(idx, 1)
      resolve({ success: idx !== -1 })
    }, 200)
  })
}
