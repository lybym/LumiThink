# 🌟 LumiThink (发光的思考)

> 💡 **"Don't just solve the math, illuminate the thinking."** (不要只解算式，去照亮思维。)

LumiThink 是一款专为 6-8 岁儿童设计的 AI 驱动数学思维诊断与提升工具。
本项目起源于一个父亲为了帮助二年级女儿跨越“具象”到“抽象”思维鸿沟的尝试。我们的“0号用户”就是我自己遇到数学瓶颈的孩子。

## 🎯 核心愿景 (The Vision)
放弃填鸭式的题海战术，利用大语言模型（LLM）的分析能力与前沿认知科学，将枯燥的数学难题转化为可视化的交互工具。培养孩子拆解问题、使用工具的能力，最终实现数学成绩与底层逻辑的双重提升。

## ✨ 核心特性：双端联动模式 (Core Features)

本项目分为两个相对独立但数据互通的模块：

* **👨‍🏫 家长端：AI 认知诊断台 (Parent's Dashboard)**
    * **极简输入：** 拍照上传孩子的错题或作业。
    * **深度诊断：** LLM 不批改对错，而是分析错题背后的“思维漏洞”（例如：是不懂十进制拆分，还是缺乏空间想象？）。
    * **生成处方：** 自动为孩子生成次日的针对性可视化挑战。
* **👧 儿童端：可视化思维游乐场 (Kid's Playground)**
    * **无感测试：** 没有试卷，每天只需 5-10 分钟的互动小游戏。
    * **工具化交互：** 提供虚拟积木、时间轴、逻辑画板等工具，让孩子“动手做数学”，在试错中建立底层理解。

## 🚀 路线图 (Roadmap)

- [x] 概念验证与痛点挖掘 (MVP 0 号用户测试)
- [x] 核心交互组件开发（针对单一知识点的可视化工具）
- [x] 搭建双端基础流转链路
- [x] 数据持久化与学情追踪体系建立
- [ ] LLM 诊断 Prompt 与网关对接
- [ ] 家长端作业上传与图片识别
- [ ] 儿童端交互式十以内加减法工具
- [ ] AI 诊断报告生成与展示

## 🛠 技术栈 (Tech Stack)

* **框架**: [Next.js 14](https://nextjs.org/) (App Router)
* **语言**: TypeScript
* **数据库**: SQLite + [Prisma](https://www.prisma.io/)
* **样式**: [Tailwind CSS](https://tailwindcss.com/)
* **动画**: [Framer Motion](https://www.framer.com/motion/)
* **图标**: [Lucide React](https://lucide.dev/)

## 🏗️ 项目结构 (Project Structure)

```
LumiThink/
├── app/                    # Next.js App Router 页面
│   ├── page.tsx           # 首页 - 模式选择
│   ├── layout.tsx         # 全局布局
│   ├── parent/            # 家长端页面
│   │   └── page.tsx       # AI 认知诊断台
│   ├── kid/               # 儿童端页面
│   │   └── page.tsx       # 可视化思维游乐场
│   └── actions/           # Server Actions
│       └── userActions.ts # 用户数据操作
├── components/            # React 组件
│   ├── navigation/        # 导航组件
│   │   └── mode-header.tsx
│   └── kid/               # 儿童端组件
│       └── visual-math-tool.tsx
├── lib/                   # 工具库
│   └── db.ts              # Prisma 客户端
├── prisma/                # 数据库 schema
│   └── schema.prisma      # 数据模型定义
└── README.md
```

## 📦 快速开始 (Quick Start)

```bash
# 安装依赖
npm install

# 初始化数据库
npx prisma db push

# 启动开发服务器
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000) 即可访问。

## 📡 API 路由 (API Routes)

项目使用 Next.js [Server Actions](https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions) 处理数据操作：

- `app/actions/userActions.ts` - 用户、孩子、活动记录的数据管理

## 🗄️ 数据模型 (Data Models)

- **Parent** - 家长账户
- **Child** - 孩子信息 (数学水平、弱点分析)
- **ActivityRecord** - 活动记录 (LLM 诊断、交互结果)

---

*Created with ❤️ by a dad for his daughter, and powered by AI.*
