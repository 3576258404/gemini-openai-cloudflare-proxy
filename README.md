# OpenGemini - Gemini API 代理与轮询池

这是一个功能强大的 Gemini API 代理解决方案，由两部分组成：
1.  一个部署在 **Cloudflare Worker** 上的转换服务，用于将 Google Gemini API 无缝转换为标准的 OpenAI API 格式。
2.  一个在您自己服务器上运行的 **Node.js 轮询池**，用于智能管理和轮换多个 Gemini API 密钥及上游转换服务。

## 📖 项目由来

一切的起因是，作者手头恰好有一些 Gemini API Key，却缺少一台合适的境外服务器来搭建传统的反向代理和轮询池。

为了解决这个问题，作者灵机一动，决定利用 Cloudflare Workers ~~白嫖~~ 强大的边缘计算能力，来实现 Gemini API 到 OpenAI 格式的转换。于是，这个核心的转换服务脚本便在 Gemini 的帮助下诞生了。

随后，为了管理手头的众多 Key 和上游地址，作者又在国内的云服务器上，用 Node.js 搭建了一个轮询池程序。

最终，这两部分组合起来，就构成了这个~~简陋但能用~~功能强大的代理解决方案。

## ✨ 功能特性

- **格式转换**：将 Gemini API 完美转换为 OpenAI `v1/chat/completions` 格式，兼容绝大多数客户端。
- **密钥轮询**：本地代理服务会自动轮询 `key.txt` 中的多个 Gemini API Key，有效解决单个 Key 的速率限制问题。
- **上游轮询**：支持配置多个 Cloudflare Worker 地址，实现故障转移和负载均衡。
- **智能重试**：当遇到 API Key 超额 (`429`) 或上游服务故障时，会自动尝试切换，提高服务稳定性。
- **易于部署**：Cloudflare Worker 和 Node.js 服务均可快速部署和配置。
- **完全免费**：Cloudflare Workers 在免费额度内完全够用，让您零成本拥有稳定的转换服务。

## 🏗️ 架构

+-------------+      +-------------------------+      +---------------------------+      +-------------------+|             |      |                         |      |                           |      |                   ||  OpenAI 兼容 |----->|   Node.js 轮询池服务     |----->|   Cloudflare Worker 服务   |----->|  Google Gemini API ||    客户端    |      | (运行在您的服务器上)       |      | (运行在 Cloudflare 全球网络) |      |                   ||             |      |                         |      |                           |      |                   |+-------------+      +-------------------------+      +---------------------------+      +-------------------+- 轮询 key.txt            - 提取真实 Key- 轮询 upstreams.txt      - 转换 API 格式
## 🚀 部署指南

您需要完成以下两个部分的部署。

### 第一部分：部署 Cloudflare Worker 转换服务

1.  **登录 Cloudflare**: 进入您的 Cloudflare 控制台。
2.  **进入 Workers**: 在左侧菜单中，选择 **Workers & Pages**。
3.  **创建 Worker**: 点击 **Create Application** -> **Create Worker**。
4.  **命名并部署**: 为您的 Worker 命名（例如 `gemini-openai-converter`），然后点击 **Deploy**。
5.  **编辑代码**: 点击 **Edit code**，将 `cloudflare` 文件夹内的 `works.js` 代码**完全复制并粘贴**到代码编辑器中。
6.  **保存并部署**: 点击右上角的 **Deploy** 按钮。
7.  **获取地址**: 部署成功后，您会得到一个类似 `gemini-openai-converter.your-name.workers.dev` 的地址。**请将这个地址（并记得在末尾加上 `/v1`）**，填入下一步的 `upstreams.txt` 文件中。

### 第二部分：部署本地 Node.js 轮询池

1.  **环境准备**:
    - 安装 [Node.js](https://nodejs.org/) (推荐 v18 或更高版本)
    - 安装 [pnpm](https://pnpm.io/installation)

2.  **克隆与安装**:
    ```bash
    # 克隆本项目
    git clone [https://github.com/your-username/gemini-openai-cloudflare-proxy.git](https://github.com/your-username/gemini-openai-cloudflare-proxy.git)
    cd gemini-openai-cloudflare-proxy

    # 使用 pnpm 安装依赖
    pnpm i
    ```

3.  **配置**:
    您需要根据提供的示例文件，创建两个配置文件：

    - **`key.txt`**:
        - 复制 `key.txt.example` 并重命名为 `key.txt`。
        - 将您自己的 Gemini API Key 填入其中，**每个 Key 独占一行**。

    - **`upstreams.txt`**:
        - 复制 `upstreams.txt.example` 并重命名为 `upstreams.txt`。
        - 将您在**第一部分**中部署好的 Cloudflare Worker 地址（**必须包含 `/v1` 后缀**）填入其中，每个地址独占一行。

4.  **启动服务**:
    ```bash
    node key.js
    ```
    服务启动后，您会在终端看到监听的地址和为您生成的**固定访问密钥**。

## ⚙️ 客户端使用

在任何兼容 OpenAI 的客户端中，请按如下配置：

- **API 地址 / API Base**: `http://<运行轮询池的服务器IP>:7777/v1`
- **API 密钥 / API Key**: 填入轮询池服务启动时为您生成的那个**固定的 `sk-` 格式密钥**。

---

祝您使用愉快！
