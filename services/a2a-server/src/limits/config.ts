/**
 * Bounded-resource limits of the LumiThink A2A validation service
 * (P1-09, issue #91; docs/A2A_DESIGN.md §13.4 容量与执行隔离,
 * docs/TASK_LIFECYCLE.md §4.1 步骤 3 / §10 容量耗尽).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ The numbers below are the FROZEN §13.4 INITIAL PROTECTION VALUES. They │
 * │ are NOT a throughput promise: P1 measures them (load report) and any   │
 * │ adjustment must be recorded. A cap is never "unlimited" — a limit of 0,│
 * │ a negative value or an unparsable value refuses to start (fail-closed).│
 * │ Deployments MUST fill the values §13.4 marks 部署时必须填写 (worker     │
 * │ memory + per-household daily budget) before 正式运行.                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

/** §13.4 row "对话": 每个私人会话最多 1 个执行中 Turn、1 个待处理输入. */
export interface A2aConversationLimits {
  maxActiveExecutionsPerConversation: number;
}

/** §13.4 row "Worker / 模型并发": 全局上限；单家庭不超过全局上限. */
export interface A2aConcurrencyLimits {
  /** 全局最多 2 个活动 Worker. */
  maxActiveWorkers: number;
  /** 全局最多 2 个进行中的模型请求. */
  maxActiveModelRequests: number;
  /** 单家庭活动 Worker 上限（≤ maxActiveWorkers）. */
  maxActiveWorkersPerHousehold: number;
  /** 单家庭进行中模型请求上限（≤ maxActiveModelRequests）. */
  maxActiveModelRequestsPerHousehold: number;
}

/** §13.4 row "排队任务": 每家庭最多 4 个、全局最多 8 个待调度任务. */
export interface A2aQueueLimits {
  maxQueuedGlobal: number;
  maxQueuedPerHousehold: number;
}

/** §13.4 row "执行时间": 单次活动执行最长 120 秒. */
export interface A2aExecutionLimits {
  maxExecutionMs: number;
}

/**
 * §13.4 row "模型调用预算": 单 Task 最多 8 次模型请求、累计输入输出预算
 * 32,000 token；单家庭另设每日有限 token 预算（部署时必须填写）。预留发生
 * 在调用之前（输入估算 + 最大输出一并计入），重试也计入预算。
 */
export interface A2aModelBudgetLimits {
  maxModelRequestsPerTask: number;
  maxTokensPerTask: number;
  /** 单家庭每日 token 预算；0 = 未配置 → 普通任务拒绝派发（fail-closed）. */
  maxDailyTokensPerHousehold: number;
}

/** §13.4 row "SQLite": 单实例有界写入队列；锁等待与重试总时长最多 5 秒. */
export interface A2aSqliteLimits {
  /** Bounded write-lock wait (busy_timeout) for the task store. */
  busyTimeoutMs: number;
  /** 同一时刻写者数为 1；该值为一次写操作的锁等待预算上限（§13.4 5 秒）. */
  writeLockMaxWaitMs: number;
}

/** §13.4 row "Worker 内存 / 磁盘": 部署时必须配置进程内存限额. */
export interface A2aWorkerResourceLimits {
  /**
   * 单 Worker 进程内存限额（字节）；0 = 未配置。合成验证模式提示性检查；
   * `dsh-worker` 模式在未配置时拒绝启动（内存失控不能影响另一用户执行）.
   */
  memoryLimitBytes: number;
}

/** §13.4 末段 + AC 1: 查询、取消保留处理资源（有界期限）. */
export interface A2aControlLaneLimits {
  /**
   * 保留的并发控制处理槽（查询/取消/健康检查）—— 保留面请求不占用生成
   * 槽位、不进生成队列，也不受满载拒绝影响（查询、取消和健康检查保留处理资源）。
   */
  reservedControlSlots: number;
  /**
   * 单次控制请求（查询/取消/健康检查）的最长处理期限 —— 满载时必须在此
   * 期限内返回（有界期限），绝不因生成面占满而悬挂。
   */
  controlHandlingDeadlineMs: number;
}

export interface A2aLimitsConfig {
  conversation: A2aConversationLimits;
  concurrency: A2aConcurrencyLimits;
  queue: A2aQueueLimits;
  execution: A2aExecutionLimits;
  modelBudget: A2aModelBudgetLimits;
  sqlite: A2aSqliteLimits;
  worker: A2aWorkerResourceLimits;
  control: A2aControlLaneLimits;
  /**
   * 满载排队的有界等待上限（受理前"明确拒绝/排队"中的"排队"窗口）:
   * 超出即返回明确的容量拒绝，不无限堆积。
   */
  admissionWaitMs: number;
}

export const A2A_LIMITS_DEFAULTS: A2aLimitsConfig = {
  conversation: { maxActiveExecutionsPerConversation: 1 },
  concurrency: {
    maxActiveWorkers: 2,
    maxActiveModelRequests: 2,
    maxActiveWorkersPerHousehold: 2,
    maxActiveModelRequestsPerHousehold: 2,
  },
  queue: { maxQueuedGlobal: 8, maxQueuedPerHousehold: 4 },
  execution: { maxExecutionMs: 120 * 1000 },
  modelBudget: {
    maxModelRequestsPerTask: 8,
    maxTokensPerTask: 32_000,
    maxDailyTokensPerHousehold: 0,
  },
  sqlite: { busyTimeoutMs: 2000, writeLockMaxWaitMs: 5000 },
  worker: { memoryLimitBytes: 0 },
  control: { reservedControlSlots: 1, controlHandlingDeadlineMs: 2000 },
  admissionWaitMs: 0,
};
