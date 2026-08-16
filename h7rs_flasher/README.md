# STM32 H7RS Resource Web Flasher 🚀

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Web%20Serial%20API-brightgreen.svg)
![Browser](https://img.shields.io/badge/browser-Chrome%20%7C%20Edge-blue.svg)

一款基于纯前端 **Web Serial API** 打造的 STM32 H7 嵌入式资源烧录上位机工具。无需安装任何桌面端软件，打开网页即可与下位机进行极速串口通信与资源打包烧录。

## ✨ 核心特性

- **🌍 纯 Web 驱动**：无需安装 Python、Node.js 或任何桌面端软件，只需一台支持 Web Serial API 的现代浏览器（推荐 Chrome 或 Edge）。
- **🎨 现代化 UI 设计**：采用高级 SaaS 科技风，全玻璃态 (Glassmorphism) 岛屿式布局，操作体验对标一流商用软件。
- **📦 资源一键打包**：
  - 支持 `.png`, `.jpg`, `.bmp` 图像资源解析。
  - 支持多帧动画序列合并合成。
  - 支持直接导入视频 (`.mp4`, `.webm`) 并自动按指定帧率抽帧合成。
- **🔍 实时视觉预览**：内置强大的 LCD 画布实时渲染引擎，支持缩放、裁剪、平移与绝对坐标对齐。
- **⚡ 极速串口通信**：对接下位机自定义协议，支持资源大包的分块极速烧录与实时进度回传。

## 🛠️ 如何使用 (在线版)

> 本项目已完美支持 GitHub Pages 部署，您可以直接访问在线地址使用！

1. 确保您的电脑使用 USB 连接了 STM32 H7RS 开发板，并且下位机已进入 **USB UPDATE** 模式。
2. 打开本项目的在线页面（或本地双击 `index.html`）。
3. 拖拽或点击添加所需的图片/视频资源。
4. 在右侧面板配置资源的 `资源 ID`、`坐标 (X, Y)` 与缩放方式。
5. 点击底部控制台的 **连接板卡**，在浏览器弹窗中选择对应的 COM 端口。
6. 点击 **开始烧录**，等待进度条完成即可！

## 📂 目录结构

```text
.
├── index.html       # 核心骨架与布局
├── style.css        # SaaS 级高级科技风样式表
├── app.js           # 前端 UI 交互与主逻辑
├── image.js         # 图像解析、视频抽帧与缩放裁剪引擎
├── package.js       # 资源打包与二进制协议转换
└── serial.js        # Web Serial API 硬件通信底层
```

## ⚠️ 兼容性说明

由于苹果安全策略限制，**Safari 浏览器目前不支持 Web Serial API**。请务必使用基于 Chromium 内核的桌面版浏览器：
- ✅ Google Chrome (桌面版 v89+)
- ✅ Microsoft Edge (桌面版 v89+)

## 📄 协议

本项目采用 MIT 开源协议。您可以自由地修改和分发，但请保留原作者信息。
