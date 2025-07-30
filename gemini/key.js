const http = require('http');
const https = require('https');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- 配置 ---
const PORT = 7777;
const HOST = '::';
const KEY_FILE_PATH = path.join(__dirname, 'key.txt');
const UPSTREAMS_FILE_PATH = path.join(__dirname, 'upstreams.txt');
const ACCESS_KEY_FILE_PATH = path.join(__dirname, 'access_key.txt');
const MAX_RETRIES = 5; // 最大重试次数

// --- 全局变量 ---
let geminiKeys = [];
let upstreamUrls = [];
let accessKey = '';
let currentGeminiKeyIndex = 0;
let currentUpstreamIndex = 0;

const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

// --- 核心函数 ---

/**
 * 检查文件是否存在，读取内容，如果文件缺失或为空则退出程序。
 * @param {string} filePath - 文件路径。
 * @param {string} exampleFileName - 用于提示用户的示例文件名。
 * @returns {string[]} 从文件中读取到的行数组。
 */
function checkAndReadFile(filePath, exampleFileName) {
    if (!fs.existsSync(filePath)) {
        console.error(`\n❌ 错误: 配置文件 ${path.basename(filePath)} 未找到。`);
        console.error(`   请复制 ${exampleFileName} 文件, 将其重命名为 ${path.basename(filePath)}, 并填入您的内容。`);
        process.exit(1);
    }
    const data = fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        // --- (*** 核心修改：过滤掉空行和注释行 ***) ---
        .filter(line => line && !line.startsWith('//') && !line.startsWith('#'));

    if (data.length === 0) {
        console.error(`\n❌ 错误: 配置文件 ${path.basename(filePath)} 为空或只包含注释。`);
        process.exit(1);
    }
    return data;
}

/**
 * 从配置文件加载 API 密钥和上游服务地址。
 */
function loadConfig() {
    geminiKeys = checkAndReadFile(KEY_FILE_PATH, 'key.txt.example');
    console.log(`✅ 成功加载 ${geminiKeys.length} 个有效的 Gemini API 密钥。`);
    
    upstreamUrls = checkAndReadFile(UPSTREAMS_FILE_PATH, 'upstreams.txt.example');
    console.log(`✅ 成功加载 ${upstreamUrls.length} 个有效的上游服务地址。`);
}

/**
 * 初始化客户端使用的固定访问密钥，如果文件不存在则自动生成。
 */
function initializeAccessKey() {
    try {
        accessKey = fs.readFileSync(ACCESS_KEY_FILE_PATH, 'utf8').trim();
        console.log(`🔑 已从文件加载固定访问密钥。`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('🔑 未找到访问密钥文件，正在生成新的密钥...');
            accessKey = `sk-${crypto.randomBytes(24).toString('hex')}`;
            try {
                fs.writeFileSync(ACCESS_KEY_FILE_PATH, accessKey, 'utf8');
                console.log(`✅ 新的访问密钥已生成并保存至 access_key.txt。`);
            } catch (writeError) {
                console.error(`❌ 错误: 无法写入新的访问密钥文件。`);
                process.exit(1);
            }
        } else {
            console.error(`❌ 错误: 读取访问密钥文件时发生未知错误。`);
            process.exit(1);
        }
    }
}

// --- Express 服务器设置 ---
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/v1', async (req, res) => {
    const clientAuth = req.headers['authorization'];
    if (!clientAuth || clientAuth !== `Bearer ${accessKey}`) {
        return res.status(401).json({
            error: { message: '无效的身份验证。', code: 'invalid_api_key' }
        });
    }

    let lastError = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
        const selectedGeminiKey = geminiKeys[currentGeminiKeyIndex];
        const selectedUpstreamUrl = upstreamUrls[currentUpstreamIndex];
        const targetUrl = `${selectedUpstreamUrl}${req.url}`;

        console.log(`[尝试 ${i + 1}/${MAX_RETRIES}] 转发请求至 ${selectedUpstreamUrl} (使用 Key: ...${selectedGeminiKey.slice(-4)})`);

        try {
            const requestHeaders = {
                'Content-Type': 'application/json',
                'Accept': req.headers['accept'] || 'application/json, text/event-stream',
                'Authorization': `Bearer ${selectedGeminiKey}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            };

            const response = await axios({
                method: req.method,
                url: targetUrl,
                headers: requestHeaders,
                data: req.body,
                responseType: 'stream',
                httpAgent: new URL(targetUrl).protocol === 'http:' ? httpAgent : undefined,
                httpsAgent: new URL(targetUrl).protocol === 'https:' ? httpsAgent : undefined
            });
            
            res.writeHead(response.status, response.headers);
            response.data.pipe(res);
            return; 

        } catch (error) {
            lastError = error;

            if (error.response) {
                if (error.response.status === 429) {
                    console.warn(`⚠️  Key ...${selectedGeminiKey.slice(-4)} 达到速率限制，切换下一个 Key...`);
                    currentGeminiKeyIndex = (currentGeminiKeyIndex + 1) % geminiKeys.length;
                } else {
                    console.error(`❌ 上游服务 ${selectedUpstreamUrl} 返回错误 (状态码: ${error.response.status})，切换下一个上游和 Key...`);
                    currentUpstreamIndex = (currentUpstreamIndex + 1) % upstreamUrls.length;
                    currentGeminiKeyIndex = (currentGeminiKeyIndex + 1) % geminiKeys.length;
                }
            } else {
                console.error(`❌ 无法连接到上游服务 ${selectedUpstreamUrl}，切换下一个上游和 Key...`);
                currentUpstreamIndex = (currentUpstreamIndex + 1) % upstreamUrls.length;
                currentGeminiKeyIndex = (currentGeminiKeyIndex + 1) % geminiKeys.length;
            }
        }
    }

    console.error(`❌ 在尝试 ${MAX_RETRIES} 次后仍然失败。将返回最后一次捕获的错误。`);
    if (lastError && lastError.response) {
        res.writeHead(lastError.response.status, lastError.response.headers);
        lastError.response.data.pipe(res);
    } else {
        res.status(500).json({ error: '代理服务在多次尝试后依然无法连接到任何上游服务。' });
    }
});

app.use((req, res) => {
    res.status(404).send('Not Found');
});

// --- 启动服务 ---
server.listen(PORT, HOST, () => {
    try {
        loadConfig();
        initializeAccessKey();

        console.log('\n======================================================');
        console.log('      🚀 Gemini 代理服务已启动 (智能重试版) 🚀');
        console.log('======================================================\n');
        console.log(`🔗 API 接口地址: http://127.0.0.1:${PORT}/v1`);
        console.log(`🔑 您固定的访问密钥:`);
        console.log(`   ${accessKey}\n`);
        console.log('✅ 正在使用的上游服务:', upstreamUrls);
        console.log('\n按 CTRL+C 关闭服务。');
    } catch (error) {
        // 捕获 loadConfig() 在启动时可能抛出的错误
        console.error(`\n❌ 启动过程中发生严重错误: ${error.message}`);
        process.exit(1);
    }
});
