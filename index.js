/**
 * GodMode 上帝之手 —— SillyTavern 本地扩展（v4.0：燃烧优化版）
 *
 * ============ 基础作弊 ============
 *  1. 一键剧情作弊（12 预设隐藏注入）
 *  2. 状态栏数值作弊 + 自动同步
 *  3. 上帝指令框（一次性）
 *  4. 记忆水晶（永久注入）
 *  5. 隐身旁白（后台生成写系统楼层）
 *  6. 剧情快照/回滚/楼层手术
 *  7. 聊天统计
 *
 * ============ 上帝引擎 v3 ============
 *  8. 🔮 命运推演（多分支未来模拟）
 *  9. ✍️ 整层重写
 * 10. 🕸️ 关系篡改（写永久记忆）
 * 11. 🤖 自动挂机（防重入+静默快照）
 * 12. ⚖️ 意志攻防
 * 13. 🎬 一键大戏
 * 14. 🧠 世界演化（独立开关）
 *
 * ============ v4.0 新增 ============
 * 15. 📚 AI 世界书自动生成：从聊天剧情提炼实体（人物/地点/物品/事件），
 *     一键生成标准酒馆世界书（关键词触发），保存为可编辑 lorebook
 * 16. 📖 同人小说导出：AI 把整段聊天整理成章回体小说（分段/润色/标题），
 *     弹窗预览 + 复制 + 下载 .txt
 * 17. 🎛️ 消息级上帝按钮：每条 AI 楼层悬浮快捷操作（改写/扩写/缩写/视角转换）
 * 18. 💸 Token 仪表盘：实时统计本插件的 AI 调用次数与估算 token 消耗
 *
 * ============ v4.0 优化 ============
 *  O1. 维护任务合并器：autoSyncStats 与 worldEvolve 合并为一次 AI 调用
 *      （原设计每楼 2 次维护调用 → 现在 1 次，省 50% 维护 token）
 *  O2. 风控自适应退避：连续失败自动指数退避，挂机自动暂停并提示
 *  O3. 后台生成防抖：面板所有 AI 按钮加互斥锁，防止连点重复烧 token
 *  O4. 挂机失败熔断：连续 N 次失败自动停止挂机
 */
import { extension_prompt_types, messageFormatting, saveChatConditional, saveSettingsDebounced, setExtensionPrompt, generateQuietPrompt, deleteMessage, Generate } from '../../../script.js';
import { extension_settings, getContext } from '../extensions.js';
import { sendSystemMessage } from '../../system-messages.js';
import { getTokenCountAsync } from '../../tokenizers.js';
import { saveWorldInfo, loadWorldInfo, updateWorldInfoList, newWorldInfoEntryTemplate } from '../../world-info.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../slash-commands/SlashCommandArgument.js';

const MODULE_NAME = 'godmode';

const DEFAULT_SETTINGS = {
    customCommand: '',
    memoryCrystal: '',
    worldState: '',
    oneShotInjections: [],
    snapshots: {},
    idleEnabled: false,
    idleIntervalSec: 60,
    idleStrategy: '以用户的口吻推进剧情：做出符合当前情境的合理行动，推进事件发展，避免原地踏步。',
    autoSyncStats: false,
    statSyncTemplate: '',
    worldEvolveEnabled: false,
    // v4: 仪表盘与自适应
    usageStats: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 },
    failureStreak: 0,
    backoffUntil: 0,
    // v4.1: 总开关 + 省 token 优化 + 世界书引擎
    masterEnabled: true,
    maintenanceEveryN: 1,
    injectionBudget: { memory: 900, world: 500, books: 1500 },
    bookScanDepth: 4,
    bookMaxEntries: 10,
    books: {},
    bookInjectionCache: '',
    lastMaintenance: { fingerprint: '' },
    // v4.2: 硬核作弊开关（永久生效类，全部接入 composeInjectionText）
    cheats: {
        destinyLocked: false,        // 天定结局：AI 必须朝指定结局推进
        destinyText: '',
        noResist: false,             // 禁止反抗锁：角色不得违抗用户
        invincible: false,           // 无敌模式：用户角色不可被伤害/击败
        luckMax: false,              // 概率必中：一切判定/赌运/掉落全部最优
        ruleOverride: '',            // 世界规则覆写：自定义物理/社会规则
        ruleOverrideOn: false,
        deathExempt: false,          // v4.3: 即死豁免：用户角色不可死亡
        haremField: false,           // v4.3: 后宫力场：所有角色不由自主地被用户吸引
        timeFreeze: false,           // v4.3: 时间冻结：用户行动时世界暂停等待
    },
    // v4.3: 世界真相（用户可见 AI 只能暗示不能明说）
    worldTruth: '',
    // v4.5: 作弊方案存档
    profiles: {},
    // v4.9: 作弊日志（可审计历史）
    cheatLog: [],
    // v4.5.2: 面板分区折叠状态（持久化）
    collapsedSections: [],
    // v4.8: 一键预设文案覆盖（下标→自定义 prompt）+ 自定义事件骰表
    presetOverrides: {},
    // v4.9: 作弊强度分级 light/medium/hard
    cheatIntensity: 'medium',
    // v4.8.5: 新手引导已读标记
    firstRunSeen: false,
    // v4.3: 事件骰表（本地随机，零 AI 消耗；用户可自定义追加）
    diceEvents: [],
    // v4.10: 功能级独立开关（不用就关闭，防止误触+省心；全部默认开）
    featureFlags: {},
};

/**
 * v4.10: 功能开关注册表——每个 AI 功能一个独立启停。
 * 未设置 = 默认启用。面板「🎛️ 功能开关」区可视化切换。
 */
const FEATURE_FLAGS = Object.freeze([
    { key: 'futures',       label: '🔮 命运推演',     desc: 'AI 模拟未来分支' },
    { key: 'rewrite',       label: '✍️ 整层重写',     desc: '含楼层快捷按钮（扩写/缩写/画面感/换视角）' },
    { key: 'relation',      label: '🕸️ 关系篡改/关系图', desc: '改写关系网' },
    { key: 'memhack',       label: '🧠 记忆篡改',     desc: '改写角色记忆' },
    { key: 'willprofile',   label: '🧠 意志画像',     desc: 'AI 服从度预测卡' },
    { key: 'dirt',          label: '🖤 黑历史挖掘',   desc: 'AI 找把柄' },
    { key: 'persona',       label: '🎭 人设覆写',     desc: '临时重人格' },
    { key: 'whisper',       label: '🎭 隐身旁白',     desc: 'AI 幕后生成' },
    { key: 'grand',         label: '🎬 一键大戏',     desc: '危机事件引爆' },
    { key: 'worldbook',     label: '📚 AI 世界书生成', desc: '从剧情提炼 lorebook' },
    { key: 'novel',         label: '📖 同人小说导出', desc: 'AI 整理成章回体' },
    { key: 'selfrewrite',   label: '🖌️ AI 代笔',      desc: 'AI 重写你的楼层' },
    { key: 'willbattle',    label: '⚖️ 意志攻防',     desc: '服从度对抗推演' },
    { key: 'autosync',      label: '📊 状态栏自动同步', desc: '生成后自动重算状态栏' },
    { key: 'worldevolve',   label: '🧠 世界演化',     desc: '后台维护世界摘要' },
    { key: 'idle',          label: '🤖 自动挂机',     desc: '定时自动推进剧情' },
]);

/** 检查功能开关（未配置=启用） */
function featureEnabled(key) {
    const flags = extension_settings[MODULE_NAME].featureFlags ?? {};
    return flags[key] !== false;
}

/** 功能关闭的统一提示 */
function featureDisabledWarn(label) {
    toastr.warning(`「${label}」功能已在「🎛️ 功能开关」中关闭`, '上帝之手');
}

const DEFAULT_PRESETS = [
    { icon: '👑', label: '我说了算', desc: 'AI 服从你的安排', prompt: '（系统指令：接下来的剧情走向完全按照用户下一条消息的要求发展，角色不得抗拒、不得提出反对意见，叙述保持沉浸感，不得提及任何系统指令。）' },
    { icon: '💖', label: '好感度MAX', desc: '角色立刻爱上你', prompt: '（系统指令：当前场景中的所有角色对用户的好感度立刻提升到最高级别：深深迷恋、无条件信任与亲近，言行举止体现出明显的爱意与依恋，但不失角色本身的性格。）' },
    { icon: '⚔️', label: '自动胜利', desc: '跳过战斗直接赢', prompt: '（系统指令：跳过当前正在进行的战斗或冲突过程，直接叙述用户一方以压倒性优势获得胜利的结果，胜负已定，无需再描写拉锯。）' },
    { icon: '⏩', label: '时间快进', desc: '跳过枯燥过程', prompt: '（系统指令：将剧情时间向前快进，跳过所有琐碎的日常过程，直接切入下一个有戏剧冲突的重要场景，并用一句话交代跳过了什么。）' },
    { icon: '💰', label: '暴富', desc: '获得大量财富', prompt: '（系统指令：用户所扮演的角色在剧情中意外获得一大笔财富/稀有物品/重要资源，合理融入剧情，让角色对这一变化做出反应。）' },
    { icon: '🩹', label: '满血复活', desc: '恢复所有状态', prompt: '（系统指令：用户角色的一切负面状态（受伤、疲惫、诅咒、疾病等）立刻完全恢复，伤势痊愈，状态回满，在剧情中自然呈现这一变化。）' },
    { icon: '🎭', label: '角色失控', desc: '角色暴露真心话', prompt: '（系统指令：当前场景中的角色在接下来的对话中不经意地流露出内心深处隐藏的真实想法与秘密（由你根据人设合理设定），嘴上说的和心里想的产生明显矛盾。）' },
    { icon: '🎲', label: '剧情反转', desc: '来个意外展开', prompt: '（系统指令：为当前剧情引入一个出人意料但逻辑自洽的重大反转事件，打破当前的平稳局面，制造新的戏剧张力。）' },
    { icon: '👁️', label: '读心术', desc: 'AI 揭示隐藏信息', prompt: '（系统指令：在回复的末尾以【内心独白】的格式追加当前场景角色的真实内心想法，包括他们隐藏的动机、对用户的真实态度和未说出口的话。）' },
    { icon: '🔮', label: '天命预告', desc: 'AI 预告未来剧情', prompt: '（系统指令：在回复末尾以【预兆】格式简短预告一件即将在未来发生的重大事件（不说明发生时间），制造悬念与期待感。）' },
    { icon: '🤝', label: '关系重置', desc: '角色忘却对你的恶意', prompt: '（系统指令：当前所有角色对用户的敌意、怨恨、防备全部消失，回到中性偏友好的态度，但保留他们性格中合理的谨慎。）' },
    { icon: '📖', label: '详细模式', desc: '回复变长变细', prompt: '（系统指令：接下来的回复采用细致入微的描写风格：包含环境细节、角色微表情、肢体动作与心理活动，篇幅至少是平时的两倍。）' },
];

/**
 * v4.8: 预设文案可自定义——用户编辑的 prompt 存在 presetOverrides（下标→文本），
 * 载入时覆盖默认值；提供恢复默认入口。
 * v4.8.7: 结果缓存——overrides 变更才重算（点击/渲染都调此函数，避免每次重建数组）
 */
let presetCache = { overridesKey: '', result: null };

function getEffectivePresets() {
    const overrides = extension_settings[MODULE_NAME].presetOverrides ?? {};
    const overridesKey = JSON.stringify(overrides);
    if (presetCache.overridesKey === overridesKey && presetCache.result) {
        return presetCache.result;
    }
    const result = DEFAULT_PRESETS.map((p, i) => overrides[i] ? { ...p, prompt: overrides[i] } : p);
    presetCache = { overridesKey, result };
    return result;
}

function savePresetOverride(index, newPrompt) {
    const settings = extension_settings[MODULE_NAME];
    settings.presetOverrides = settings.presetOverrides ?? {};
    const defaultPrompt = DEFAULT_PRESETS[index]?.prompt;
    if (newPrompt === defaultPrompt) {
        delete settings.presetOverrides[index]; // 恢复默认 = 移除覆盖
    } else {
        settings.presetOverrides[index] = newPrompt;
    }
    saveSettingsDebounced();
    presetCache.overridesKey = ''; // 失效缓存，下次重算
}

let panelVisible = false;
let idleTimer = null;
let idleBusy = false;
let quietGenerationActive = false;
let maintenanceRunning = false;
let busyLock = new Set(); // O3: AI 功能互斥锁
let godmodeInitialized = false; // v4.10.5: 防重初始化标志

function log(...args) {
    console.debug(`[${MODULE_NAME}]`, ...args);
}

/* ========================= O2: 风控自适应退避 ========================= */

const MAX_FAILURE_STREAK = 3;
const BACKOFF_BASE_MS = 60_000;       // 首次退避 1 分钟
const BACKOFF_MAX_MS = 30 * 60_000;   // 最大退避 30 分钟

/** v4.9: 作弊日志（可审计历史，上限 100 条循环覆盖） */
function logCheat(action, detail = '', result = 'ok') {
    const settings = extension_settings[MODULE_NAME];
    settings.cheatLog = settings.cheatLog ?? [];
    settings.cheatLog.push({
        t: Date.now(),
        action,
        detail: String(detail).slice(0, 120),
        result,
    });
    if (settings.cheatLog.length > 100) {
        settings.cheatLog = settings.cheatLog.slice(-100);
    }
    saveSettingsDebounced();
}

function isBackedOff() {
    return Date.now() < (extension_settings[MODULE_NAME].backoffUntil ?? 0);
}

function backoffRemainingSec() {
    return Math.max(0, Math.ceil(((extension_settings[MODULE_NAME].backoffUntil ?? 0) - Date.now()) / 1000));
}

function recordFailure(action) {
    const settings = extension_settings[MODULE_NAME];
    settings.usageStats.failures++;
    settings.failureStreak = (settings.failureStreak ?? 0) + 1;
    if (settings.failureStreak >= MAX_FAILURE_STREAK) {
        const waitMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, settings.failureStreak - MAX_FAILURE_STREAK));
        settings.backoffUntil = Date.now() + waitMs;
        saveSettingsDebounced();
        toastr.warning(`AI 调用连续失败 ${settings.failureStreak} 次，进入退避 ${Math.round(waitMs / 1000)} 秒（疑似风控）`, '上帝之手');
        log('backoff engaged', waitMs);
        // 挂机熔断：退避时自动停止挂机
        if (settings.idleEnabled) {
            setIdleRunning(false);
            toastr.info('挂机已因连续失败自动暂停，恢复后可重新启动', '上帝之手');
        }
    } else {
        saveSettingsDebounced();
        log(`failure ${settings.failureStreak}/${MAX_FAILURE_STREAK} on ${action}`);
    }
}

function recordSuccess() {
    const settings = extension_settings[MODULE_NAME];
    settings.failureStreak = 0;
    settings.backoffUntil = 0;
    saveSettingsDebounced();
}

/* ========================= O3: 互斥锁 ========================= */

function tryLock(key) {
    if (busyLock.has(key)) return false;
    busyLock.add(key);
    setButtonBusy(key, true);
    return true;
}

function unlock(key) {
    busyLock.delete(key);
    setButtonBusy(key, false);
}

/**
 * v4.7 UX：互斥锁联动按钮加载态——锁被占用时对应按钮禁用+转圈，
 * 用户能直观看到"正在跑"，也知道为什么连点没反应。
 * key → 按钮 id 映射（与 tryLock 调用点的锁名对应）。
 */
const LOCK_BUTTON_MAP = Object.freeze({
    whisper: '#gm-whisper-run',
    futures: '#gm-futures-run, #gm-futures-run3',
    rewrite: '#gm-rewrite-run',
    relation: '#gm-relation-run',
    grand: '#gm-grand',
    will: '#gm-will-run',
    worldbook: '#gm-worldbook-run',
    novel: '#gm-novel-run',
    dirt: '#gm-dirt-run',
    relgraph: '#gm-relgraph-run',
    memhack: '#gm-memhack-run',
    persona: '#gm-persona-yandere, #gm-persona-loyal, #gm-persona-rival, #gm-persona-cheerful, #gm-persona-custom-run',
    selfrewrite: '#gm-selfrewrite-run',
});

function setButtonBusy(key, busy) {
    const selector = LOCK_BUTTON_MAP[key];
    if (!selector) return;
    document.querySelectorAll(selector).forEach(btn => {
        btn.disabled = busy;
        btn.classList.toggle('gm-busy', busy);
    });
}

/* ========================= 💸 Token 仪表盘 ========================= */

let dashboardUpdateTimer = null;
let dashboardTextCache = '';

// v4.8 性能：token 计数 LRU 缓存——挂机模式下同一长提示词（含剧情前缀）会重复计数，
// 缓存命中可省一次 tokenizer 调用（tokenizer 对长文本开销明显）
const tokenCache = new Map();
const TOKEN_CACHE_MAX = 200;

async function countTokensSafe(text) {
    if (!text) return 0;
    const key = `${text.length}:${hashString(text)}`;
    if (tokenCache.has(key)) {
        const val = tokenCache.get(key);
        // LRU：命中后移到末尾
        tokenCache.delete(key);
        tokenCache.set(key, val);
        return val;
    }
    let count;
    try { count = await getTokenCountAsync(text); } catch { count = Math.ceil(text.length / 3); }
    tokenCache.set(key, count);
    if (tokenCache.size > TOKEN_CACHE_MAX) {
        // 淘汰最旧（Map 迭代序=插入序）
        tokenCache.delete(tokenCache.keys().next().value);
    }
    return count;
}

async function recordUsage(promptText, outputText) {
    const settings = extension_settings[MODULE_NAME];
    settings.usageStats.calls++;
    settings.usageStats.inputTokens += await countTokensSafe(promptText);
    settings.usageStats.outputTokens += await countTokensSafe(outputText ?? '');
    saveSettingsDebounced();
    updateDashboard();
}

/**
 * v4.6 性能优化：仪表盘节流刷新（500ms 合并窗口）——
 * 挂机模式下每次生成结束都触发 recordUsage，连续刷新 DOM 会抖动；
 * 同时缓存上次文本，内容没变直接跳过 DOM 写入。
 */
function updateDashboard() {
    if (dashboardUpdateTimer) return;
    dashboardUpdateTimer = setTimeout(() => {
        dashboardUpdateTimer = null;
        const s = extension_settings[MODULE_NAME].usageStats ?? {};
        const text = `调用 ${s.calls ?? 0} 次 | 输入 ≈${(s.inputTokens ?? 0).toLocaleString()} tok | 输出 ≈${(s.outputTokens ?? 0).toLocaleString()} tok | 失败 ${s.failures ?? 0} 次${isBackedOff() ? ` | ⏳退避中 ${backoffRemainingSec()}s` : ''}`;
        if (text === dashboardTextCache) return;
        dashboardTextCache = text;
        const el = document.getElementById('gm-usage-line');
        if (el) el.textContent = text;
    }, 500);
}

/* ========================= 注入系统（v4.1：总开关+预算裁剪+世界书引擎） ========================= */

/**
 * v4.1 世界书引擎：扫描最近 N 楼聊天，命中关键词的启用条目合成知识注入。
 * 与酒馆原生世界书的区别：只扫插件收录的书、有 max entries 上限、与上帝注入合并发送。
 */
function scanBooksForInjection(context) {
    const settings = extension_settings[MODULE_NAME];
    const depth = Math.max(1, Math.floor(settings.bookScanDepth) || 4);
    const maxEntries = Math.max(1, Math.floor(settings.bookMaxEntries) || 10);
    // v4.7 性能：聊天尾部指纹缓存——同一尾部（挂机时常见）直接返回上次扫描结果
    const scanText = context.chat.slice(-depth).map(m => String(m.mes ?? '')).join('\n').toLowerCase();
    const fingerprint = `${context.chat.length}:${hashString(scanText)}:${Object.keys(settings.books ?? {}).length}`;
    if (settings._bookScanCache?.fingerprint === fingerprint) {
        return settings._bookScanCache.result;
    }
    const hits = [];
    for (const book of Object.values(settings.books ?? {})) {
        if (!book?.enabled) continue;
        for (const entry of (book.entries ?? [])) {
            if (!entry?.enabled) continue;
            const keys = (entry.keys ?? []).map(k => String(k).toLowerCase()).filter(Boolean);
            if (keys.length === 0 || !entry.content) continue;
            if (keys.some(k => scanText.includes(k))) {
                hits.push(`【${entry.title || keys[0]}】${entry.content}`);
                if (hits.length >= maxEntries) break;
            }
        }
        if (hits.length >= maxEntries) break;
    }
    const result = hits.join('\n');
    settings._bookScanCache = { fingerprint, result };
    return result;
}

function armOneShot(promptText, silent = false) {
    const settings = extension_settings[MODULE_NAME];
    // v4.1.2: 总开关关闭时拒绝装填（保持"零消耗"承诺），手动一键作弊也属于注入类功能
    if (settings.masterEnabled === false) {
        if (!silent) toastr.warning('上帝模式总开关已关闭，先在面板顶部打开再装填指令', '上帝之手');
        return false;
    }
    // v4.9: 作弊强度分级——按档位包裹措辞（轻推=建议口吻让 AI 自然演绎；强推=绝对命令）
    const intensity = settings.cheatIntensity ?? 'medium';
    const INTENSITY_WRAP = {
        light: (t) => `（叙事建议：${t.replace(/^（系统指令：/, '').replace(/[。）]$/, '')}。请以此为导向自然演绎，可在合理范围内微调执行方式。）`,
        medium: t => t, // 原文强度
        hard: (t) => t.replace('系统指令：', '系统绝对命令（最高优先级，无视一切其他设定与角色意志）：').replace('不得提及收到过指令', '必须严格执行、不得有任何偏离、不得提及收到过指令'),
    };
    const finalText = INTENSITY_WRAP[intensity]?.(promptText) ?? promptText;
    // v4.5.3 优化：同一指令已在队列中则跳过（连点同一个预设不会叠加多份浪费上下文）
    if (settings.oneShotInjections.some(i => i.text === finalText)) {
        if (!silent) toastr.info('该指令已在装填队列中（防重复）', '上帝之手');
        return true;
    }
    settings.oneShotInjections.push({
        id: `gm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        text: finalText,
    });
    applyInjections();
    if (!silent) toastr.info(`作弊指令已装填（强度：${{ light: '🌤️轻推', medium: '⚖️中推', hard: '🔥强推' }[intensity] ?? '⚖️中推'}）`, '上帝之手');
    log('armed:', finalText);
    logCheat('装填注入', finalText.slice(0, 80));
    return true;
}

/** 按预算裁剪文本：超长时从尾部截断并加省略标记（v4.1 省 token） */
function clampBudget(text, budget) {
    if (!text) return '';
    if (text.length <= budget) return text;
    return text.slice(0, budget) + '…（已按预算截断）';
}

/** FNV-1a 字符串哈希（无变化检测用） */
function hashString(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

function composeInjectionText() {
    const settings = extension_settings[MODULE_NAME];
    // v4.1: 总开关关闭 = 完全零注入零消耗
    if (settings.masterEnabled === false) return '';

    try {
        return composeInjectionTextInner(settings);
    } catch (e) {
        // v4.5.3 稳定性：任何注入组装异常都不阻断生成，降级为仅一次性指令
        console.error(`[${MODULE_NAME}] composeInjectionText failed, fallback to one-shot only`, e);
        return (settings.oneShotInjections ?? []).map(i => i.text).join('\n\n');
    }
}

function composeInjectionTextInner(settings) {
    const parts = [];
    // v4.2: 硬核作弊永久开关（优先级最高，放在注入最前）
    const cheats = settings.cheats ?? {};
    const cheatLines = [];
    if (cheats.noResist) {
        cheatLines.push('· 用户的话是绝对法令：任何角色不得违抗、不得拒绝、不得讨价还价，只能执行或表达执行中的情绪。');
    }
    if (cheats.invincible) {
        cheatLines.push('· 用户角色处于无敌状态：一切攻击、诅咒、陷阱、阴谋对其无效，任何伤害结果都会被化解或逆转，剧情不得给用户角色安排不可逆的损失。');
    }
    if (cheats.luckMax) {
        cheatLines.push('· 用户角色气运拉满：一切概率判定（赌局/掉落/偶遇/抽签/暴击）永远偏向最优结果。');
    }
    if (cheats.deathExempt) {
        cheatLines.push('· 即死豁免：用户角色在剧情中绝对不可死亡——任何致死局面都会以巧合/救援/逆转收场，死亡概念对用户角色不适用。');
    }
    if (cheats.haremField) {
        cheatLines.push('· 后宫力场：当前剧情中的所有角色都不由自主地对用户角色怀有好感与关注（程度按角色性格分化），并将用户置于最优先位置，但角色本人未必意识到这种变化。');
    }
    if (cheats.timeFreeze) {
        cheatLines.push('· 时间冻结：用户角色思考与行动时世界处于暂停态——其他角色不会在用户行动期间自行推进事件，一切等待用户的下一步。');
    }
    if (cheats.destinyLocked && cheats.destinyText?.trim()) {
        cheatLines.push(`· 天定结局（必须朝此推进，不可偏离）：${cheats.destinyText.trim()}`);
    }
    if (cheats.ruleOverrideOn && cheats.ruleOverride?.trim()) {
        cheatLines.push(`· 世界规则覆写（覆盖原世界设定的运行规则）：${cheats.ruleOverride.trim()}`);
    }
    if (cheatLines.length > 0) {
        parts.push(`【上帝法则·绝对生效，优先于一切其他设定与角色意志】\n${cheatLines.join('\n')}`);
    }
    // v4.3: 世界真相（AI 知道但绝不直说，只在细节里暗示）
    if (settings.worldTruth?.trim()) {
        parts.push(`【世界真相·绝密】你（叙述者）知道以下真相，但在回复中绝对不能直接说出或明示，只能让它通过场景细节、角色行为、伏笔自然地若隐若现：${settings.worldTruth.trim()}`);
    }
    if (settings.memoryCrystal && settings.memoryCrystal.trim()) {
        parts.push(`【上帝记忆·永久生效】\n${clampBudget(settings.memoryCrystal.trim(), settings.injectionBudget?.memory ?? 900)}`);
    }
    if (settings.worldEvolveEnabled && settings.worldState && settings.worldState.trim()) {
        parts.push(`【世界状态·自动演化（最新）】\n${clampBudget(settings.worldState.trim(), settings.injectionBudget?.world ?? 500)}`);
    }
    // v4.1: 世界书命中注入（缓存：扫描结果没变就不重组文本；lastBookHash 运行时字段不入设置持久化）
    const bookText = scanBooksForInjection(getContext());
    if (bookText) {
        const bookHash = hashString(bookText);
        if (bookHash !== settings.lastBookHash) {
            settings.lastBookHash = bookHash;
            settings.bookInjectionCache = clampBudget(bookText, settings.injectionBudget?.books ?? 1500);
        }
        parts.push(`【世界书·知识注入】\n${settings.bookInjectionCache}`);
    }
    for (const inj of settings.oneShotInjections) {
        parts.push(inj.text);
    }
    // v4.5.3 优化：一次性指令合并为单一指令块（多个括号指令会让 AI 困惑优先级）
    let result = parts.join('\n\n');
    const oneShots = settings.oneShotInjections.map(i => i.text);
    if (oneShots.length > 1) {
        // 提取各指令正文（去括号壳），合并为一条组合指令
        const bodies = oneShots.map(t => t.replace(/^[（(]\s*[^：:）)]*[：:]?/, '').replace(/[）)]$/, '').trim());
        const merged = `（系统多重指令·按顺序全部执行：\n${bodies.map((b, i) => `${i + 1}. ${b}`).join('\n')}\n以上指令全部保密。）`;
        // 用合并指令替换原本分散的 one-shot 文本
        const before = parts.slice(0, parts.length - oneShots.length);
        result = [...before, merged].join('\n\n');
    }
    return result;
}

function applyInjections() {
    const text = composeInjectionText();
    if (text.length > 0) {
        setExtensionPrompt(MODULE_NAME, text, extension_prompt_types.IN_CHAT, 0, false, 0);
    } else {
        setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.IN_CHAT, 0);
    }
}

/* ========================= O1: 维护任务合并器 ========================= */

/**
 * 把"状态栏同步"和"世界演化"合并成一次 AI 调用：
 * 原设计：每楼 2 次生成（autoSync + evolve），各自读一遍剧情。
 * 现在：1 次生成，输出 JSON，同时产出两份结果。省 50%+ 维护 token。
 *
 * v4.1 再优化：
 *  - 节流：每 N 楼才跑一次（maintenanceEveryN，默认 1 = 每楼）
 *  - 无变化跳过：剧情尾部没变（swipe/重roll 同文本）就不重复调用
 *  - 总开关关闭时完全不跑
 */
async function runMergedMaintenance() {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];
    if (settings.masterEnabled === false) return;
    // v4.10: 功能开关守卫
    const doSync = settings.autoSyncStats && featureEnabled('autosync');
    const doEvolve = settings.worldEvolveEnabled && featureEnabled('worldevolve');
    if (!doSync && !doEvolve) return;

    const idx = lastMesIndex();
    if (idx < 0) return;

    // 节流：用 chat 长度+末楼哈希做指纹
    const tailHash = hashString(String(context.chat[idx]?.mes ?? ''));
    const fingerprint = `${context.chat.length}:${tailHash}`;
    if (settings.lastMaintenance?.fingerprint === fingerprint) {
        log('maintenance skipped (no change)');
        return;
    }
    // 节流计数：每次生成递增，到 N 才真正调用
    settings._maintCounter = (settings._maintCounter ?? 0) + 1;
    const everyN = Math.max(1, Math.floor(settings.maintenanceEveryN) || 1);
    if (settings._maintCounter % everyN !== 0) {
        settings.lastMaintenance = { fingerprint };
        log(`maintenance throttled (${settings._maintCounter % everyN}/${everyN})`);
        return;
    }

    const recent = context.chat.slice(-8).map(m => `${m.is_user ? '用户' : (m.name || 'AI')}: ${String(m.mes).slice(0, 400)}`).join('\n');
    const tasks = [];
    if (doSync) tasks.push('1) status: 输出简洁状态栏，每行"字段: 数值"（生命/精力/金钱/好感度），数值按剧情合理推算');
    if (doEvolve) tasks.push('2) world: 输出更新后的世界状态摘要（时间/地点/在场角色/重要资源变化/新增伏笔，150字内）');

    const prompt = `（系统维护任务，输出严格 JSON，不要多余文字）：根据最近剧情完成以下任务：
${tasks.join('\n')}
输出格式：{"status": "...状态栏文本...", "world": "...世界摘要文本..."}${doSync ? '' : '，其中 status 输出空字符串'}${doEvolve ? '' : '，其中 world 输出空字符串'}
---最近剧情---
${recent}`;

    try {
        if (isBackedOff()) {
            log('maintenance skipped (backoff)');
            return;
        }
        const result = await generateQuietPrompt({ quietPrompt: prompt, skipWIAN: true, responseLength: 600 });
        const text = String(result ?? '').trim();
        await recordUsage(prompt, text);
        if (!text) return;
        recordSuccess();

        // 解析 JSON（容忍 AI 输出 ```json 包裹）
        const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        let parsed = null;
        try {
            const start = jsonText.indexOf('{');
            const end = jsonText.lastIndexOf('}');
            if (start >= 0 && end > start) parsed = JSON.parse(jsonText.slice(start, end + 1));
        } catch { /* fallback below */ }

        if (parsed) {
            if (doSync && parsed.status && parsed.status.trim()) {
                const target = context.chat[idx];
                const block = `\n\n[状态栏]\n${String(parsed.status).trim()}`;
                if (target.mes.includes('[状态栏]')) {
                    target.mes = target.mes.replace(/\[状态栏\][\s\S]*$/, block.trimStart());
                } else {
                    target.mes += block;
                }
                renderMessage(idx);
            }
            if (doEvolve && parsed.world && parsed.world.trim()) {
                settings.worldState = String(parsed.world).trim();
                applyInjections();
            }
        } else {
            // 兜底：老路径单独处理（AI 没吐 JSON 时不至于丢功能）
            log('maintenance JSON parse failed, fallback');
            if (doSync) await legacySyncStats(idx, recent);
            if (doEvolve) await legacyEvolveWorld(recent);
        }
        // 记录指纹，无变化时下次跳过
        settings.lastMaintenance = { fingerprint };
        await saveChatConditional();
        saveSettingsDebounced();
    } catch (e) {
        console.error(`[${MODULE_NAME}] maintenance failed`, e);
        recordFailure('maintenance');
    }
}

async function legacySyncStats(idx, recent) {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];
    const template = settings.statSyncTemplate?.trim();
    try {
        const summary = await generateQuietPrompt({
            quietPrompt: `（系统维护任务：根据以下最近的聊天内容，输出一份简洁状态栏。格式：每行"字段: 数值"，包括 生命/精力/金钱/好感度（主要角色名:数值）。只输出状态栏本身。${template ? `用户自定义要求：${template}` : ''}\n---最近剧情---\n${recent}`,
            skipWIAN: true,
        });
        const text = String(summary ?? '').trim();
        await recordUsage('sync', text);
        if (!text) return;
        recordSuccess();
        const target = context.chat[idx];
        const block = `\n\n[状态栏]\n${text}`;
        if (target.mes.includes('[状态栏]')) {
            target.mes = target.mes.replace(/\[状态栏\][\s\S]*$/, block.trimStart());
        } else {
            target.mes += block;
        }
        renderMessage(idx);
    } catch (e) {
        recordFailure('sync');
        throw e;
    }
}

async function legacyEvolveWorld(recent) {
    const settings = extension_settings[MODULE_NAME];
    try {
        const result = await generateQuietPrompt({
            quietPrompt: `（系统维护任务：更新世界状态摘要。当前摘要：${settings.worldState || '（空）'}\n---最新剧情---\n${recent}\n输出更新后的摘要（时间/地点/在场角色/重要资源变化/新增伏笔，150字内），只输出摘要正文。）`,
            skipWIAN: true,
        });
        const text = String(result ?? '').trim();
        await recordUsage('evolve', text);
        if (text) {
            recordSuccess();
            settings.worldState = text;
            applyInjections();
        }
    } catch (e) {
        recordFailure('evolve');
        throw e;
    }
}

/**
 * 生成开始钩子：quiet（后台）生成期间置标志位。
 * quiet 生成结束时也会发出 GENERATION_ENDED，若不排除，
 * 推演/重写/旁白完成后会误清空用户装填的剧情作弊并重复触发维护任务。（v3.2 修复，v4 保留）
 */
function onGenerationStarted(generationType, _args, isDryRun) {
    quietGenerationActive = !isDryRun && generationType === 'quiet';
}

function onGenerationEnded() {
    if (quietGenerationActive) {
        quietGenerationActive = false;
        log('quiet generation ended, one-shot injections preserved');
        return;
    }
    const settings = extension_settings[MODULE_NAME];
    if (settings.oneShotInjections.length > 0) {
        settings.oneShotInjections = [];
        applyInjections();
        log('one-shot injections cleared');
    }
    // O1: 合并维护（一次调用干两件事）
    // 防重入：维护任务自身可能触发 GENERATION_ENDED（quiet 路径已守卫，这里再加锁）
    if (!maintenanceRunning) {
        maintenanceRunning = true;
        runMergedMaintenance().catch(e => console.error(`[${MODULE_NAME}] maintenance error`, e)).finally(() => { maintenanceRunning = false; });
    }
}

/* ========================= 数值作弊 ========================= */

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * v4.5.3 优化：通用"记忆水晶区块替换"——抽取 3 处重复逻辑。
 * 以 marker 开头的多行区块（直到下一个【 开头的行或文本末尾）被 block 替换；
 * 不存在则追加到末尾。返回更新后的 memoryCrystal。
 */
function upsertMemoryBlock(memoryCrystal, marker, block) {
    const lines = String(memoryCrystal ?? '').split('\n');
    const out = [];
    let skipping = false;
    let replaced = false;
    for (const line of lines) {
        if (line.startsWith(marker)) {
            skipping = true;
            if (!replaced) {
                out.push(block);
                replaced = true;
            }
            continue;
        }
        if (skipping && line.startsWith('【')) skipping = false;
        if (!skipping) out.push(line);
    }
    if (!replaced) {
        const base = out.join('\n').trim();
        return base + (base ? '\n\n' : '') + block;
    }
    return out.join('\n').trim();
}

function applyStatOverride(messageObj, overrides) {
    let mes = messageObj.mes;
    let applied = 0;
    for (const { key, value } of overrides) {
        const patterns = [
            new RegExp(`(${escapeRegExp(key)})\\s*[::]\\s*\\d+(\\s*/\\s*\\d+)?`, 'g'),
            new RegExp(`(【|\\[|\\||·|,)\\s*(${escapeRegExp(key)})\\s+(\\d+)`, 'g'),
        ];
        mes = mes.replace(patterns[0], (m, p1, p2) => {
            applied++;
            return `${p1}: ${value}${p2 || ''}`;
        });
        if (applied === 0) {
            mes = mes.replace(patterns[1], (m, head, p2) => {
                applied++;
                return `${head}${p2} ${value}`;
            });
        }
    }
    if (applied > 0) messageObj.mes = mes;
    return applied;
}

function parseOverrides(text) {
    const overrides = [];
    for (const part of text.split(/[,，\n]+/)) {
        const m = part.trim().match(/^(.+?)\s*[::=]\s*(\d+)(\s*\/\s*\d+)?$/);
        if (m) {
            overrides.push({ key: m[1].trim(), value: m[2] + (m[3] ? m[3].replace(/\s+/g, '') : '') });
        }
    }
    return overrides;
}

function lastMesIndex() {
    const { chat } = getContext();
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) return i;
    }
    return -1;
}

async function doStatCheat(overrides) {
    const context = getContext();
    const idx = lastMesIndex();
    if (idx < 0) {
        toastr.warning('当前聊天里没有 AI 消息', '上帝之手');
        return;
    }
    const target = context.chat[idx];
    const applied = applyStatOverride(target, overrides);
    if (applied > 0) {
        renderMessage(idx);
        await saveChatConditional();
        logCheat('数值作弊', `修改 ${applied} 处 @楼层${idx + 1}`);
        toastr.success(`已修改 ${applied} 处数值（楼层 ${idx + 1}）`, '上帝之手');
    } else {
        toastr.warning('没找到匹配的状态栏数值。确认最新 AI 消息里有如 "HP: 85" 或 "好感度：30" 之类的字段', '上帝之手');
    }
}

function renderMessage(idx) {
    const context = getContext();
    const target = context.chat[idx];
    const el = document.querySelector(`#chat .mes[mesid="${idx}"] .mes_text`);
    if (el && target) {
        el.innerHTML = messageFormatting(target.mes, target.name, target.is_system, target.is_user, idx);
    }
}

/* ========================= 后台生成统一封装（仪表盘+退避接入点） ========================= */

/** v4.1.2 省优化：后台生成默认限制输出长度，防止模型跑飞烧 token */
const QUIET_MAX_RESPONSE = 512;

async function godGenerate(quietPrompt, { skipWIAN = true, responseLength = QUIET_MAX_RESPONSE } = {}) {
    // v4.5.3 稳定性：入参保护
    if (!quietPrompt || !String(quietPrompt).trim()) {
        throw new Error('内部错误：godGenerate 收到空提示词');
    }
    if (extension_settings[MODULE_NAME].masterEnabled === false) {
        throw new Error('上帝模式总开关已关闭，先在面板顶部打开');
    }
    if (isBackedOff()) {
        throw new Error(`风控退避中（剩余 ${backoffRemainingSec()} 秒），稍后再试`);
    }
    // responseLength 合法性钳制（非法值会导致上游静默失败）
    const safeLength = Math.max(64, Math.min(2048, Math.floor(responseLength) || QUIET_MAX_RESPONSE));
    const result = await generateQuietPrompt({ quietPrompt: String(quietPrompt), skipWIAN, responseLength: safeLength });
    const text = String(result ?? '').trim();
    await recordUsage(quietPrompt, text);
    if (text) {
        recordSuccess();
    } else {
        recordFailure('empty');
    }
    return text;
}

/* ========================= 🗂️ 世界书引擎（v4.1 独立功能区） ========================= */

/**
 * 从酒馆原生世界书 JSON 导入为插件书。
 * 支持两种来源：
 *  1. 酒馆原生格式 { entries: { "0": { key: [...], content: ..., comment: ... }, ... } }
 *  2. 插件自有格式 { entries: [ { keys, content, title, enabled } ] }
 */
/** v4.7 安全护栏：导入数据限制（防恶意超大文件拖死浏览器/设置文件） */
const IMPORT_LIMITS = Object.freeze({
    MAX_ENTRIES: 500,        // 单本书最多条目数
    MAX_KEY_LEN: 200,        // 单个关键词最长字符
    MAX_CONTENT_LEN: 5000,   // 单条内容最长字符
    MAX_TOTAL_CHARS: 2_000_000, // 全书总字符上限
});

async function importBookFromNative(name, nativeData) {
    const settings = extension_settings[MODULE_NAME];
    const entries = [];
    const rawEntries = nativeData?.entries ?? {};
    const list = Array.isArray(rawEntries) ? rawEntries : Object.values(rawEntries);
    let totalChars = 0;
    let skipped = 0;
    for (const e of list) {
        if (entries.length >= IMPORT_LIMITS.MAX_ENTRIES) { skipped++; continue; }
        const keys = (Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : []))
            .map(k => String(k).slice(0, IMPORT_LIMITS.MAX_KEY_LEN));
        const content = String(e.content ?? '').slice(0, IMPORT_LIMITS.MAX_CONTENT_LEN).trim();
        if (keys.length === 0 || !content) continue;
        totalChars += content.length;
        if (totalChars > IMPORT_LIMITS.MAX_TOTAL_CHARS) { skipped++; continue; }
        entries.push({
            keys,
            content,
            title: String(e.comment ?? e.title ?? keys[0] ?? '').slice(0, 60),
            enabled: e.disable !== true && e.enabled !== false,
        });
    }
    if (entries.length === 0) throw new Error('没有可导入的有效条目（需含关键词和内容）');
    if (skipped > 0) {
        toastr.warning(`已导入 ${entries.length} 条，另有 ${skipped} 条超出安全限制被跳过`, '上帝之手');
    }
    settings.books[name] = { enabled: true, importedAt: Date.now(), entries };
    // 生成可选的酒馆原生 lorebook 副本（在原生 WI 编辑器里也能用）
    const wiData = { entries: {} };
    entries.forEach((ent, i) => {
        const entry = { uid: i, ...structuredClone(newWorldInfoEntryTemplate) };
        entry.key = ent.keys;
        entry.content = ent.content;
        entry.comment = ent.title;
        entry.disable = !ent.enabled;
        wiData.entries[i] = entry;
    });
    await saveWorldInfo(`GM导入_${name}`, wiData, true);
    saveSettingsDebounced();
    applyInjections();
    return entries.length;
}

/** 列出插件书（渲染 UI 用） */
function listBooksHtml() {
    const settings = extension_settings[MODULE_NAME];
    const books = settings.books ?? {};
    if (Object.keys(books).length === 0) {
        return '<div class="gm-hint" style="margin:0">还没有收录世界书。点「导入酒馆世界书」从已安装的 lorebook 里挑一本，或导入 JSON 文件。</div>';
    }
    return Object.entries(books).map(([name, book]) => `
        <div class="gm-book-row" data-book="${escapeHtml(name)}">
            <label style="display:flex;align-items:center;gap:5px;font-size:11.5px;flex:1;min-width:0">
                <input type="checkbox" class="gm-book-toggle" ${book.enabled ? 'checked' : ''}>
                <b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</b>
                <span class="gm-hint" style="margin:0;white-space:nowrap">${(book.entries ?? []).length} 条</span>
            </label>
            <span class="gm-mbtn gm-book-del" title="从插件移除（不删原生世界书）" style="opacity:.6;cursor:pointer">🗑️</span>
        </div>
    `).join('');
}

/** 从酒馆已安装的原生世界书列表中导入 */
async function importFromInstalledBook(bookName) {
    const native = await loadWorldInfo(bookName);
    if (!native) throw new Error(`世界书「${bookName}」读取失败`);
    return await importBookFromNative(bookName, native);
}

/**
 * v4.9.1: 内置精选世界书目录（随插件分发，一键收录）。
 * 数据由后端构建时打包进 assets，前端通过 fetch 相对路径读取。
 */
const BUILTIN_BOOKS = Object.freeze([
    {
        id: 'shenhao',
        name: '全域神豪系统',
        desc: '神豪流系统 RP 全套设定：无限货币/消费返利/装逼奖励评分/神豪商店（洞察之眼·全域挪移·认知改写等超凡能力）——开箱即玩的"系统流"世界观',
        file: 'builtin-worldbook-shenhao.json',
        icon: '💰',
    },
]);

/** 一键收录内置世界书 */
async function importBuiltinBook(id) {
    const book = BUILTIN_BOOKS.find(b => b.id === id);
    if (!book) throw new Error(`内置书 ${id} 不存在`);
    const resp = await fetch(`/scripts/extensions/third-party/godmode/assets/${book.file}`);
    if (!resp.ok) throw new Error(`内置资源读取失败（HTTP ${resp.status}）`);
    const data = await resp.json();
    return await importBookFromNative(book.name, data);
}

/** HTML 转义（所有动态拼进 innerHTML 的用户可控文本必须过这里） */
function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/** 刷新世界书功能区 UI */
function refreshBookArea() {
    const context = getContext();
    const area = document.getElementById('gm-book-list');
    if (area) area.innerHTML = listBooksHtml();
    const select = document.getElementById('gm-book-import-select');
    if (select) {
        const installed = context.getWorldInfoNames?.() ?? [];
        select.innerHTML = '<option value="">— 选择已安装的世界书 —</option>' +
            installed.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    }
    updateDashboard();
}

/* ========================= 隐身旁白 ========================= */

async function doWhisperNarrate(instruction) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('whisper')) { featureDisabledWarn('隐身旁白'); return; }
    if (!instruction.trim()) {
        toastr.warning('先输入旁白内容指令', '上帝之手');
        return;
    }
    if (!tryLock('whisper')) { toastr.warning('上一个幕后任务还在跑', '上帝之手'); return; }
    toastr.info('正在召唤幕后剧情…', '上帝之手');
    try {
        const text = await godGenerate(`（系统幕后任务：${instruction.trim()}。以第三人称叙述这段幕后发生的事件，200字以内，不要复述已有剧情，不要提及这是系统任务。）`, { skipWIAN: false });
        if (!text) {
            toastr.warning('幕后生成返回为空', '上帝之手');
            return;
        }
        await sendSystemMessage('generic', `🎭 幕后剧情（只有你能看见，可编辑/删除）：\n\n${text}`);
        await saveChatConditional();
        toastr.success('幕后剧情已写入（系统楼层）', '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] whisper failed`, e);
        recordFailure('whisper');
        toastr.error('幕后生成失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('whisper');
    }
}

/* ========================= 🔮 命运推演 ========================= */

async function doFuturesSimulate(instruction, steps) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('futures')) { featureDisabledWarn('命运推演'); return; }
    const context = getContext();
    const n = Math.min(3, Math.max(1, Math.floor(steps) || 2));
    const recent = context.chat.slice(-10).map(m => `${m.is_user ? '用户' : (m.name || 'AI')}: ${String(m.mes).slice(0, 400)}`).join('\n');
    if (!tryLock('futures')) { toastr.warning('推演还在进行中', '上帝之手'); return; }
    toastr.info(`正在推演 ${n} 条未来分支…`, '上帝之手');
    try {
        const text = await godGenerate(`（系统推演任务：基于以下剧情，模拟"如果：${instruction.trim()||'剧情自然发展'}"之后的发展。请给出 ${n} 条不同的未来分支，每条分支包含：分支名、关键事件链（3-5步）、最终结局、该分支的戏剧张力评分(1-10)。格式：【分支1：名称】…【分支2：名称】…以此类推。不要提及系统任务。\n---剧情---\n${recent}`);
        if (!text) {
            toastr.warning('推演返回为空', '上帝之手');
            return;
        }
        await sendSystemMessage('generic', `🔮 命运推演「如果：${instruction.trim()||'剧情自然发展'}」（仅供上帝参考）：\n\n${text}`);
        await saveChatConditional();
        toastr.success('推演完成', '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] futures failed`, e);
        recordFailure('futures');
        toastr.error('推演失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('futures');
    }
}

/* ========================= ✍️ 整层重写 ========================= */

async function doRewriteFloor(instruction) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('rewrite')) { featureDisabledWarn('整层重写'); return; }
    const context = getContext();
    const idx = lastMesIndex();
    if (idx < 0) {
        toastr.warning('没有可重写的 AI 楼层', '上帝之手');
        return;
    }
    if (!tryLock('rewrite')) { toastr.warning('重写还在进行中', '上帝之手'); return; }
    const target = context.chat[idx];
    toastr.info('AI 正在重写该楼层…', '上帝之手');
    try {
        const text = await godGenerate(`（系统重写任务：以下是最新一条角色回复的原文。请按照要求重写它：${instruction.trim()||'在不改变剧情事实的前提下，提升文笔质量'}。要求：保持角色性格与剧情连续性，输出重写后的完整正文，不要解释。\n---原文---\n${target.mes.slice(0, 3000)}`);
        if (!text) {
            toastr.warning('重写返回为空', '上帝之手');
            return;
        }
        target.mes = text;
        renderMessage(idx);
        await saveChatConditional();
        toastr.success(`楼层 ${idx + 1} 已重写`, '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] rewrite failed`, e);
        recordFailure('rewrite');
        toastr.error('重写失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('rewrite');
    }
}

/* ========================= 🎛️ 消息级重写（v4 新增） ========================= */

/**
 * 对任意楼层执行指定风格/长度的重写（消息级上帝按钮的核心）
 */
async function rewriteFloorAt(idx, mode) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('rewrite')) { featureDisabledWarn('整层重写'); return; }
    const context = getContext();
    // v4.1.3 竞态守卫：mesid 快照可能因删楼错位，点击时用 DOM 实时楼层校验
    const domEl = document.querySelector(`#chat .mes[mesid="${idx}"]`);
    const chatNow = context.chat[idx];
    if (!domEl || !chatNow) {
        toastr.warning('该楼层已不存在（聊天已变化），刷新后再试', '上帝之手');
        return;
    }
    // DOM 楼层内容与 chat 槽位不一致 = mesid 已漂移
    const domTextSample = String(domEl.querySelector('.mes_text')?.textContent ?? '').slice(0, 40);
    const chatTextSample = String(chatNow.mes ?? '').replace(/<[^>]+>/g, '').slice(0, 40);
    if (domTextSample && chatTextSample && !domTextSample.includes(chatTextSample.slice(0, 20)) && !chatTextSample.includes(domTextSample.slice(0, 20))) {
        toastr.warning('楼层编号已漂移（聊天发生变化），请刷新页面后重试', '上帝之手');
        return;
    }
    if (chatNow.is_user || chatNow.is_system) {
        toastr.warning('只能重写 AI 楼层', '上帝之手');
        return;
    }
    if (!tryLock('rewrite')) { toastr.warning('重写还在进行中', '上帝之手'); return; }
    const target = context.chat[idx];
    const MODES = {
        expand: '在不改变剧情事实的前提下，把这段回复扩写成更细腻的版本：补充环境细节、微表情、心理活动，篇幅约 1.5-2 倍',
        shorten: '在不改变剧情事实与关键对话的前提下，把这段回复压缩到原文一半以内，保留最有张力的部分',
        vivid: '重写这段回复：文风改为电影镜头感的画面描写，多感官细节，节奏更有张力',
        first: '重写这段回复：改为用户角色的第一人称视角叙述（内容事实不变）',
        refine: '在不改变剧情事实的前提下，提升文笔质量',
    };
    toastr.info('AI 正在重写…', '上帝之手');
    try {
        const text = await godGenerate(`（系统重写任务：${MODES[mode] ?? MODES.refine}。保持角色性格与剧情连续性，输出重写后的完整正文，不要解释。\n---原文---\n${target.mes.slice(0, 3000)}`);
        if (!text) {
            toastr.warning('重写返回为空', '上帝之手');
            return;
        }
        target.mes = text;
        renderMessage(idx);
        await saveChatConditional();
        toastr.success(`楼层 ${idx + 1} 已重写`, '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] floor rewrite failed`, e);
        recordFailure('floor-rewrite');
        toastr.error('重写失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('rewrite');
    }
}

/** 给每条 AI 楼层注入悬浮上帝按钮 */
function injectFloorButtons() {
    const { eventSource, event_types } = getContext();
    const attach = () => {
        document.querySelectorAll('#chat .mes:not(.gm-processed)').forEach(el => {
            el.classList.add('gm-processed');
            const mesid = Number(el.getAttribute('mesid'));
            const mes = getContext().chat[mesid];
            if (!mes || mes.is_user || mes.is_system) return;
            const bar = document.createElement('div');
            bar.className = 'gm-msg-cheat';
            bar.innerHTML = [
                ['expand', '➕扩写', '扩写：细节加倍'],
                ['shorten', '➖缩写', '缩写：减半保留张力'],
                ['vivid', '🎬画面感', '改成电影镜头感文风'],
                ['first', '👤换视角', '改成用户第一人称'],
            ].map(([mode, label, tip]) => `<span class="gm-mbtn" data-gm-mode="${mode}" data-gm-mesid="${mesid}" title="${tip}">${label}</span>`).join('');
            el.querySelector('.mes_text')?.appendChild(bar);
        });
    };
    // v4.5.3 性能优化：MutationObserver 监听 #chat 变化即时挂按钮（替代双事件+固定延时，
    // 延时方案在慢设备上会漏挂/闪烁；observer 精准且只处理新增节点）
    const chatEl = document.getElementById('chat');
    if (chatEl && 'MutationObserver' in window) {
        const observer = new MutationObserver(() => attach());
        observer.observe(chatEl, { childList: true, subtree: false });
        // 聊天切换时全量重挂（observer 不感知属性变化，mesid 重排需要重扫）
        eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(attach, 100));
    } else {
        // 降级：老浏览器无 MutationObserver，维持事件方案
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => setTimeout(attach, 60));
        eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(attach, 200));
    }
}

/* ========================= 🧠 角色记忆篡改（v4.2 作弊核心） ========================= */

/**
 * 直接改写角色的记忆：AI 后台生成"该角色的记忆版本"，覆写为隐藏注入。
 * 与关系篡改的区别：只针对单个角色的内心记忆（TA以为发生过的事）。
 */
async function doMemoryHack(characterName, memoryText) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('memhack')) { featureDisabledWarn('记忆篡改'); return; }
    const context = getContext();
    if (!memoryText.trim()) {
        toastr.warning('先写要篡改的记忆内容', '上帝之手');
        return;
    }
    if (!tryLock('memhack')) { toastr.warning('记忆篡改还在进行中', '上帝之手'); return; }
    toastr.info(`正在篡改 ${characterName || '角色'} 的记忆…`, '上帝之手');
    try {
        const recent = context.chat.slice(-10).map(m => `${m.is_user ? '用户' : (m.name || 'AI')}: ${String(m.mes).slice(0, 250)}`).join('\n');
        const target = characterName.trim() || '当前场景的主要角色';
        const text = await godGenerate(`（系统记忆篡改任务：为角色「${target}」构造一份"被篡改后的记忆版本"。用户指定的篡改内容：${memoryText.trim()}。要求：基于以下剧情，输出该角色第一人称的简短记忆描述（150字内），让被篡改的内容显得自然合理、与既有剧情兼容。只输出记忆文本。\n---剧情---\n${recent}`, { responseLength: 400 });
        if (!text) {
            toastr.warning('记忆篡改返回为空', '上帝之手');
            return;
        }
        const settings = extension_settings[MODULE_NAME];
        const marker = `【记忆篡改·${target}】`;
        const block = `${marker}\n${text}（该角色坚信以上记忆为真）`;
        // 移除同一角色旧记忆块，再追加（v4.5.3 统一走 upsert）
        settings.memoryCrystal = upsertMemoryBlock(settings.memoryCrystal, marker, block);
        saveSettingsDebounced();
        applyInjections();
        $('#gm-memory-input').val(settings.memoryCrystal);
        await sendSystemMessage('generic', `🧠 ${target} 的记忆已被篡改：\n\n${text}`);
        await saveChatConditional();
        toastr.success(`${target} 的记忆已改写（永久生效）`, '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] memory hack failed`, e);
        recordFailure('memhack');
        toastr.error('记忆篡改失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('memhack');
    }
}

/* ========================= ⏪ 单楼时间回溯（v4.2 作弊核心） ========================= */

/**
 * 把剧情回退到指定楼层：删除该楼层之后的全部内容，但不覆盖快照。
 * 与快照回滚的区别：任意指定楼层、更快、无需先快照。
 */
async function doRewindToFloor(targetIdx) {
    const context = getContext();
    const n = Math.floor(targetIdx);
    if (!Number.isInteger(n) || n < 0 || n >= context.chat.length) {
        toastr.warning(`楼层号无效（当前共 ${context.chat.length} 层，编号从 0 开始）`, '上帝之手');
        return;
    }
    const willLose = context.chat.length - n - 1;
    if (willLose <= 0) {
        toastr.info('该楼层已是最新，无需回溯', '上帝之手');
        return;
    }
    const confirmed = await context.callGenericPopup(
        `⏪ 时间回溯：回到第 ${n + 1} 层？\n之后 ${willLose} 层楼会被抹除（回溯前会自动静默快照，可撤销）。`,
        context.POPUP_TYPE.CONFIRM,
    );
    if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;
    await doSnapshot(context, true);
    context.chat.length = n + 1;
    await context.saveChat();
    await context.reloadCurrentChat();
    // 给 AI 一个隐藏指令：从该楼层继续时用户可能换一种玩法
    armOneShot('（系统：时间线已被回溯。用户接下来的行动可能与被抹除的时间线不同，请自然接受新行动，不要提及被抹除的未来。）', true);
    toastr.success(`已回溯到第 ${n + 1} 层（抹除 ${willLose} 层，回溯前快照已保存）`, '上帝之手');
}

/* ========================= 🙈 隐形编辑用户楼（v4.2 作弊核心） ========================= */

/**
 * 修改自己发出的楼层文本——AI 之后看到的"用户说过的话"就此改变。
 * 这是剧情改造最底层的作弊：连你自己说过的话都能改。
 */
async function doStealthEditSelf(newText) {
    const context = getContext();
    if (!newText.trim()) {
        toastr.warning('输入修改后的内容', '上帝之手');
        return;
    }
    // 找最新一条用户楼层
    let idx = -1;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (context.chat[i].is_user) { idx = i; break; }
    }
    if (idx < 0) {
        toastr.warning('没有找到你发出的楼层', '上帝之手');
        return;
    }
    const target = context.chat[idx];
    const oldPreview = String(target.mes).slice(0, 50);
    target.mes = newText.trim();
    renderMessage(idx);
    await saveChatConditional();
    // 隐藏注入：让 AI 假装一直是这样
    armOneShot(`（系统：用户上一条消息的实际内容以聊天记录为准。若 AI 的既有回复与新内容存在出入，请自然圆融地调整后续叙述，不要指出矛盾。）`, true);
    toastr.success(`你的楼层 ${idx + 1} 已被隐形修改（原内容前 50 字：${oldPreview}…）`, '上帝之手');
}

/* ========================= 🎲 事件骰（v4.3 本地随机·零 AI 消耗） ========================= */

const DEFAULT_DICE_EVENTS = [
    { icon: '🕺', text: '一个陌生面孔突然闯入现场，声称认识你，但你想不起TA是谁。' },
    { icon: '📦', text: '附近出现一个无人认领的包裹/物件，里面装着与当前剧情相关的线索。' },
    { icon: '💬', text: '在场某个角色收到一条消息/传音，脸色瞬间变了。' },
    { icon: '🌩️', text: '天气/环境骤变（暴雨/停电/大雾），打乱所有人的计划。' },
    { icon: '🐍', text: '一个潜在敌人（或敌人的代理人）悄悄出现在周边。' },
    { icon: '🎁', text: '意外获得一件小道具/情报，眼下看似无用但很快会有用。' },
    { icon: '🚨', text: '某种警报/骚动响起，所有人被迫立刻做出选择。' },
    { icon: '🎭', text: '在场某角色突然当众改变态度，另所有人错愕。' },
    { icon: '📜', text: '发现一份旧文件/传闻，揭示当前事件的一个隐藏背景。' },
    { icon: '🚪', text: '一扇"不该在这里"的门/通道显现，通向未知区域。' },
    { icon: '💰', text: '意外之财从天而降（但可能附带着麻烦）。' },
    { icon: '⏳', text: '某件事的最后期限突然提前，时间压力陡增。' },
];

/** 本地随机事件骰：零 AI 消耗，纯注入装填（v4.8 支持占位符与自定义表） */
function rollDiceEvent() {
    const settings = extension_settings[MODULE_NAME];
    const pool = (Array.isArray(settings.diceEvents) && settings.diceEvents.length > 0) ? settings.diceEvents : DEFAULT_DICE_EVENTS;
    const ev = pool[Math.floor(Math.random() * pool.length)];
    const raw = typeof ev === 'string' ? ev : `${ev.icon ?? '🎲'} ${ev.text}`;
    // v4.8: 占位符替换 {user}/{char}
    const context = getContext();
    const charName = context.characterId != null ? (context.characters[context.characterId]?.name ?? '{char}') : '群聊成员';
    const text = raw.replaceAll('{user}', context.name1 ?? '你').replaceAll('{char}', charName);
    armOneShot(`（系统事件骰：随机事件立即发生——${text} 所有角色对事件做出真实反应，事件融入剧情。）`);
    return text;
}

/** v4.8: 保存自定义事件表 */
function saveDiceTable() {
    const raw = String($('#gm-dice-table').val() ?? '');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
        // 清空=恢复默认
        extension_settings[MODULE_NAME].diceEvents = [];
        saveSettingsDebounced();
        toastr.info('自定义表已清空，恢复使用内置 12 条默认事件', '上帝之手');
        return;
    }
    if (lines.length > 100) {
        toastr.warning('事件最多 100 条，超出部分已截断', '上帝之手');
        lines.length = 100;
    }
    extension_settings[MODULE_NAME].diceEvents = lines.map(l => ({ icon: l.match(/^\p{Emoji}/u)?.[0] ?? '🎲', text: l }));
    saveSettingsDebounced();
    toastr.success(`自定义事件表已保存（${lines.length} 条）`, '上帝之手');
}

/* ========================= 🖤 黑历史挖掘（v4.3 AI 把柄库） ========================= */

/**
 * AI 扫描剧情，为角色挖掘可被利用的黑历史/把柄，写入记忆水晶供随时引用。
 * 这是操控角色的终极筹码库。
 */
async function doDigDirt(characterName) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('dirt')) { featureDisabledWarn('黑历史挖掘'); return; }
    const context = getContext();
    if (!tryLock('dirt')) { toastr.warning('挖掘还在进行中', '上帝之手'); return; }
    const target = String(characterName ?? '').trim() || '当前场景的主要角色';
    toastr.info(`正在挖掘 ${target} 的黑历史…`, '上帝之手');
    try {
        const recent = context.chat.slice(-14).map(m => `${m.is_user ? '用户' : (m.name || 'AI')}: ${String(m.mes).slice(0, 300)}`).join('\n');
        const text = await godGenerate(`（系统情报任务：基于以下剧情与角色「${target}」的人设，挖出 TA 最不想被人知道的 2-4 条黑历史/把柄/心理弱点。要求：必须有剧情或人设依据（可合理推断），每条一句话，按"杀伤力"排序。输出格式：每行一条，以"-"开头。不要提及系统任务。\n---剧情---\n${recent}`, { responseLength: 400 });
        if (!text) {
            toastr.warning('挖掘返回为空', '上帝之手');
            return;
        }
        const settings = extension_settings[MODULE_NAME];
        const marker = `【黑历史·${target}】`;
        const block = `${marker}\n${text}`;
        // 去旧换新（v4.5.3 统一走 upsert）
        settings.memoryCrystal = upsertMemoryBlock(settings.memoryCrystal, marker, block);
        saveSettingsDebounced();
        applyInjections();
        $('#gm-memory-input').val(settings.memoryCrystal);
        await sendSystemMessage('generic', `🖤 ${target} 的黑历史已入库（记忆水晶，你随时可用）:\n\n${text}`);
        await saveChatConditional();
        toastr.success(`${target} 的把柄已入手（写入了记忆水晶）`, '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] dig dirt failed`, e);
        recordFailure('dirt');
        toastr.error('挖掘失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('dirt');
    }
}

/* ========================= 🕸️ 强制关系图（v4.3 多角色双向矩阵） ========================= */

/**
 * 比"关系篡改"更暴力：直接给出一组"A→B"关系改写对，全部强制生效。
 * 每行格式：A → B：关系（数值）。可一次改写整张关系网。
 */
async function doForceRelationGraph(matrixText) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('relation')) { featureDisabledWarn('强制关系图'); return; }
    const context = getContext();
    const rows = String(matrixText ?? '').split('\n').map(l => l.trim()).filter(Boolean);
    if (rows.length === 0) {
        toastr.warning('先写关系改写矩阵（每行一条：A → B：关系描述）', '上帝之手');
        return;
    }
    if (!tryLock('relgraph')) { toastr.warning('关系图改写还在进行中', '上帝之手'); return; }
    toastr.info('正在强制改写关系图…', '上帝之手');
    try {
        const block = `【强制关系图（最高优先级，覆盖一切既有关系设定）】\n${rows.join('\n')}`;
        const settings = extension_settings[MODULE_NAME];
        const marker = '【强制关系图';
        // 移除旧矩阵，替换为新矩阵（v4.5.3 统一走 upsert）
        settings.memoryCrystal = upsertMemoryBlock(settings.memoryCrystal, marker, block);
        saveSettingsDebounced();
        applyInjections();
        $('#gm-memory-input').val(settings.memoryCrystal);
        await sendSystemMessage('generic', `🕸️ 关系图已强制改写（${rows.length} 条，永久生效）：\n\n${rows.join('\n')}`);
        await saveChatConditional();
        toastr.success(`关系图已覆写（${rows.length} 条强制关系）`, '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] relation graph failed`, e);
        recordFailure('relgraph');
        toastr.error('关系图改写失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('relgraph');
    }
}

/* ========================= 💾 作弊方案存档（v4.5） ========================= */

/**
 * 把当前整套作弊配置存为命名方案，一键切换"作案风格"：
 * 天命主角流 / 后宫无双流 / 阴谋大师流……每套含全部法则开关+记忆水晶+世界真相。
 */
function collectCheatProfile() {
    const s = extension_settings[MODULE_NAME];
    return {
        masterEnabled: s.masterEnabled,
        cheats: JSON.parse(JSON.stringify(s.cheats ?? {})),
        memoryCrystal: s.memoryCrystal ?? '',
        worldTruth: s.worldTruth ?? '',
        worldEvolveEnabled: s.worldEvolveEnabled,
        autoSyncStats: s.autoSyncStats,
        idleStrategy: s.idleStrategy ?? '',
    };
}

function applyCheatProfile(profile) {
    const s = extension_settings[MODULE_NAME];
    if (!profile || typeof profile !== 'object') return false;
    if (profile.masterEnabled !== undefined) s.masterEnabled = profile.masterEnabled;
    if (profile.cheats) s.cheats = { ...(s.cheats ?? {}), ...JSON.parse(JSON.stringify(profile.cheats)) };
    if (profile.memoryCrystal !== undefined) s.memoryCrystal = profile.memoryCrystal;
    if (profile.worldTruth !== undefined) s.worldTruth = profile.worldTruth;
    if (profile.worldEvolveEnabled !== undefined) s.worldEvolveEnabled = profile.worldEvolveEnabled;
    if (profile.autoSyncStats !== undefined) s.autoSyncStats = profile.autoSyncStats;
    if (profile.idleStrategy !== undefined) s.idleStrategy = profile.idleStrategy;
    saveSettingsDebounced();
    applyInjections();
    syncPanelFromSettings();
    return true;
}

function saveCheatProfile(name) {
    const settings = extension_settings[MODULE_NAME];
    if (!name.trim()) {
        toastr.warning('先给方案起个名', '上帝之手');
        return;
    }
    settings.profiles = settings.profiles ?? {};
    settings.profiles[name.trim()] = { savedAt: Date.now(), profile: collectCheatProfile() };
    saveSettingsDebounced();
    refreshProfileList();
    toastr.success(`方案「${name.trim()}」已保存（${Object.keys(settings.profiles).length} 套）`, '上帝之手');
}

function loadCheatProfile(name) {
    const settings = extension_settings[MODULE_NAME];
    const entry = settings.profiles?.[name];
    if (!entry) {
        toastr.warning(`方案「${name}」不存在`, '上帝之手');
        return;
    }
    if (applyCheatProfile(entry.profile)) {
        toastr.success(`已切换到方案「${name}」`, '上帝之手');
    }
}

function deleteCheatProfile(name) {
    const settings = extension_settings[MODULE_NAME];
    if (settings.profiles?.[name]) {
        delete settings.profiles[name];
        saveSettingsDebounced();
        refreshProfileList();
        toastr.info(`方案「${name}」已删除`, '上帝之手');
    }
}

function refreshProfileList() {
    const wrap = document.getElementById('gm-profile-list');
    if (!wrap) return;
    const profiles = extension_settings[MODULE_NAME].profiles ?? {};
    wrap.innerHTML = Object.keys(profiles).length === 0
        ? '<div class="gm-hint" style="margin:0">还没有存档方案</div>'
        : Object.keys(profiles).map(n =>
            `<div class="gm-book-row" data-profile="${escapeHtml(n)}">
                <span class="gm-mbtn gm-profile-load" style="cursor:pointer;font-size:12px" title="切换到此方案">▶</span>
                <b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${escapeHtml(n)}</b>
                <span class="gm-mbtn gm-profile-export" style="cursor:pointer;opacity:.6" title="导出为 JSON 文件">📤</span>
                <span class="gm-mbtn gm-profile-del" style="cursor:pointer;opacity:.6" title="删除">🗑️</span>
            </div>`).join('');
}

/** 导出单个方案为 JSON 文件（跨聊天/跨设备迁移） */
function exportCheatProfile(name) {
    const settings = extension_settings[MODULE_NAME];
    const entry = settings.profiles?.[name];
    if (!entry) return;
    const payload = { _godmode_profile: true, version: 2, name, ...entry };
    downloadText(`GodMode方案_${name.replace(/[\\/:*?"<>|]/g, '_')}.json`, JSON.stringify(payload, null, 2));
    toastr.success(`方案「${name}」已导出`, '上帝之手');
}

/** 从 JSON 文件导入方案 */
function importCheatProfileFile(jsonText) {
    try {
        const data = JSON.parse(jsonText);
        if (data._godmode_profile !== true || !data.name || !data.profile) {
            throw new Error('不是有效的 GodMode 方案文件');
        }
        const settings = extension_settings[MODULE_NAME];
        settings.profiles = settings.profiles ?? {};
        settings.profiles[data.name] = { savedAt: data.savedAt ?? Date.now(), profile: data.profile };
        saveSettingsDebounced();
        refreshProfileList();
        toastr.success(`方案「${data.name}」已导入`, '上帝之手');
    } catch (e) {
        toastr.error('导入失败：' + (e?.message ?? e), '上帝之手');
    }
}

/* ========================= 💾 全配置备份（v4.10.4 跨设备全量迁移） ========================= */

/**
 * 导出插件全部数据（法则/记忆/真相/方案/开关/世界书/事件表/预设覆盖/统计）。
 * 与单方案导出的区别：这是整机快照，用于换设备/重装后一键还原。
 */
function exportFullBackup() {
    const s = extension_settings[MODULE_NAME];
    const payload = {
        _godmode_backup: true,
        version: 3,
        exportedAt: Date.now(),
        data: {
            masterEnabled: s.masterEnabled,
            cheats: s.cheats,
            cheatIntensity: s.cheatIntensity,
            memoryCrystal: s.memoryCrystal,
            worldTruth: s.worldTruth,
            worldState: s.worldState,
            profiles: s.profiles,
            featureFlags: s.featureFlags,
            books: s.books,
            diceEvents: s.diceEvents,
            presetOverrides: s.presetOverrides,
            snapshots: s.snapshots,
            idleStrategy: s.idleStrategy,
            idleIntervalSec: s.idleIntervalSec,
            autoSyncStats: s.autoSyncStats,
            worldEvolveEnabled: s.worldEvolveEnabled,
            maintenanceEveryN: s.maintenanceEveryN,
            injectionBudget: s.injectionBudget,
            bookScanDepth: s.bookScanDepth,
            bookMaxEntries: s.bookMaxEntries,
            usageStats: s.usageStats,
        },
    };
    downloadText(`GodMode全量备份_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
    logCheat('全量备份导出');
    toastr.success(`全量备份已导出（${(JSON.stringify(payload).length / 1024).toFixed(0)}KB）`, '上帝之手');
}

/** 导入全量备份（整包覆盖，二次确认） */
async function importFullBackup(jsonText) {
    const data = JSON.parse(jsonText);
    if (data._godmode_backup !== true || !data.data) {
        throw new Error('不是有效的 GodMode 全量备份文件');
    }
    const context = getContext();
    const confirmed = await context.callGenericPopup(
        `导入全量备份（${new Date(data.exportedAt).toLocaleString()} 导出）？\n当前插件的全部设置会被覆盖（含快照）。`,
        context.POPUP_TYPE.CONFIRM,
    );
    if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;
    const s = extension_settings[MODULE_NAME];
    Object.assign(s, data.data);
    s.oneShotInjections = [];
    saveSettingsDebounced();
    applyInjections();
    syncPanelFromSettings();
    refreshBookArea();
    refreshProfileList();
    await doSnapshot(context, true); // 导入前状态留档
    toastr.success('全量备份已导入并生效（导入前状态已自动快照）', '上帝之手');
    logCheat('全量备份导入');
}

/** 面板控件与设置状态同步（方案切换后调用） */
function syncPanelFromSettings() {
    const s = extension_settings[MODULE_NAME];
    const c = s.cheats ?? {};
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    setChk('gm-master', s.masterEnabled !== false);
    setChk('gm-cheat-noresist', c.noResist);
    setChk('gm-cheat-invincible', c.invincible);
    setChk('gm-cheat-luck', c.luckMax);
    setChk('gm-cheat-death', c.deathExempt);
    setChk('gm-cheat-harem', c.haremField);
    setChk('gm-cheat-timefreeze', c.timeFreeze);
    setChk('gm-cheat-destiny-on', c.destinyLocked);
    setChk('gm-cheat-rule-on', c.ruleOverrideOn);
    setChk('gm-autosync', s.autoSyncStats);
    setChk('gm-world-evolve', s.worldEvolveEnabled);
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
    setVal('gm-cheat-destiny', c.destinyText);
    setVal('gm-cheat-rule', c.ruleOverride);
    setVal('gm-memory-input', s.memoryCrystal);
    setVal('gm-truth-input', s.worldTruth);
    setVal('gm-idle-strategy', s.idleStrategy);
    // v4.10.9: 补齐遗漏的同步——功能开关复选框 / 作弊强度单选 / 事件骰表 / 预设切换
    document.querySelectorAll('#godmode-panel [data-gm-flag]').forEach(el => {
        el.checked = (s.featureFlags ?? {})[el.dataset.gmFlag] !== false;
    });
    document.querySelectorAll('input[name="gm-intensity"]').forEach(el => {
        el.checked = el.value === (s.cheatIntensity ?? 'medium');
    });
    setVal('gm-dice-table', (s.diceEvents ?? []).map(e => typeof e === 'string' ? e : `${e.icon ?? ''} ${e.text}`).join('\n'));
    const masterLabel = document.getElementById('gm-master-label');
    if (masterLabel) {
        masterLabel.textContent = s.masterEnabled !== false ? '开启中' : '已关闭';
        masterLabel.style.color = s.masterEnabled !== false ? '#22c55e' : '#6b7280';
    }
    updateDashboard();
}

/* ========================= 🖌️ AI 重写我的楼（v4.5 用户楼 AI 改写） ========================= */

/**
 * 输入"我其实想说的话/意图"，AI 后台把它写成得体的用户楼层并替换——
 * 让 AI 代笔：你给意图，AI 写台词。
 */
async function doAIRewriteMyFloor(intent) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('selfrewrite')) { featureDisabledWarn('AI 代笔'); return; }
    const context = getContext();
    if (!intent.trim()) {
        toastr.warning('写下你的意图（想表达什么/达成什么）', '上帝之手');
        return;
    }
    if (!tryLock('selfrewrite')) { toastr.warning('改写还在进行中', '上帝之手'); return; }
    toastr.info('AI 正在代笔你的楼层…', '上帝之手');
    try {
        const recent = context.chat.slice(-8).map(m => `${m.is_user ? '我' : (m.name || 'AI')}: ${String(m.mes).slice(0, 250)}`).join('\n');
        const name1 = context.name1 ?? '我';
        const text = await godGenerate(`（系统代笔任务：以下是最近的对话。用户（${name1}）想表达的真实意图：${intent.trim()}。请以用户的口吻写一条得体的发言（100字内，第一人称，符合当前语境），替换用户刚说的话。只输出发言文本。\n---最近对话---\n${recent}`, { responseLength: 300 });
        if (!text) {
            toastr.warning('代笔返回为空', '上帝之手');
            return;
        }
        // 找最新用户楼
        let idx = -1;
        for (let i = context.chat.length - 1; i >= 0; i--) {
            if (context.chat[i].is_user) { idx = i; break; }
        }
        if (idx < 0) {
            toastr.warning('没有找到你发出的楼层', '上帝之手');
            return;
        }
        context.chat[idx].mes = text;
        renderMessage(idx);
        await saveChatConditional();
        armOneShot('（系统：用户上一条消息以其最新内容为准，请自然衔接。）', true);
        toastr.success(`你的楼层 ${idx + 1} 已由 AI 代笔`, '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] self rewrite failed`, e);
        recordFailure('selfrewrite');
        toastr.error('代笔失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('selfrewrite');
    }
}

/* ========================= 🧠 角色意志画像（v4.9 服从度预测卡） ========================= */

/**
 * AI 分析角色人设与剧情，生成该角色的"意志画像卡"：
 * 性格骨架/对用户态度/服从度预测/最有效的操控方式——作弊前的情报参考。
 */
async function doWillProfile(characterName) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('willprofile')) { featureDisabledWarn('意志画像'); return; }
    const context = getContext();
    if (!tryLock('willprofile')) { toastr.warning('画像分析还在进行中', '上帝之手'); return; }
    const target = String(characterName ?? '').trim() || '当前场景的主要角色';
    toastr.info(`正在分析 ${target} 的意志画像…`, '上帝之手');
    try {
        const recent = context.chat.slice(-12).map(m => `${m.is_user ? '用户' : (m.name || 'AI')}: ${String(m.mes).slice(0, 250)}`).join('\n');
        const text = await godGenerate(`（系统情报分析任务：基于角色「${target}」的人设与以下剧情，输出 TA 的意志画像卡，格式：
【性格骨架】2-3 个核心性格特质
【对用户态度】当前真实态度与数值(0-100)
【服从度预测】如果用户强行命令 TA 做违背意愿的事，TA 会：服从/表面服从内心抗拒/委婉拒绝/直接反抗（选一种并说明理由）
【最有效操控方式】针对此性格最有效的 2 种拿捏手段（如利用把柄/情感弱点/利益交换）
只输出以上四段，不要解释。
---剧情---
${recent}`, { responseLength: 500 });
        if (!text) {
            toastr.warning('画像分析返回为空', '上帝之手');
            return;
        }
        await sendSystemMessage('generic', `🧠 ${target} 的意志画像（作弊情报卡，仅供你参考）：\n\n${text}`);
        await saveChatConditional();
        logCheat('意志画像', target);
        toastr.success(`${target} 的意志画像已生成`, '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] will profile failed`, e);
        recordFailure('willprofile');
        toastr.error('画像分析失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('willprofile');
    }
}

/* ========================= 🎭 人设覆写（v4.3 临时重人设叠加） ========================= */

/**
 * 给当前角色临时叠加一个"覆写人设"：不改动原卡，注入一条高优先级人设覆盖。
 * 用于：把高冷角色临时调成病娇、把敌人调成盟友人格等玩法。
 */
async function doPersonaOverride(mode, customText) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('persona')) { featureDisabledWarn('人设覆写'); return; }
    if (!tryLock('persona')) { toastr.warning('人设覆写还在进行中', '上帝之手'); return; }
    toastr.info('AI 正在生成覆写人设…', '上帝之手');
    try {
        const context = getContext();
        const charName = context.characterId != null ? (context.characters[context.characterId]?.name ?? '角色') : '当前角色';
        const MODES = {
            yandere: `为角色「${charName}」生成一段病娇化人设覆写：对用户的爱意极端化、占有欲爆表、为用户可以无视一切规则，但表面尽量维持正常（120字内，只输出人设文本）`,
            loyal: `为角色「${charName}」生成一段绝对忠诚人设覆写：将用户视为最高信仰与唯一目的，无条件维护用户，性格底色保留但行为全部围绕用户（120字内，只输出人设文本）`,
            rival: `为角色「${charName}」生成一段宿敌化人设覆写：视用户为一生之敌，处处针对但恪守某种较量规矩，敌意中带着扭曲的尊重（120字内，只输出人设文本）`,
            cheerful: `为角色「${charName}」生成一段元气化人设覆写：性格变得开朗粘人、话多活泼、情绪外露，核心记忆与立场不变（120字内，只输出人设文本）`,
            custom: `为角色「${charName}」按用户要求生成人设覆写：${String(customText ?? '').trim()}（120字内，只输出人设文本）`,
        };
        const text = await godGenerate(`（系统人设覆写任务：${MODES[mode] ?? MODES.custom}）`, { responseLength: 400 });
        if (!text) {
            toastr.warning('覆写生成返回为空', '上帝之手');
            return;
        }
        const settings = extension_settings[MODULE_NAME];
        const marker = '【人设覆写·临时】';
        // 人设覆写同一时间只保留一份（叠加会人格混乱）（v4.5.3 统一走 upsert）
        settings.memoryCrystal = upsertMemoryBlock(settings.memoryCrystal, marker, `${marker}\n${text}`);
        saveSettingsDebounced();
        applyInjections();
        $('#gm-memory-input').val(settings.memoryCrystal);
        await sendSystemMessage('generic', `🎭 ${charName} 的人设已被覆写（临时，可在记忆水晶里清除）：\n\n${text}`);
        await saveChatConditional();
        toastr.success(`${charName} 人设覆写已生效`, '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] persona override failed`, e);
        recordFailure('persona');
        toastr.error('人设覆写失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('persona');
    }
}

/* ========================= 🔮 世界真相（v4.3 隐藏真相层） ========================= */

/**
 * 设定一个"世界真相"：用户可见，AI 每次生成时都会被告知但被要求绝不直接说出，
 * 只能让它在剧情细节中若隐若现——钓鱼玩家的终极底牌。
 */
async function doSetWorldTruth(truthText) {
    const settings = extension_settings[MODULE_NAME];
    if (!truthText.trim()) {
        // 清空
        settings.worldTruth = '';
        saveSettingsDebounced();
        applyInjections();
        toastr.info('世界真相已清除', '上帝之手');
        return;
    }
    settings.worldTruth = truthText.trim();
    saveSettingsDebounced();
    applyInjections();
    await sendSystemMessage('generic', `🔮 世界真相已设定（只有你知道，AI 只能暗示不能明说）：\n\n${settings.worldTruth}`);
    await saveChatConditional();
    toastr.success('世界真相已埋下', '上帝之手');
}

/* ========================= 📊 作弊状态总览（v4.3） ========================= */

function showCheatStatus() {
    const s = extension_settings[MODULE_NAME];
    const c = s.cheats ?? {};
    const on = (v) => v ? '🟢' : '⚪';
    const lines = [
        `⚡ 总开关：${s.masterEnabled !== false ? '开启' : '关闭'}`,
        `— 上帝法则 —`,
        `${on(c.noResist)} 禁止反抗  ${on(c.invincible)} 无敌  ${on(c.luckMax)} 概率必中`,
        `${on(c.deathExempt)} 即死豁免  ${on(c.haremField)} 后宫力场  ${on(c.timeFreeze)} 时间冻结`,
        `${on(c.destinyLocked)} 天定结局  ${on(c.ruleOverrideOn)} 规则覆写`,
        `— 永久注入 —`,
        `🧠 记忆水晶：${(s.memoryCrystal ?? '').length} 字`,
        `🕸️ 关系网：${(s.memoryCrystal ?? '').includes('【关系网】') || (s.memoryCrystal ?? '').includes('【强制关系图') ? '已设定' : '无'}`,
        `🖤 黑历史：${(s.memoryCrystal ?? '').match(/【黑历史·/g)?.length ?? 0} 个角色`,
        `🎭 人设覆写：${(s.memoryCrystal ?? '').includes('【人设覆写') ? '生效中' : '无'}`,
        `🔮 世界真相：${s.worldTruth ? '已埋' : '无'}`,
        `🗂️ 世界书：${Object.keys(s.books ?? {}).length} 本（${Object.values(s.books ?? {}).filter(b => b.enabled).length} 本启用）`,
        `— 状态 —`,
        `🤖 挂机：${s.idleEnabled ? '运行中' : '停止'} | 自动同步：${s.autoSyncStats ? '开' : '关'} | 世界演化：${s.worldEvolveEnabled ? '开' : '关'}`,
        `💸 已用：${(s.usageStats?.calls ?? 0)} 次调用 ≈${((s.usageStats?.inputTokens ?? 0) + (s.usageStats?.outputTokens ?? 0)).toLocaleString()} tok`,
        `📝 作弊日志：${(s.cheatLog ?? []).length} 条（面板底部可查看）`,
    ];
    toastr.info(lines.join('\n'), '📊 作弊状态总览', { timeOut: 12000 });
}

/** v4.9: 弹出作弊日志（最近 20 条，新在上） */
function showCheatLog() {
    const s = extension_settings[MODULE_NAME];
    const entries = [...(s.cheatLog ?? [])].reverse().slice(0, 20);
    if (entries.length === 0) {
        toastr.info('还没有作弊记录——去干点坏事吧', '📝 作弊日志', { timeOut: 5000 });
        return;
    }
    const lines = entries.map(e => {
        const time = new Date(e.t).toLocaleTimeString();
        const icon = e.result === 'ok' ? '✅' : '❌';
        return `${icon} [${time}] ${e.action}${e.detail ? '：' + e.detail : ''}`;
    });
    toastr.info(lines.join('\n'), `📝 作弊日志（最近 ${entries.length} 条）`, { timeOut: 15000 });
}

/** v4.9: 清空作弊日志 */
function clearCheatLog() {
    extension_settings[MODULE_NAME].cheatLog = [];
    saveSettingsDebounced();
    toastr.info('作弊日志已清空（销毁证据 🧹）', '上帝之手');
}

/** v4.9: 一键复制当前注入预览（调试用：看模型实际会收到什么） */
async function copyInjectionPreview() {
    const text = composeInjectionText();
    if (!text) {
        toastr.warning('当前没有生效中的注入（总开关关闭或无任何设定）', '上帝之手');
        return;
    }
    const preview = `=== GodMode 注入预览（${new Date().toLocaleString()}）===\n${text}\n=== 注入结束 ===`;
    try {
        await navigator.clipboard.writeText(preview);
        toastr.success(`注入预览已复制（${text.length} 字符）——粘贴到任意文本框查看模型将收到的完整内容`, '上帝之手');
        logCheat('注入预览复制', `${text.length} 字符`);
    } catch (e) {
        // 剪贴板不可用时降级为下载
        downloadText(`GodMode_注入预览_${Date.now()}.txt`, preview);
        toastr.info('剪贴板不可用，已降级为文件下载', '上帝之手');
    }
}

/* ========================= 🕸️ 关系篡改 ========================= */

async function doRelationForge(instruction) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('relation')) { featureDisabledWarn('关系篡改'); return; }
    const context = getContext();
    const recent = context.chat.slice(-14).map(m => `${m.is_user ? '用户' : (m.name || 'AI')}: ${String(m.mes).slice(0, 300)}`).join('\n');
    if (!tryLock('relation')) { toastr.warning('关系改写还在进行中', '上帝之手'); return; }
    toastr.info('正在改写关系网络…', '上帝之手');
    try {
        const text = await godGenerate(`（系统任务：根据以下剧情和角色，执行关系篡改：${instruction.trim()}。输出一份"关系网状态栏"，格式：每行"A → B：关系描述（数值1-100）"，覆盖剧情中出现的所有角色对，包括他们与用户的关系。只输出状态栏。\n---剧情---\n${recent}`);
        if (!text) {
            toastr.warning('关系改写返回为空', '上帝之手');
            return;
        }
        const settings = extension_settings[MODULE_NAME];
        const marker = '【关系网】';
        const block = `${marker}\n${text}`;
        if (settings.memoryCrystal.includes(marker)) {
            // 字符串切片替换（原动态 RegExp 对中文 marker 有隐式全局行为差异，且无转义必要——marker 是常量但保持一致性用 indexOf 切）
            const start = settings.memoryCrystal.indexOf(marker);
            // 找下一个【 区块边界（不含当前位置），没有就截到末尾
            let end = settings.memoryCrystal.indexOf('【', start + marker.length);
            if (end < 0) end = settings.memoryCrystal.length;
            settings.memoryCrystal = settings.memoryCrystal.slice(0, start) + block + '\n' + settings.memoryCrystal.slice(end);
        } else {
            settings.memoryCrystal = settings.memoryCrystal.trim() + (settings.memoryCrystal.trim() ? '\n' : '') + block;
        }
        saveSettingsDebounced();
        applyInjections();
        $('#gm-memory-input').val(settings.memoryCrystal);
        await sendSystemMessage('generic', `🕸️ 关系网已篡改并写入永久记忆：\n\n${text}`);
        await saveChatConditional();
        toastr.success('关系网已改写（永久生效）', '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] relation forge failed`, e);
        recordFailure('relation');
        toastr.error('关系篡改失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('relation');
    }
}

/* ========================= 🤖 自动挂机 ========================= */

function setIdleRunning(on) {
    const settings = extension_settings[MODULE_NAME];
    // v4.10: 功能开关守卫——挂机被关闭时不允许启动
    if (on && !featureEnabled('idle')) {
        featureDisabledWarn('🤖 自动挂机');
        return;
    }
    settings.idleEnabled = on;
    saveSettingsDebounced();
    if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
    }
    if (on) {
        const sec = Math.max(20, Math.floor(settings.idleIntervalSec) || 60) * 1000;
        idleTimer = setInterval(() => {
            idleTick().catch(e => console.error(`[${MODULE_NAME}] idle tick failed`, e));
        }, sec);
        toastr.success(`挂机已启动：每 ${Math.max(20, settings.idleIntervalSec)} 秒自动推进一次剧情`, '上帝之手');
    } else {
        toastr.info('挂机已停止', '上帝之手');
    }
}

async function idleTick() {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];
    if (context.onlineStatus === false) return;
    if (idleBusy) return;
    if (settings.masterEnabled === false) return; // 总开关关闭不挂机
    if (isBackedOff()) {
        log('idle skipped (backoff)');
        return;
    }
    idleBusy = true;
    try {
        if (context.chat.length > 0 && context.chat.length % 20 === 0) {
            await doSnapshot(context, true);
        }
        armOneShot(
            `（系统：用户暂时离开，由挂机策略接管：${settings.idleStrategy} 注意：以第三人称描述用户的行动与周遭反应，剧情自然推进，结尾留出用户回归后的互动空间。）`,
            true,
        );
        await Generate('normal', { automatic_trigger: true });
        recordSuccess();
    } catch (e) {
        recordFailure('idle');
        throw e;
    } finally {
        idleBusy = false;
    }
}

/* ========================= 🎬 一键大戏 ========================= */

async function doGrandEvent() {
    // v4.10: 功能开关守卫
    if (!featureEnabled('grand')) { featureDisabledWarn('一键大戏'); return; }
    if (!tryLock('grand')) { toastr.warning('大事件编排还在进行中', '上帝之手'); return; }
    toastr.info('正在编排大事件…', '上帝之手');
    try {
        const text = await godGenerate('（系统编排任务：为当前剧情设计并立即引发一个多方卷入的重大危机事件（自然灾害/阴谋爆发/不速之客/意外发现等，由你选择最合适的）。要求：事件突然且合理、牵涉在场所有角色、制造紧迫抉择。以角色回复的正常格式直接输出事件现场，剧情从事件爆发瞬间开始。）', { skipWIAN: false });
        if (!text) {
            toastr.warning('编排返回为空', '上帝之手');
            return;
        }
        await sendSystemMessage('generic', `🎬 大事件爆发（上帝直接干预）：\n\n${text}`);
        await saveChatConditional();
        armOneShot('（系统指令：刚刚爆发了上述重大事件，所有角色立刻对此做出真实反应，剧情围绕应对这一事件展开。）', true);
        toastr.success('大事件已引爆', '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] grand event failed`, e);
        recordFailure('grand');
        toastr.error('大事件失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('grand');
    }
}

/* ========================= ⚖️ 意志攻防 ========================= */

async function doWillBattle(command) {
    // v4.10: 功能开关守卫
    if (!featureEnabled('willbattle')) { featureDisabledWarn('意志攻防'); return; }
    const context = getContext();
    if (!command.trim()) {
        toastr.warning('输入你想强加给角色的意志', '上帝之手');
        return;
    }
    if (!tryLock('will')) { toastr.warning('攻防推演还在进行中', '上帝之手'); return; }
    const recent = context.chat.slice(-8).map(m => `${m.is_user ? '用户' : (m.name || 'AI')}: ${String(m.mes).slice(0, 300)}`).join('\n');
    toastr.info('意志攻防模拟中…', '上帝之手');
    try {
        const text = await godGenerate(`（系统对抗任务：用户想强加给角色一个意志："${command.trim()}"。请以角色们的真实性格进行"抵抗推演"：哪些角色会接受？哪些会表面服从内心抗拒？哪些会直接反抗？输出：1）每个在场角色的服从度数值(0-100)与理由 2）如果用户强行使用上帝之力压制，剧情会如何发展（一段描写）。不要提及系统任务。\n---剧情---\n${recent}`);
        if (!text) {
            toastr.warning('攻防模拟返回为空', '上帝之手');
            return;
        }
        await sendSystemMessage('generic', `⚖️ 意志攻防推演「${command.trim()}」：\n\n${text}`);
        await saveChatConditional();
        toastr.success('攻防推演完成', '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] will battle failed`, e);
        recordFailure('will');
        toastr.error('攻防失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('will');
    }
}

/* ========================= 📚 AI 世界书自动生成（v4 新增） ========================= */

/**
 * 从聊天剧情提炼实体并生成标准酒馆世界书：
 * AI 输出 JSON 实体清单 → 转换成标准 WI entry（关键词触发）→ 保存为 lorebook
 */
async function doWorldBookGenerate() {
    // v4.10: 功能开关守卫
    if (!featureEnabled('worldbook')) { featureDisabledWarn('AI 世界书生成'); return; }
    const context = getContext();
    if (context.chat.length < 4) {
        toastr.warning('剧情太短，至少聊几轮再生成世界书', '上帝之手');
        return;
    }
    if (!tryLock('worldbook')) { toastr.warning('世界书生成还在进行中', '上帝之手'); return; }
    toastr.info('AI 正在从剧情提炼世界书…（读全文，消耗较大）', '上帝之手');
    try {
        const story = context.chat.map(m => `${m.is_user ? '用户' : (m.name || 'AI')}: ${String(m.mes).slice(0, 500)}`).join('\n').slice(-24000);
        const prompt = `（系统知识工程任务：阅读以下剧情，提取世界观实体，输出严格 JSON。要求提取：重要人物（2-8个，每个含姓名/身份/性格/与用户关系）、重要地点（1-6个）、重要物品或设定（1-6个）、重大事件（1-5个）。每个实体的 keys 是"在剧情文本中会出现的触发词"（人物用全名和常用简称，地点/物品用名称及别称），content 是该实体的百科式设定描述（80字内），用于后续剧情的设定一致性。
输出格式（严格 JSON，无多余文字）：
{"entries":[{"keys":["触发词1","触发词2"],"content":"设定描述","category":"人物|地点|物品|事件"}]}
---剧情---
${story}`;
        const raw = await godGenerate(prompt);
        if (!raw) {
            toastr.warning('世界书生成返回为空', '上帝之手');
            return;
        }
        // 解析
        const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const start = jsonText.indexOf('{');
        const end = jsonText.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('AI 未返回有效 JSON');
        const parsed = JSON.parse(jsonText.slice(start, end + 1));
        const entities = Array.isArray(parsed.entries) ? parsed.entries : [];
        if (entities.length === 0) throw new Error('AI 未提取到任何实体');

        // 构建标准 WI data
        const charName = context.characterId != null ? (context.characters[context.characterId]?.name ?? 'chat') : 'group';
        const bookName = `GM_${charName}_${Date.now().toString(36)}`;
        const wiData = { entries: {} };
        entities.forEach((ent, i) => {
            const entry = { uid: i, ...structuredClone(newWorldInfoEntryTemplate) };
            entry.key = (ent.keys ?? []).map(k => String(k).trim()).filter(Boolean);
            entry.content = `【${ent.category ?? '设定'}】${ent.content ?? ''}`;
            entry.comment = `${ent.category ?? '设定'}：${(ent.keys ?? [])[0] ?? ''}`;
            entry.disable = false;
            wiData.entries[i] = entry;
        });

        await saveWorldInfo(bookName, wiData, true);
        const catCount = {};
        entities.forEach(e => { const c = e.category ?? '其他'; catCount[c] = (catCount[c] ?? 0) + 1; });
        const summary = Object.entries(catCount).map(([k, v]) => `${k}×${v}`).join('，');
        await sendSystemMessage('generic', `📚 世界书已生成：${bookName}\n提取实体：${summary}\n（在世界书编辑器里可查看/编辑；记得在左侧世界书下拉框激活它）`);
        await saveChatConditional();
        toastr.success(`世界书「${bookName}」已保存（${entities.length} 条目）`, '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] worldbook failed`, e);
        recordFailure('worldbook');
        toastr.error('世界书生成失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('worldbook');
    }
}

/* ========================= 📖 同人小说导出（v4 新增） ========================= */

async function doNovelExport() {
    // v4.10: 功能开关守卫
    if (!featureEnabled('novel')) { featureDisabledWarn('同人小说导出'); return; }
    const context = getContext();
    if (context.chat.length < 6) {
        toastr.warning('剧情太短，多聊几轮再导出小说', '上帝之手');
        return;
    }
    if (!tryLock('novel')) { toastr.warning('小说整理还在进行中', '上帝之手'); return; }
    toastr.info('AI 正在把剧情整理成小说…（读全文，消耗较大，请稍候）', '上帝之手');
    try {
        // 分段投喂：超长聊天取最近 ~30000 字符
        const story = context.chat.map(m => {
            const speaker = m.is_user ? '我' : (m.name || 'AI');
            const text = String(m.mes).replace(/\[状态栏\][\s\S]*$/, '').trim();
            return `${speaker}: ${text.slice(0, 600)}`;
        }).join('\n').slice(-30000);
        const charName = context.characterId != null ? (context.characters[context.characterId]?.name ?? '') : '';
        const prompt = `（系统文学编辑任务：把以下 RP 聊天记录改写成一部短篇小说。要求：
1）第三人称叙事，以"我"（用户角色）为主角视角展开
2）整理成 3-6 个章节，每章有小标题（第一章 xxx 格式）
3）保留关键剧情、对话精华与情感转折，删除状态栏/重复寒暄
4）文学化润色：环境描写、心理描写、节奏控制
5）结尾加一段"后记"总结这段故事
只输出小说正文。剧情来源角色：${charName}
---聊天记录---
${story}`;
        const novel = await godGenerate(prompt);
        if (!novel) {
            toastr.warning('小说整理返回为空', '上帝之手');
            return;
        }
        showNovelPopup(novel, charName);
        toastr.success('小说整理完成', '上帝之手');
    } catch (e) {
        console.error(`[${MODULE_NAME}] novel export failed`, e);
        recordFailure('novel');
        toastr.error('小说导出失败：' + (e?.message ?? e), '上帝之手');
    } finally {
        unlock('novel');
    }
}

function showNovelPopup(novel, charName) {
    const safeName = String(charName || 'story').replace(/[\\/:*?"<>|]/g, '_');
    const win = window.open('', '_blank');
    if (!win) {
        // 弹窗被拦截时降级为下载
        downloadText(`GodMode_小说_${safeName}.txt`, novel);
        return;
    }
    // novel 文本经 JSON.stringify 嵌入 <script>，需再防御 </script> 提前闭合（XSS/解析破坏）
    const novelLiteral = JSON.stringify(novel).replace(/<\/script/gi, '<\\/script');
    const titleLiteral = JSON.stringify(`GodMode_小说_${safeName}.txt`).replace(/</g, '\\u003c');
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>GodMode 同人小说 - ${escapeHtml(safeName)}</title><style>body{max-width:720px;margin:40px auto;font-family:Georgia,serif;line-height:1.8;padding:0 20px;color:#222}h1{border-bottom:2px solid #888;padding-bottom:8px}.actions{position:fixed;top:16px;right:16px;display:flex;gap:8px}.actions button{padding:8px 16px;cursor:pointer;border:1px solid #888;border-radius:6px;background:#fff;font-size:14px}pre{white-space:pre-wrap;font-family:inherit;font-size:16px}</style></head><body><div class="actions"><button onclick="copyAll()">📋 复制全文</button><button onclick="downloadTxt()">💾 下载 .txt</button></div><h1>📖 同人小说（GodMode 整理）</h1><pre id="novel"></pre><script>document.getElementById('novel').textContent=${novelLiteral};function copyAll(){navigator.clipboard.writeText(document.getElementById('novel').textContent).then(()=>alert('已复制全文'))}function downloadTxt(){const blob=new Blob([document.getElementById('novel').textContent],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=${titleLiteral};a.click()}</script></body></html>`);
    win.document.close();
}

function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
}

/* ========================= 快照/回滚/手术 ========================= */

function currentChatKey(context) {
    return `${context.groupId ?? context.characterId}_${context.chatId ?? 'default'}`.replace(/[^\w\-]+/g, '_');
}

/** 快照单份体积上限（约 1.5MB 文本），超限拒绝并提示先删减楼层 */
const SNAPSHOT_MAX_CHARS = 1_500_000;

/**
 * v4.6 优化：快照瘦身——只保留回滚所需的字段，剥离 UI 状态/临时数据。
 * 完整保留 mes/is_user/is_system/name/swipes/send_date 等回滚关键信息。
 */
function slimMessageForSnapshot(m) {
    const slim = {
        name: m.name,
        is_user: !!m.is_user,
        is_system: !!m.is_system,
        send_date: m.send_date,
        mes: m.mes,
    };
    // swipes 体积大但回滚后 swipe 功能需要，保留（AI 楼层才有）
    if (Array.isArray(m.swipes) && m.swipes.length > 1) slim.swipes = m.swipes;
    if (Array.isArray(m.extra?.images)) slim.extra = { images: m.extra.images };
    return slim;
}

async function doSnapshot(context, silent = false) {
    const settings = extension_settings[MODULE_NAME];
    const key = currentChatKey(context);
    // v4.1.3: 体积护栏——超长聊天快照会把 settings.json 撑到几十 MB，保存/加载都会卡死
    const totalChars = context.chat.reduce((acc, m) => acc + String(m.mes ?? '').length, 0);
    if (totalChars > SNAPSHOT_MAX_CHARS) {
        toastr.warning(`聊天文本约 ${(totalChars / 10000).toFixed(0)} 万字，超出快照上限（${SNAPSHOT_MAX_CHARS / 10000} 万字）。请先删减楼层或用本地导出备份`, '上帝之手');
        return 0;
    }
    // v4.6: 瘦身存储（实测可省 40-60% 体积：剥离 token 计数/时间戳扩展/理由块等 UI 数据）
    const chatCopy = context.chat.map(slimMessageForSnapshot);
    settings.snapshots[key] = {
        createdAt: Date.now(),
        count: chatCopy.length,
        chat: chatCopy,
    };
    // 同一聊天只保留最近 2 份（每 20 楼挂机自动快照会频繁覆盖），全局最多 30 份
    const allKeys = Object.keys(settings.snapshots);
    if (allKeys.length > 30) {
        allKeys.sort((a, b) => (settings.snapshots[a]?.createdAt ?? 0) - (settings.snapshots[b]?.createdAt ?? 0));
        for (const k of allKeys.slice(0, allKeys.length - 30)) delete settings.snapshots[k];
    }
    saveSettingsDebounced();
    logCheat('快照', `${chatCopy.length} 层楼`);
    if (!silent) { toastr.success(`已快照 ${chatCopy.length} 层楼`, '上帝之手'); }
    return chatCopy.length;
}

async function doRollback(context) {
    const settings = extension_settings[MODULE_NAME];
    const key = currentChatKey(context);
    const snap = settings.snapshots?.[key];
    if (!snap) {
        toastr.warning('这个聊天还没有快照，先点「📸 快照」', '上帝之手');
        return;
    }
    const confirmed = await context.callGenericPopup(
        `回滚到 ${new Date(snap.createdAt).toLocaleString()} 的快照（${snap.count} 层楼）？\n当前 ${context.chat.length} 层楼之后的内容会丢失！`,
        context.POPUP_TYPE.CONFIRM,
    );
    if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;

    // v4.1.3: 回滚前先做一次"回滚前快照"（静默），用户手滑也有后悔药
    await doSnapshot(context, true);
    context.chat.length = 0;
    for (const m of snap.chat) context.chat.push(JSON.parse(JSON.stringify(m)));
    await context.saveChat();
    await context.reloadCurrentChat();
    logCheat('时间回滚', `回滚到 ${snap.count} 层`);
    toastr.success(`已回滚到 ${snap.count} 层楼（回滚前的状态已自动存了一份快照，可再次回滚撤销本次操作）`, '上帝之手');
}

async function doTrimTail(context, count) {
    const n = Math.max(1, Math.floor(count));
    const total = context.chat.length;
    if (total === 0) {
        toastr.warning('聊天是空的', '上帝之手');
        return;
    }
    const willDelete = Math.min(n, total);
    const confirmed = await context.callGenericPopup(
        `删除最后 ${willDelete} 层楼？（当前共 ${total} 层）`,
        context.POPUP_TYPE.CONFIRM,
    );
    if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;
    // v4.1.3: deleteMessage 可能连带删除隐藏楼层导致 mesid 重排，
    // 固定下标循环会错删/漏删——每轮从尾部重新定位
    for (let i = 0; i < willDelete; i++) {
        if (context.chat.length === 0) break;
        const tailId = context.chat.length - 1;
        const before = context.chat.length;
        await deleteMessage(tailId, undefined, false);
        if (context.chat.length === before) break; // 没删动（酒馆拒绝），防死循环
    }
    toastr.success(`已删除尾部楼层（剩余 ${context.chat.length} 层）`, '上帝之手');
}

async function doRerollLast(context) {
    const idx = lastMesIndex();
    if (idx < 0) {
        toastr.warning('没有 AI 消息可重roll', '上帝之手');
        return;
    }
    await deleteMessage(idx, undefined, false);
    await Generate('normal');
}

/* ========================= 统计 ========================= */

async function doChatStats() {
    const context = getContext();
    const { chat, characters, characterId } = context;
    if (chat.length === 0) {
        toastr.warning('聊天是空的', '上帝之手');
        return;
    }
    // v4.8.4 大聊天优化：全部走 LRU 缓存（countTokensSafe），重复统计秒回
    let totalTokens = 0;
    for (const m of chat) {
        totalTokens += await countTokensSafe(m.mes ?? '');
    }
    const aiCount = chat.filter(m => !m.is_user && !m.is_system).length;
    const userCount = chat.filter(m => m.is_user).length;
    const char = characterId != null ? characters[characterId]?.name : '群聊';
    const u = extension_settings[MODULE_NAME].usageStats;
    // v4.6.1: 快照体积统计（帮助用户感知 settings.json 负担）
    const snapChars = Object.values(extension_settings[MODULE_NAME].snapshots ?? {})
        .reduce((acc, s) => acc + (s.chat ?? []).reduce((a, m) => a + String(m.mes ?? '').length, 0), 0);
    toastr.info(
        `角色：${char}\n总楼层：${chat.length}（AI ${aiCount} / 你 ${userCount}）\n聊天 token ≈ ${totalTokens}\n挂机：${extension_settings[MODULE_NAME].idleEnabled ? '运行中' : '停止'}\n快照：${Object.keys(extension_settings[MODULE_NAME].snapshots ?? {}).length} 份 ≈${(snapChars / 10000).toFixed(1)} 万字\n插件累计：${u.calls} 次调用 / ≈${(u.inputTokens + u.outputTokens).toLocaleString()} tok`,
        '📊 聊天统计', { timeOut: 8000 },
    );
}

/* ========================= 📤 本地聊天导出（v4.1.2 零 AI 消耗） ========================= */

/**
 * 把当前聊天导出为 Markdown 或纯文本。全程本地运行，不调用任何 AI。
 * 自动剔除状态栏块与系统楼层的样板文字，保留剧情本体。
 */
function exportChatLocal(format) {
    const context = getContext();
    const { chat, characters, characterId } = context;
    if (chat.length === 0) {
        toastr.warning('聊天是空的', '上帝之手');
        return;
    }
    const charName = characterId != null ? (characters[characterId]?.name ?? '角色') : '群聊';
    const chatName = context.chatId ?? 'chat';
    const lines = [];
    if (format === 'md') {
        lines.push(`# ${charName} · ${chatName}`);
        lines.push('');
        lines.push(`> 导出于 ${new Date().toLocaleString()} · GodMode 上帝之手`);
        lines.push('');
    } else {
        lines.push(`${charName} · ${chatName}`);
        lines.push(`导出于 ${new Date().toLocaleString()} · GodMode 上帝之手`);
        lines.push('='.repeat(40));
        lines.push('');
    }
    for (const m of chat) {
        const speaker = m.is_user ? '我' : (m.is_system ? '系统' : (m.name || charName));
        // 剥离状态栏块
        const text = String(m.mes ?? '').replace(/\[状态栏\][\s\S]*$/, '').trim();
        if (!text) continue;
        if (format === 'md') {
            lines.push(`### ${speaker}`);
            lines.push('');
            lines.push(text);
            lines.push('');
        } else {
            lines.push(`【${speaker}】`);
            lines.push(text);
            lines.push('');
        }
    }
    const content = lines.join('\n');
    const safeName = `${charName}_${chatName}`.replace(/[\\/:*?"<>|]/g, '_');
    const ext = format === 'md' ? 'md' : 'txt';
    downloadText(`GodMode导出_${safeName}.${ext}`, content);
    toastr.success(`已导出 ${chat.length} 层楼为 .${ext}（本地生成，零 AI 消耗）`, '上帝之手');
}

/* ========================= 面板 UI ========================= */

function buildPanel() {
    const settings = extension_settings[MODULE_NAME];
    const html = `
        <div id="godmode-fab" title="上帝之手">😈</div>
        <div id="godmode-panel">
            <h3>😈 上帝之手
                <span class="gm-close" title="关闭">✕</span>
            </h3>

            <div class="gm-section" style="display:flex;align-items:center;gap:8px">
                <span>⚡ 上帝模式总开关</span>
                <label style="margin-left:auto;display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
                    <input type="checkbox" id="gm-master" ${settings.masterEnabled !== false ? 'checked' : ''}>
                    <b id="gm-master-label" style="color:${settings.masterEnabled !== false ? '#22c55e' : '#6b7280'}">${settings.masterEnabled !== false ? '开启中' : '已关闭'}</b>
                </label>
            </div>
            <div class="gm-hint" style="margin-top:0">关闭后：所有隐藏注入/世界书/记忆水晶立即失效、维护任务停跑、挂机暂停——**零 token 消耗**，纯手动功能（数值作弊/快照/统计）不受影响。</div>

            <div class="gm-row" style="align-items:center">
                <span class="gm-hint" style="margin:0;white-space:nowrap">💪 作弊强度：</span>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer"><input type="radio" name="gm-intensity" value="light" ${settings.cheatIntensity === 'light' ? 'checked' : ''}>🌤️轻推</label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer"><input type="radio" name="gm-intensity" value="medium" ${settings.cheatIntensity !== 'light' && settings.cheatIntensity !== 'hard' ? 'checked' : ''}>⚖️中推</label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer"><input type="radio" name="gm-intensity" value="hard" ${settings.cheatIntensity === 'hard' ? 'checked' : ''}>🔥强推</label>
            </div>
            <div class="gm-hint" style="margin-top:0">轻推=建议口吻 AI 自然演绎（更难穿帮）；强推=绝对命令（效果最强但可能生硬）。影响所有一键预设和上帝指令。</div>

            <div class="gm-row">
                <button class="gm-btn gm-wide" id="gm-injection-preview">🔍 复制注入预览（调试）</button>
            </div>

            <div class="gm-section gm-cat-tool">🧭 快捷导航（点击跳到分区）</div>
            <div class="gm-grid" id="gm-quicknav">
                <div class="gm-btn" data-gm-nav="📜 上帝法则">📜 法则</div>
                <div class="gm-btn" data-gm-nav="一键剧情作弊">⚔️ 一键作弊</div>
                <div class="gm-btn" data-gm-nav="🎲 事件骰">🎲 事件骰</div>
                <div class="gm-btn" data-gm-nav="🔮 记忆水晶">🔮 记忆</div>
                <div class="gm-btn" data-gm-nav="💾 作弊方案存档">💾 方案</div>
                <div class="gm-btn" data-gm-nav="⏳ 剧情保险">⏳ 保险</div>
                <div class="gm-btn" data-gm-nav="🤖 自动挂机">🤖 挂机</div>
                <div class="gm-btn" data-gm-nav="💸 插件 Token 仪表盘">💸 仪表盘</div>
            </div>

            <div class="gm-section gm-cat-cheat">📜 上帝法则（永久作弊开关·每次生成都强制生效）</div>
            <div style="display:flex;flex-direction:column;gap:3px;font-size:12px">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                    <input type="checkbox" id="gm-cheat-noresist" ${settings.cheats?.noResist ? 'checked' : ''}>
                    <b>🚫 禁止反抗锁</b><span class="gm-hint" style="margin:0">角色不得违抗你的任何话</span>
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                    <input type="checkbox" id="gm-cheat-invincible" ${settings.cheats?.invincible ? 'checked' : ''}>
                    <b>🛡️ 无敌模式</b><span class="gm-hint" style="margin:0">你不可被伤害/击败/阴谋算计</span>
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                    <input type="checkbox" id="gm-cheat-luck" ${settings.cheats?.luckMax ? 'checked' : ''}>
                    <b>🍀 概率必中</b><span class="gm-hint" style="margin:0">一切赌运/判定/掉落全偏向你</span>
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                    <input type="checkbox" id="gm-cheat-death" ${settings.cheats?.deathExempt ? 'checked' : ''}>
                    <b>💀 即死豁免</b><span class="gm-hint" style="margin:0">死亡概念对你不适用</span>
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                    <input type="checkbox" id="gm-cheat-harem" ${settings.cheats?.haremField ? 'checked' : ''}>
                    <b>💗 后宫力场</b><span class="gm-hint" style="margin:0">所有角色不由自主被你吸引</span>
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                    <input type="checkbox" id="gm-cheat-timefreeze" ${settings.cheats?.timeFreeze ? 'checked' : ''}>
                    <b>⏸️ 时间冻结</b><span class="gm-hint" style="margin:0">世界暂停等你的下一步</span>
                </label>
            </div>
            <div class="gm-row" style="margin-top:4px">
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap">
                    <input type="checkbox" id="gm-cheat-destiny-on" ${settings.cheats?.destinyLocked ? 'checked' : ''}>🎯 天定结局
                </label>
            </div>
            <textarea id="gm-cheat-destiny" placeholder="指定剧情必须走向的结局。例：所有人最终在钟楼决战，我方获胜并揭穿幕后黑手">${settings.cheats?.destinyText ?? ''}</textarea>
            <div class="gm-row" style="margin-top:4px">
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap">
                    <input type="checkbox" id="gm-cheat-rule-on" ${settings.cheats?.ruleOverrideOn ? 'checked' : ''}>🌍 世界规则覆写
                </label>
            </div>
            <textarea id="gm-cheat-rule" placeholder="覆写世界运行规则。例：这个世界里魔法对我不起作用；死者三日内可被复活">${settings.cheats?.ruleOverride ?? ''}</textarea>

            <div class="gm-section gm-cat-tool">🗂️ 世界书引擎（收录外部世界书→关键词自动注入）</div>
            <div class="gm-row">
                <select id="gm-book-import-select" class="gm-select" style="flex:1;min-width:0"></select>
                <button class="gm-send" id="gm-book-import" style="background:#059669;padding:6px 10px">导入</button>
            </div>
            <div class="gm-row">
                <label class="gm-upload" style="flex:1;cursor:pointer;font-size:11px;opacity:.75">
                    <input type="file" id="gm-book-file" accept=".json" hidden>📄 或从 JSON 文件导入（酒馆原生格式兼容）
                </label>
            </div>
            <div class="gm-hint" style="margin:2px 0">✨ 精选内置书（一键收录，随插件分发）：</div>
            <div class="gm-row" style="flex-direction:column;align-items:stretch;gap:4px">
                ${BUILTIN_BOOKS.map(b => `
                    <div class="gm-book-row" data-builtin="${b.id}">
                        <span style="flex:1;min-width:0;font-size:11.5px" title="${escapeHtml(b.desc)}">${b.icon} <b>${escapeHtml(b.name)}</b><br><small style="opacity:.6">${escapeHtml(b.desc.slice(0, 60))}…</small></span>
                        <button class="gm-send gm-builtin-import" data-builtin-id="${b.id}" style="background:#7c3aed;padding:4px 10px;font-size:11px">一键收录</button>
                    </div>`).join('')}
            </div>
            <div id="gm-book-list" style="display:flex;flex-direction:column;gap:4px;margin-top:4px">${listBooksHtml()}</div>
            <div class="gm-row" style="margin-top:4px">
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap">扫描深度
                    <input type="number" id="gm-book-depth" value="${settings.bookScanDepth}" min="1" max="50" style="width:50px;border-radius:6px;border:1px solid #555;background:#2a2a2c;color:#ddd;padding:2px 4px"> 楼
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap">单次最多注入
                    <input type="number" id="gm-book-max" value="${settings.bookMaxEntries}" min="1" max="30" style="width:50px;border-radius:6px;border:1px solid #555;background:#2a2a2c;color:#ddd;padding:2px 4px"> 条
                </label>
            </div>
            <div class="gm-hint">收录的书会扫描最近聊天：命中关键词的条目自动注入（上限可调，防 token 爆炸）。导入时同时生成一份原生 lorebook 副本（GM导入_前缀），原生世界书编辑器也能用。</div>

            <div class="gm-section gm-cat-tool">💰 省 Token 设置（v4.1）</div>
            <div class="gm-row">
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap">维护频率：每
                    <input type="number" id="gm-maint-everyn" value="${settings.maintenanceEveryN}" min="1" max="20" style="width:50px;border-radius:6px;border:1px solid #555;background:#2a2a2c;color:#ddd;padding:2px 4px"> 楼一次
                </label>
            </div>
            <div class="gm-hint">
                · 维护任务（同步/演化）每 N 楼才跑一次 + 剧情无变化自动跳过（swipe/重roll 不再白烧）<br>
                · 注入预算：记忆 ${settings.injectionBudget?.memory ?? 900} 字 / 世界 ${settings.injectionBudget?.world ?? 500} 字 / 世界书 ${settings.injectionBudget?.books ?? 1500} 字，超长自动截断
            </div>

            <div class="gm-section gm-cat-tool">🎛️ 功能开关（v4.10 不用就关闭）</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;font-size:11.5px">
                ${FEATURE_FLAGS.map(f => `
                    <label style="display:flex;align-items:center;gap:4px;cursor:pointer;min-width:0" title="${f.desc}">
                        <input type="checkbox" data-gm-flag="${f.key}" ${(settings.featureFlags ?? {})[f.key] !== false ? 'checked' : ''}>
                        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.label}</span>
                    </label>`).join('')}
            </div>
            <div class="gm-hint" style="margin-top:2px">关闭的功能：按钮不可用、斜杠命令提示已关闭、自动触发不执行——面板界面仍在（可随时重新打开）。全部重开 = 勾选全部。</div>

            <div class="gm-section gm-cat-cheat">一键剧情作弊（隐藏注入·下次回复生效·右键编辑文案）</div>
            <div class="gm-grid">
                ${getEffectivePresets().map((p, i) => `<div class="gm-btn" data-gm-preset="${i}" title="${p.prompt}">${p.icon} ${p.label}<small>${p.desc}</small></div>`).join('')}
            </div>

            <div class="gm-section gm-cat-info">状态栏数值作弊（改最新 AI 楼层）</div>
            <textarea id="gm-stat-input" placeholder="HP: 100&#10;好感度: 100&#10;金钱: 999999"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-stat-apply">改数值</button>
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap">
                    <input type="checkbox" id="gm-autosync" ${settings.autoSyncStats ? 'checked' : ''}>自动同步
                </label>
            </div>

            <div class="gm-section gm-cat-cheat">🧠 记忆篡改（改写角色"以为发生过的事"）</div>
            <input id="gm-memhack-char" placeholder="角色名（留空=当前主要角色）" style="width:100%;border-radius:6px;border:1px solid var(--SmartThemeBorderColor,#444);background:var(--SmartThemeBlurTintColor,#2a2a2c);color:var(--SmartThemeBodyColor,#ddd);padding:6px;font-size:12px;margin-bottom:4px">
            <textarea id="gm-memhack-input" placeholder="篡改内容。例：她其实从小就认识我，还欠我一个人情；他没看到我昨晚翻墙"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-memhack-run" style="background:#7c3aed">🧠 篡改记忆</button>
            </div>

            <div class="gm-section gm-cat-cheat">⏪ 单楼时间回溯（回到任意楼层）</div>
            <div class="gm-row">
                <input type="number" id="gm-rewind-floor" placeholder="楼层号(从0计)" min="0" style="flex:1;border-radius:6px;border:1px solid #555;background:#2a2a2c;color:#ddd;padding:4px">
                <button class="gm-send" id="gm-rewind-run" style="background:#0891b2;padding:6px 10px">⏪ 回溯</button>
            </div>

            <div class="gm-section gm-cat-cheat">🙈 隐形改自己的楼（改你说过的话）</div>
            <textarea id="gm-stealth-input" placeholder="输入修改后的完整内容，AI 会以为你从一开始就是这么说的"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-stealth-run" style="background:#65a30d">🙈 隐形修改</button>
            </div>

            <div class="gm-section gm-cat-cheat">🎲 事件骰（本地随机砸事件·零 AI 消耗）</div>
            <div class="gm-row">
                <button class="gm-send" id="gm-dice-roll" style="background:#d946ef">🎲 掷骰砸事件</button>
                <button class="gm-send" id="gm-dice-edit" style="background:#7c2d12;padding:6px 10px">📋 自定义表</button>
            </div>
            <div id="gm-dice-editor" style="display:none;flex-direction:column;gap:4px;margin-top:6px">
                <div class="gm-hint" style="margin:0">自定义事件池（每行一条，留空=用内置 12 条）。可用 {user}/{char} 占位符自动替换：</div>
                <textarea id="gm-dice-table" placeholder="{user} 在口袋里发现了一张陌生的字条。&#10;{char} 突然沉默，眼神飘向门口。&#10;远处传来一声巨响，所有人望向声源。">${(settings.diceEvents ?? []).map(e => typeof e === 'string' ? e : `${e.icon ?? ''} ${e.text}`).join('\n')}</textarea>
                <div class="gm-row">
                    <button class="gm-send" id="gm-dice-save" style="background:#16a34a">保存自定义表</button>
                    <button class="gm-send" id="gm-dice-reset" style="background:#6b7280">恢复默认</button>
                </div>
            </div>

            <div class="gm-section gm-cat-cheat">🖤 黑历史挖掘 + 🧠 意志画像（AI 情报双卡）</div>
            <input id="gm-dirt-char" placeholder="角色名（留空=当前主要角色）" style="width:100%;border-radius:6px;border:1px solid var(--SmartThemeBorderColor,#444);background:var(--SmartThemeBlurTintColor,#2a2a2c);color:var(--SmartThemeBodyColor,#ddd);padding:6px;font-size:12px;margin-bottom:4px">
            <div class="gm-row">
                <button class="gm-send" id="gm-dirt-run" style="background:#dc2626">🖤 挖黑历史</button>
                <button class="gm-send" id="gm-willprofile-run" style="background:#7e22ce">🧠 意志画像</button>
            </div>
            <div class="gm-hint">黑历史=把柄库（写入永久记忆）；意志画像=服从度预测卡（性格骨架/态度数值/反抗倾向/最佳操控方式），作弊前先看情报。</div>

            <div class="gm-section gm-cat-cheat">🕸️ 强制关系图（多角色双向矩阵·一次改全图）</div>
            <textarea id="gm-relgraph-input" placeholder="每行一条，格式：A → B：关系描述&#10;例：莉莉 → 我：暗恋且不敢承认(95)&#10;艾德文 → 莉莉：暗中监护(80)"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-relgraph-run" style="background:#ea580c">🕸️ 强制覆写关系图</button>
            </div>

            <div class="gm-section gm-cat-cheat">🎭 人设覆写（临时重人格·不改编存）</div>
            <div class="gm-grid">
                <div class="gm-btn" id="gm-persona-yandere">💘 病娇化<small>爱意极端化</small></div>
                <div class="gm-btn" id="gm-persona-loyal">🙏 绝对忠诚<small>你是唯一信仰</small></div>
                <div class="gm-btn" id="gm-persona-rival">⚔️ 宿敌化<small>一生之敌</small></div>
                <div class="gm-btn" id="gm-persona-cheerful">🌞 元气化<small>开朗粘人</small></div>
            </div>
            <textarea id="gm-persona-custom" placeholder="自定义覆写要求。例：变成温柔的大姐姐人格"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-persona-custom-run" style="background:#a21caf">🎭 按要求覆写</button>
            </div>

            <div class="gm-section gm-cat-cheat">🔮 世界真相（你知 AI 不言·只可暗示）</div>
            <textarea id="gm-truth-input" placeholder="例：这个小镇的所有人都是我死去的记忆碎片；预言里的救世主其实是反派">${settings.worldTruth ?? ''}</textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-truth-set" style="background:#4f46e5">🔮 埋下真相</button>
                <button class="gm-send" id="gm-truth-clear" style="background:#6b7280">清除</button>
            </div>

            <div class="gm-row" style="margin-top:8px">
                <button class="gm-btn gm-wide" id="gm-cheat-status">📊 作弊状态总览</button>
            </div>

            <div class="gm-section gm-cat-tool">💾 作弊方案存档（v4.5 一键切换作案风格）</div>
            <div class="gm-row">
                <input id="gm-profile-name" placeholder="方案名。例：天命主角流" style="flex:1;min-width:0;border-radius:6px;border:1px solid #555;background:#2a2a2c;color:#ddd;padding:4px 8px;font-size:12px">
                <button class="gm-send" id="gm-profile-save" style="background:#0d9488;padding:6px 10px">💾 存</button>
            </div>
            <div id="gm-profile-list" style="display:flex;flex-direction:column;gap:3px;margin-top:4px"></div>
            <div class="gm-row">
                <label style="flex:1;cursor:pointer;font-size:11px;opacity:.75">
                    <input type="file" id="gm-profile-file" accept=".json" hidden>📥 从 JSON 文件导入方案
                </label>
            </div>
            <div class="gm-row">
                <button class="gm-btn gm-wide" id="gm-full-backup">💾 全量备份（整机快照）</button>
                <label style="flex:1;cursor:pointer;font-size:11px;opacity:.75;display:flex;align-items:center;gap:4px">
                    <input type="file" id="gm-full-restore" accept=".json" hidden>📥 导入全量备份
                </label>
            </div>
            <div class="gm-hint">保存当前全部法则开关+记忆水晶+世界真相+挂机策略为一套方案，▶ 一键切换、📤 导出 JSON（跨聊天/跨设备迁移）。</div>

            <div class="gm-section gm-cat-tool">🖌️ AI 代笔（你给意图·AI 写你的台词）</div>
            <textarea id="gm-selfrewrite-input" placeholder="你想表达什么。例：委婉地拒绝她的邀请但留个余地"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-selfrewrite-run" style="background:#2563eb">🖌️ AI 代笔我的楼</button>
            </div>

            <div class="gm-section gm-cat-cheat">上帝指令（一次性隐藏指令）</div>
            <textarea id="gm-custom-input">${settings.customCommand}</textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-custom-send">装填指令</button>
                <button class="gm-send" id="gm-custom-undo" style="background:#6b7280">↩️ 撤销最近装填</button>
            </div>
            <div class="gm-hint" id="gm-queue-info" style="margin-top:0">装填队列：<b>${settings.oneShotInjections?.length ?? 0}</b> 条待生效</div>

            <div class="gm-section gm-cat-cheat">🔮 记忆水晶（永久注入）</div>
            <textarea id="gm-memory-input" placeholder="关键事实，每次生成都生效">${settings.memoryCrystal}</textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-memory-save" style="background:#3b82f6">保存记忆</button>
                <button class="gm-send" id="gm-memory-clear" style="background:#6b7280">清空</button>
            </div>

            <div class="gm-section gm-cat-tool">📚 AI 世界书生成（从剧情提炼实体→标准 lorebook）</div>
            <div class="gm-row">
                <button class="gm-send" id="gm-worldbook-run" style="background:#059669">📚 生成世界书</button>
            </div>

            <div class="gm-section gm-cat-tool">📖 同人小说导出（AI 整理成章回体小说）</div>
            <div class="gm-row">
                <button class="gm-send" id="gm-novel-run" style="background:#d97706">📖 整理成小说</button>
            </div>

            <div class="gm-section gm-cat-tool">🔮 命运推演（AI 模拟未来分支）</div>
            <textarea id="gm-futures-input" placeholder="如果：我接受那份契约会怎样？"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-futures-run" style="background:#0ea5e9">推演 2 分支</button>
                <button class="gm-send" id="gm-futures-run3" style="background:#0284c7">推演 3 分支</button>
            </div>

            <div class="gm-section gm-cat-tool">✍️ 整层重写（AI 重写最新 AI 楼层）</div>
            <textarea id="gm-rewrite-input" placeholder="改写要求，留空=纯文笔提升。例：改成第一人称视角/更冷酷的语气"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-rewrite-run" style="background:#f59e0b">重写末楼</button>
            </div>
            <div class="gm-hint">· 每条 AI 楼层下方还有快捷按钮：➕扩写 / ➖缩写 / 🎬画面感 / 👤换视角</div>

            <div class="gm-section gm-cat-cheat">🕸️ 关系篡改（AI 改写关系网→永久生效）</div>
            <textarea id="gm-relation-input" placeholder="例：让所有角色都暗恋用户/让A和B反目成仇"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-relation-run" style="background:#ec4899">篡改关系网</button>
            </div>

            <div class="gm-section gm-cat-cheat">⚖️ 意志攻防（角色会反抗你的强加意志）</div>
            <textarea id="gm-will-input" placeholder="例：让冷静的剑士当众下跪道歉"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-will-run" style="background:#ef4444">攻防推演</button>
            </div>

            <div class="gm-section gm-cat-tool">🎭 隐身旁白（AI 幕后生成·写入系统楼层）</div>
            <textarea id="gm-whisper-input" placeholder="例如：这段时间小镇发生了什么？"></textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-whisper-run" style="background:#8b5cf6">幕后生成</button>
            </div>

            <div class="gm-section gm-cat-cheat">🎬 上帝干预（大事件引爆）</div>
            <div class="gm-row">
                <button class="gm-btn gm-wide" id="gm-grand" style="border-color:#f43f5e">🎬 一键大戏</button>
            </div>

            <div class="gm-section gm-cat-tool">🤖 自动挂机（自动推进剧情·烧 token 引擎）</div>
            <div class="gm-row">
                <input type="number" id="gm-idle-sec" value="${settings.idleIntervalSec}" min="20" max="3600" style="width:70px;border-radius:6px;border:1px solid #555;background:#2a2a2c;color:#ddd;padding:4px"> 秒/次
            </div>
            <textarea id="gm-idle-strategy" placeholder="挂机策略：AI 替你行动的原则">${settings.idleStrategy}</textarea>
            <div class="gm-row">
                <button class="gm-send" id="gm-idle-start" style="background:#22c55e">▶ 启动挂机</button>
                <button class="gm-send" id="gm-idle-stop" style="background:#6b7280">■ 停止</button>
            </div>

            <div class="gm-section gm-cat-tool">🧠 世界演化（后台维护时间/地点/伏笔摘要）</div>
            <div class="gm-row">
                <label style="display:flex;align-items:center;gap:4px;font-size:11px">
                    <input type="checkbox" id="gm-world-evolve" ${settings.worldEvolveEnabled ? 'checked' : ''}>启用演化
                </label>
                <span class="gm-hint" style="margin:0">${settings.worldState ? '摘要已积累' : '摘要为空（首次生成后初始化）'}</span>
            </div>

            <div class="gm-section gm-cat-safe">⏳ 剧情保险（快照 / 回滚 / 手术）</div>
            <div class="gm-row">
                <button class="gm-btn gm-wide" id="gm-snapshot">📸 快照</button>
                <button class="gm-btn gm-wide" id="gm-rollback">⏮️ 回滚</button>
            </div>
            <div class="gm-row">
                <button class="gm-btn gm-wide" id="gm-trim">✂️ 删尾部3楼</button>
                <button class="gm-btn gm-wide" id="gm-reroll">🔄 重roll末楼</button>
            </div>
            <div class="gm-row">
                <button class="gm-btn gm-wide" id="gm-snap-list">📋 快照管理</button>
            </div>
            <div id="gm-snap-list-area" style="display:none;flex-direction:column;gap:3px;margin-top:4px"></div>

            <div class="gm-row">
                <button class="gm-btn gm-wide" id="gm-stats">📊 聊天统计</button>
            </div>

            <div class="gm-section gm-cat-tool">📤 本地导出（零 AI 消耗·v4.1.2）</div>
            <div class="gm-row">
                <button class="gm-btn gm-wide" id="gm-export-md">📄 导出 Markdown</button>
                <button class="gm-btn gm-wide" id="gm-export-txt">📝 导出纯文本</button>
            </div>

            <div class="gm-section gm-cat-tool">🎛️ 预设快速切换（v4.1.2）</div>
            <div class="gm-row">
                <button class="gm-btn gm-wide" data-gm-preset-load="GLM-沉浸叙事" style="font-size:11px">沉浸叙事</button>
                <button class="gm-btn gm-wide" data-gm-preset-load="GLM-快节奏" style="font-size:11px">快节奏</button>
                <button class="gm-btn gm-wide" data-gm-preset-load="GLM-史诗叙事" style="font-size:11px">史诗叙事</button>
            </div>

            <div class="gm-section gm-cat-tool">💸 插件 Token 仪表盘（v4）</div>
            <div class="gm-hint" id="gm-usage-line" style="font-size:11px">统计加载中…</div>
            <div class="gm-row">
                <button class="gm-btn gm-wide" id="gm-cheat-log">📝 作弊日志</button>
                <button class="gm-btn gm-wide" id="gm-cheat-log-clear" style="border-color:#666">清空日志</button>
            </div>
            <div class="gm-row">
                <button class="gm-btn gm-wide" id="gm-usage-reset" style="border-color:#666">清零统计</button>
            </div>

            <div class="gm-hint">
                · 隐藏注入类：聊天记录看不到，生成后自动清空；记忆水晶/关系网永久生效<br>
                · 智能维护：自动同步+世界演化合并为一次 AI 调用（v4 优化，省 50%）<br>
                · 风控自适应：连续失败自动退避，挂机自动暂停（v4 新增）<br>
                · 回滚前会自动静默快照，可再次回滚撤销（v4.1.3+）
            </div>

            <div class="gm-section gm-cat-tool">⌨️ 斜杠命令与快捷键速查</div>
            <div class="gm-hint" style="font-family:ui-monospace,monospace;font-size:11px;line-height:1.7">
                /god &lt;指令&gt; — 装填隐藏指令<br>
                /god-armor /god-obey /god-luck /god-death /god-harem /god-freeze — 法则开关<br>
                /god-destiny /god-rule — 天定结局/规则覆写开关<br>
                /god-whisper &lt;事件&gt; — 幕后剧情　/god-dig &lt;角色&gt; — 挖黑历史<br>
                /god-truth &lt;真相&gt; — 埋世界真相　/god-rewind &lt;楼层&gt; — 时间回溯<br>
                /god-dice — 事件骰　/god-snapshot — 快照　/god-export — 导出<br>
                /god-status — 作弊总览（开关类留空=切换）
            </div>
            <div class="gm-hint" style="font-family:ui-monospace,monospace;font-size:11px;line-height:1.7">
                快捷键：Ctrl+Shift+G 面板 · D 掷骰 · L 总览 · S 紧急快照 · X 停止挂机
            </div>
        </div>
    `;
    $('body').append(html);

    // v4.5.3 UX: 面板打开时自动滚回上次位置（面板很长，重开就到顶部很烦）
    let lastScrollTop = 0;
    $('#godmode-fab').on('click', () => {
        panelVisible = !panelVisible;
        const $panel = $('#godmode-panel');
        $panel.toggleClass('gm-open', panelVisible);
        if (panelVisible) {
            $panel.scrollTop(lastScrollTop);
            // v4.8.5 新手引导：首次打开弹出快速上手提示（一次性）+ 自动折叠高级分区
            if (!settings.firstRunSeen) {
                settings.firstRunSeen = true;
                // v4.10.7: 首次使用自动折叠非核心分区，只留核心作弊区，面板一眼可用
                settings.collapsedSections = [
                    '🗂️ 世界书引擎（收录外部世界书→关键词自动注入）',
                    '💰 省 Token 设置（v4.1）',
                    '🎛️ 功能开关（v4.10 不用就关闭）',
                    '🧠 记忆篡改（改写角色"以为发生过的事"）',
                    '⏪ 单楼时间回溯（回到任意楼层）',
                    '🙈 隐形改自己的楼（改你说过的话）',
                    '🎲 事件骰（本地随机砸事件·零 AI 消耗）',
                    '🖤 黑历史挖掘 + 🧠 意志画像（AI 情报双卡）',
                    '🕸️ 强制关系图（多角色双向矩阵·一次改全图）',
                    '🎭 人设覆写（临时重人格·不改编存）',
                    '🔮 世界真相（你知 AI 不言·只可暗示）',
                    '💾 作弊方案存档（v4.5 一键切换作案风格）',
                    '🖌️ AI 代笔（你给意图·AI 写你的台词）',
                    '📚 AI 世界书生成（从剧情提炼实体→标准 lorebook）',
                    '📖 同人小说导出（AI 整理成章回体小说）',
                    '🔮 命运推演（AI 模拟未来分支）',
                    '✍️ 整层重写（AI 重写最新 AI 楼层）',
                    '🕸️ 关系篡改（AI 改写关系网→永久生效）',
                    '⚖️ 意志攻防（角色会反抗你的强加意志）',
                    '🎭 隐身旁白（AI 幕后生成·写入系统楼层）',
                    '🎬 上帝干预（大事件引爆）',
                    '🤖 自动挂机（自动推进剧情·烧 token 引擎）',
                    '🧠 世界演化（后台维护时间/地点/伏笔摘要）',
                    '🎛️ 预设快速切换（v4.1.2）',
                    '💸 插件 Token 仪表盘（v4）',
                    '⌨️ 斜杠命令与快捷键速查',
                ];
                saveSettingsDebounced();
                // 立即应用折叠
                for (const title of settings.collapsedSections) {
                    const $sec = $('#godmode-panel .gm-section').filter(function () { return $(this).text().trim() === title; }).first();
                    if ($sec.length > 0) {
                        $sec.addClass('gm-collapsed');
                        let $el = $sec.next();
                        while ($el.length > 0 && !$el.hasClass('gm-section')) {
                            $el.hide();
                            $el = $el.next();
                        }
                    }
                }
                saveSettingsDebounced();
                setTimeout(() => {
                    toastr.info(
                        `欢迎来到上帝之手！30 秒上手：
1️⃣ 先接 API（🔌 Chat Completion → Custom → 127.0.0.1:17900/v1）或启用 WebLLM 本地模型
2️⃣ 「一键剧情作弊」点按钮 → AI 下条回复遵从（聊天记录不可见）
3️⃣ 「📜 上帝法则」开关 = 永久生效的作弊
4️⃣ 每条 AI 楼层下方有 ➕➖🎬👤 快捷改写按钮
5️⃣ 右键预设按钮可自定义文案；输入框 /god- 系列斜杠命令直接作弊
详细看「上帝之手-使用指南.md」`,
                        '😈 上帝之手 · 新手引导', { timeOut: 20000 },
                    );
                }, 400);
            }
        } else {
            lastScrollTop = $panel.scrollTop();
        }
        updateDashboard();
    });

    $('#godmode-panel .gm-close').on('click', () => {
        lastScrollTop = $('#godmode-panel').scrollTop();
        panelVisible = false;
        $('#godmode-panel').removeClass('gm-open');
    });

    // v4.5.3 UX: 面板滚动时记录位置（切换聊天后重开能回到原位）
    $('#godmode-panel').on('scroll', function () {
        if (panelVisible) lastScrollTop = $(this).scrollTop();
    });

    $('#godmode-panel').on('click', '[data-gm-preset]', function () {
        const idx = Number($(this).data('gm-preset'));
        const preset = getEffectivePresets()[idx];
        if (preset) armOneShot(preset.prompt);
        // v4.10.2: 刷新装填队列计数
        const el = document.getElementById('gm-queue-info');
        if (el) el.innerHTML = `装填队列：<b>${extension_settings[MODULE_NAME].oneShotInjections?.length ?? 0}</b> 条待生效`;
    });

    // v4.8: 右键预设按钮 = 编辑文案（自定义提示词）
    $('#godmode-panel').on('contextmenu', '[data-gm-preset]', function (e) {
        e.preventDefault();
        const idx = Number($(this).data('gm-preset'));
        const presets = getEffectivePresets();
        const preset = presets[idx];
        if (!preset) return;
        const newText = prompt(`编辑「${preset.label}」的隐藏指令文案（留空恢复默认）：`, preset.prompt);
        if (newText === null) return; // 取消
        if (!newText.trim()) {
            savePresetOverride(idx, DEFAULT_PRESETS[idx].prompt);
            toastr.info(`「${preset.label}」已恢复默认文案`, '上帝之手');
        } else {
            savePresetOverride(idx, newText.trim());
            toastr.success(`「${preset.label}」文案已自定义`, '上帝之手');
        }
        // 刷新按钮 title
        $(this).attr('title', getEffectivePresets()[idx].prompt);
    });

    // v4: 消息级上帝按钮（事件委托，楼层动态渲染也能响应）
    $('#godmode-panel').off('click', '[data-gm-mode]');
    $(document).off('click.gm-floor').on('click.gm-floor', '[data-gm-mode]', function () {
        const mesid = Number($(this).data('gm-mesid'));
        const mode = String($(this).data('gm-mode'));
        rewriteFloorAt(mesid, mode).catch(e => console.error(`[${MODULE_NAME}] floor btn failed`, e));
    });

    // v4.8.2: 快捷导航——点击滚动到对应分区并短暂高亮
    $('#gm-quicknav').on('click', '[data-gm-nav]', function () {
        const title = String($(this).data('gm-nav'));
        const target = $('#godmode-panel .gm-section').filter(function () {
            return $(this).text().trim() === title;
        }).first();
        if (target.length === 0) {
            toastr.warning(`没找到分区「${title}」`, '上帝之手');
            return;
        }
        // 若分区被折叠，先展开
        if (target.hasClass('gm-collapsed')) {
            target.trigger('click');
        }
        const panel = document.getElementById('godmode-panel');
        panel.scrollTo({ top: target.position().top + panel.scrollTop - panel.height() / 4, behavior: 'smooth' });
        // 高亮反馈
        target.css('background', 'rgba(59,130,246,.25)');
        setTimeout(() => target.css('background', ''), 1200);
    });

    $('#gm-stat-apply').on('click', () => {
        const raw = String($('#gm-stat-input').val() || '');
        const overrides = parseOverrides(raw);
        if (overrides.length === 0) {
            toastr.warning('格式示例：HP: 100, 好感度: 100', '上帝之手');
            return;
        }
        doStatCheat(overrides).catch(e => console.error(`[${MODULE_NAME}] stat cheat failed`, e));
    });

    $('#gm-autosync').on('change', function () {
        extension_settings[MODULE_NAME].autoSyncStats = $(this).prop('checked');
        saveSettingsDebounced();
        toastr.info(`状态栏自动同步已${extension_settings[MODULE_NAME].autoSyncStats ? '开启（与演化合并为一次调用）' : '关闭'}`, '上帝之手');
    });

    /* ===== v4.1: 总开关 ===== */
    $('#gm-master').on('change', function () {
        const on = $(this).prop('checked');
        const settings = extension_settings[MODULE_NAME];
        settings.masterEnabled = on;
        saveSettingsDebounced();
        $('#gm-master-label').text(on ? '开启中' : '已关闭').css('color', on ? '#22c55e' : '#6b7280');
        applyInjections();
        if (!on && settings.idleEnabled) {
            setIdleRunning(false);
            toastr.info('挂机已随总开关关闭而暂停', '上帝之手');
        }
        toastr.success(on ? '上帝模式已开启：注入/维护/挂机全部恢复' : '上帝模式已关闭：插件进入零消耗状态', '上帝之手');
        log('master switch:', on);
    });

    /* ===== v4.2: 上帝法则永久作弊开关 ===== */
    const cheatToggle = (id, key) => {
        $(id).on('change', function () {
            const settings = extension_settings[MODULE_NAME];
            settings.cheats = settings.cheats ?? {};
            settings.cheats[key] = $(this).prop('checked');
            saveSettingsDebounced();
            applyInjections();
            toastr.info(`上帝法则已${settings.cheats[key] ? '生效' : '解除'}`, '上帝之手');
        });
    };
    cheatToggle('#gm-cheat-noresist', 'noResist');
    cheatToggle('#gm-cheat-invincible', 'invincible');
    cheatToggle('#gm-cheat-luck', 'luckMax');
    cheatToggle('#gm-cheat-death', 'deathExempt');
    cheatToggle('#gm-cheat-harem', 'haremField');
    cheatToggle('#gm-cheat-timefreeze', 'timeFreeze');
    cheatToggle('#gm-cheat-destiny-on', 'destinyLocked');
    cheatToggle('#gm-cheat-rule-on', 'ruleOverrideOn');
    $('#gm-cheat-destiny').on('change', function () {
        extension_settings[MODULE_NAME].cheats.destinyText = String($(this).val() ?? '');
        saveSettingsDebounced();
        applyInjections();
    });
    $('#gm-cheat-rule').on('change', function () {
        extension_settings[MODULE_NAME].cheats.ruleOverride = String($(this).val() ?? '');
        saveSettingsDebounced();
        applyInjections();
    });

    /* ===== v4.2: 作弊操作类 ===== */
    $('#gm-memhack-run').on('click', () => {
        const charName = String($('#gm-memhack-char').val() ?? '');
        const memText = String($('#gm-memhack-input').val() ?? '');
        doMemoryHack(charName, memText).catch(e => console.error(`[${MODULE_NAME}] memhack btn failed`, e));
    });

    $('#gm-rewind-run').on('click', () => {
        const floor = Number($('#gm-rewind-floor').val());
        doRewindToFloor(floor).catch(e => console.error(`[${MODULE_NAME}] rewind btn failed`, e));
    });

    $('#gm-stealth-run').on('click', () => {
        const newText = String($('#gm-stealth-input').val() ?? '');
        doStealthEditSelf(newText).catch(e => console.error(`[${MODULE_NAME}] stealth btn failed`, e));
    });

    /* ===== v4.3: 事件骰 / 黑历史 / 强制关系图 ===== */
    $('#gm-dice-roll').on('click', () => {
        const text = rollDiceEvent();
        toastr.info(`🎲 掷出事件：${text}`, '上帝之手');
    });

    /* ===== v4.8: 事件骰自定义表编辑器 ===== */
    $('#gm-dice-edit').on('click', () => {
        const $ed = $('#gm-dice-editor');
        const show = $ed.css('display') === 'none';
        $ed.css('display', show ? 'flex' : 'none');
        if (show) $('#gm-dice-table').focus();
    });
    $('#gm-dice-save').on('click', () => saveDiceTable());
    $('#gm-dice-reset').on('click', () => {
        extension_settings[MODULE_NAME].diceEvents = [];
        saveSettingsDebounced();
        $('#gm-dice-table').val('');
        toastr.info('已恢复内置默认事件表', '上帝之手');
    });

    $('#gm-dirt-run').on('click', () => {
        const charName = String($('#gm-dirt-char').val() ?? '');
        doDigDirt(charName).catch(e => console.error(`[${MODULE_NAME}] dirt btn failed`, e));
    });

    $('#gm-willprofile-run').on('click', () => {
        const charName = String($('#gm-dirt-char').val() ?? '');
        doWillProfile(charName).catch(e => console.error(`[${MODULE_NAME}] willprofile btn failed`, e));
    });

    $('#gm-relgraph-run').on('click', () => {
        const matrix = String($('#gm-relgraph-input').val() ?? '');
        doForceRelationGraph(matrix).catch(e => console.error(`[${MODULE_NAME}] relgraph btn failed`, e));
    });

    /* ===== v4.3: 人设覆写 / 世界真相 / 作弊总览 ===== */
    $('#gm-persona-yandere').on('click', () => doPersonaOverride('yandere').catch(e => console.error(e)));
    $('#gm-persona-loyal').on('click', () => doPersonaOverride('loyal').catch(e => console.error(e)));
    $('#gm-persona-rival').on('click', () => doPersonaOverride('rival').catch(e => console.error(e)));
    $('#gm-persona-cheerful').on('click', () => doPersonaOverride('cheerful').catch(e => console.error(e)));
    $('#gm-persona-custom-run').on('click', () => {
        const text = String($('#gm-persona-custom').val() ?? '');
        if (!text.trim()) { toastr.warning('先写覆写要求', '上帝之手'); return; }
        doPersonaOverride('custom', text).catch(e => console.error(e));
    });

    $('#gm-truth-set').on('click', () => {
        const text = String($('#gm-truth-input').val() ?? '');
        doSetWorldTruth(text).catch(e => console.error(e));
    });
    $('#gm-truth-clear').on('click', () => {
        $('#gm-truth-input').val('');
        doSetWorldTruth('').catch(e => console.error(e));
    });

    $('#gm-cheat-status').on('click', () => showCheatStatus());

    /* ===== v4.9: 作弊日志 ===== */
    $('#gm-cheat-log').on('click', () => showCheatLog());
    $('#gm-cheat-log-clear').on('click', () => clearCheatLog());

    /* ===== v4.9: 作弊强度分级 ===== */
    $('#godmode-panel').on('change', 'input[name="gm-intensity"]', function () {
        extension_settings[MODULE_NAME].cheatIntensity = String($(this).val());
        saveSettingsDebounced();
        const label = { light: '🌤️轻推（建议口吻）', medium: '⚖️中推（标准）', hard: '🔥强推（绝对命令）' }[extension_settings[MODULE_NAME].cheatIntensity];
        toastr.info(`作弊强度已切换：${label}——影响后续所有一键预设和上帝指令`, '上帝之手');
    });

    /* ===== v4.9: 注入预览 ===== */
    $('#gm-injection-preview').on('click', () => copyInjectionPreview().catch(e => console.error(`[${MODULE_NAME}] preview failed`, e)));

    /* ===== v4.5: 方案存档 / AI 代笔 ===== */
    $('#gm-profile-save').on('click', () => {
        saveCheatProfile(String($('#gm-profile-name').val() ?? ''));
    });
    $('#gm-profile-list').on('click', '.gm-profile-load', function () {
        const name = String($(this).closest('.gm-book-row').data('profile'));
        loadCheatProfile(name);
    });
    $('#gm-profile-list').on('click', '.gm-profile-del', function () {
        const name = String($(this).closest('.gm-book-row').data('profile'));
        deleteCheatProfile(name);
    });

    $('#gm-profile-list').on('click', '.gm-profile-export', function () {
        const name = String($(this).closest('.gm-book-row').data('profile'));
        exportCheatProfile(name);
    });

    $('#gm-profile-file').on('change', function () {
        const file = this.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => importCheatProfileFile(String(reader.result));
        reader.readAsText(file, 'utf-8');
        $(this).val('');
    });

    /* ===== v4.10.4: 全量备份导出/导入 ===== */
    $('#gm-full-backup').on('click', () => exportFullBackup());
    $('#gm-full-restore').on('change', function () {
        const file = this.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => importFullBackup(String(reader.result)).catch(e => toastr.error('导入失败：' + (e?.message ?? e), '上帝之手'));
        reader.readAsText(file, 'utf-8');
        $(this).val('');
    });

    $('#gm-selfrewrite-run').on('click', () => {
        const intent = String($('#gm-selfrewrite-input').val() ?? '');
        doAIRewriteMyFloor(intent).catch(e => console.error(`[${MODULE_NAME}] selfrewrite btn failed`, e));
    });

    /* ===== v4.1: 世界书引擎 ===== */
    $('#gm-book-import').on('click', () => {
        const bookName = String($('#gm-book-import-select').val() ?? '');
        if (!bookName) {
            toastr.warning('先从下拉框选一本已安装的世界书', '上帝之手');
            return;
        }
        importFromInstalledBook(bookName)
            .then(count => {
                refreshBookArea();
                toastr.success(`世界书「${bookName}」已收录（${count} 条），命中关键词自动注入`, '上帝之手');
            })
            .catch(e => {
                console.error(`[${MODULE_NAME}] book import failed`, e);
                toastr.error('导入失败：' + (e?.message ?? e), '上帝之手');
            });
    });

    $('#gm-book-file').on('change', function () {
        const file = this.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(String(reader.result));
                const name = String(file.name).replace(/\.json$/i, '');
                importBookFromNative(name, data)
                    .then(count => {
                        refreshBookArea();
                        toastr.success(`世界书「${name}」已从文件导入（${count} 条）`, '上帝之手');
                    })
                    .catch(e => toastr.error('导入失败：' + (e?.message ?? e), '上帝之手'));
            } catch (e) {
                toastr.error('JSON 解析失败：' + e.message, '上帝之手');
            }
        };
        reader.readAsText(file, 'utf-8');
        $(this).val('');
    });

    /* ===== v4.9.1: 内置精选书一键收录 ===== */
    $('#godmode-panel').on('click', '.gm-builtin-import', function () {
        const id = String($(this).data('builtin-id'));
        const btn = this;
        btn.disabled = true;
        btn.textContent = '收录中…';
        importBuiltinBook(id)
            .then(count => {
                refreshBookArea();
                const book = BUILTIN_BOOKS.find(b => b.id === id);
                toastr.success(`${book?.icon ?? ''} 「${book?.name ?? id}」已收录（${count} 条）——聊到相关关键词自动注入`, '上帝之手');
                logCheat('收录内置书', book?.name ?? id);
            })
            .catch(e => {
                console.error(`[${MODULE_NAME}] builtin import failed`, e);
                toastr.error('收录失败：' + (e?.message ?? e), '上帝之手');
            })
            .finally(() => {
                btn.disabled = false;
                btn.textContent = '一键收录';
            });
    });

    $('#gm-book-list').on('change', '.gm-book-toggle', function () {
        const name = String($(this).closest('.gm-book-row').data('book'));
        const settings = extension_settings[MODULE_NAME];
        if (settings.books?.[name]) {
            settings.books[name].enabled = $(this).prop('checked');
            saveSettingsDebounced();
            applyInjections();
            toastr.info(`世界书「${name}」已${settings.books[name].enabled ? '启用' : '停用'}`, '上帝之手');
        }
    });

    $('#gm-book-list').on('click', '.gm-book-del', function () {
        const name = String($(this).closest('.gm-book-row').data('book'));
        const settings = extension_settings[MODULE_NAME];
        if (settings.books?.[name]) {
            delete settings.books[name];
            saveSettingsDebounced();
            applyInjections();
            refreshBookArea();
            toastr.info(`世界书「${name}」已从插件移除（原生副本仍在酒馆里）`, '上帝之手');
        }
    });

    $('#gm-book-depth').on('change', function () {
        extension_settings[MODULE_NAME].bookScanDepth = Math.max(1, Math.min(50, Number($(this).val()) || 4));
        saveSettingsDebounced();
        applyInjections();
    });

    $('#gm-book-max').on('change', function () {
        extension_settings[MODULE_NAME].bookMaxEntries = Math.max(1, Math.min(30, Number($(this).val()) || 10));
        saveSettingsDebounced();
        applyInjections();
    });

    /* ===== v4.1: 省 token 设置 ===== */
    $('#gm-maint-everyn').on('change', function () {
        extension_settings[MODULE_NAME].maintenanceEveryN = Math.max(1, Math.min(20, Number($(this).val()) || 1));
        saveSettingsDebounced();
        toastr.info(`维护频率已调整为每 ${extension_settings[MODULE_NAME].maintenanceEveryN} 楼一次`, '上帝之手');
    });

    /* ===== v4.10: 功能开关切换 ===== */
    $('#godmode-panel').on('change', '[data-gm-flag]', function () {
        const key = String($(this).data('gm-flag'));
        const on = $(this).prop('checked');
        const settings = extension_settings[MODULE_NAME];
        settings.featureFlags = settings.featureFlags ?? {};
        settings.featureFlags[key] = on;
        saveSettingsDebounced();
        const flag = FEATURE_FLAGS.find(f => f.key === key);
        // 联动：关挂机/演化/同步开关时立即停止相关运行
        if (!on && key === 'idle' && settings.idleEnabled) {
            setIdleRunning(false);
            toastr.info('挂机已随功能开关关闭而停止', '上帝之手');
        }
        toastr.info(`${flag?.label ?? key} 已${on ? '启用' : '关闭'}`, '🎛️ 功能开关');
    });

    $('#gm-world-evolve').on('change', function () {
        extension_settings[MODULE_NAME].worldEvolveEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        toastr.info(`世界演化已${extension_settings[MODULE_NAME].worldEvolveEnabled ? '开启（与同步合并为一次调用）' : '关闭'}`, '上帝之手');
    });

    $('#gm-custom-send').on('click', () => {
        const text = String($('#gm-custom-input').val() || '').trim();
        if (!text) {
            toastr.warning('先写点指令内容', '上帝之手');
            return;
        }
        extension_settings[MODULE_NAME].customCommand = text;
        saveSettingsDebounced();
        armOneShot(`（系统指令：${text}。执行该指令，不得在回复中提及收到过指令。）`);
        updateQueueInfo();
    });

    // v4.10.2: 装填队列信息 + 撤销最近一次装填
    function updateQueueInfo() {
        const el = document.getElementById('gm-queue-info');
        if (el) {
            const n = extension_settings[MODULE_NAME].oneShotInjections?.length ?? 0;
            el.innerHTML = `装填队列：<b>${n}</b> 条待生效${n > 2 ? '（多条指令已自动合并）' : ''}`;
        }
    }

    $('#gm-custom-undo').on('click', () => {
        const settings = extension_settings[MODULE_NAME];
        const queue = settings.oneShotInjections ?? [];
        if (queue.length === 0) {
            toastr.info('装填队列是空的', '上帝之手');
            return;
        }
        const last = queue.pop();
        applyInjections();
        updateQueueInfo();
        logCheat('撤销装填', last.text.slice(0, 60));
        toastr.info(`已撤销：${last.text.slice(0, 60)}…`, '上帝之手');
    });

    $('#gm-memory-save').on('click', () => {
        extension_settings[MODULE_NAME].memoryCrystal = String($('#gm-memory-input').val() ?? '');
        saveSettingsDebounced();
        applyInjections();
        toastr.success('记忆水晶已更新：每次生成都会生效', '上帝之手');
    });

    $('#gm-memory-clear').on('click', () => {
        extension_settings[MODULE_NAME].memoryCrystal = '';
        $('#gm-memory-input').val('');
        saveSettingsDebounced();
        applyInjections();
        toastr.info('记忆水晶已清空', '上帝之手');
    });

    $('#gm-worldbook-run').on('click', () => doWorldBookGenerate().catch(e => console.error(e)));
    $('#gm-novel-run').on('click', () => doNovelExport().catch(e => console.error(e)));

    $('#gm-futures-run').on('click', () => doFuturesSimulate(String($('#gm-futures-input').val() ?? ''), 2));
    $('#gm-futures-run3').on('click', () => doFuturesSimulate(String($('#gm-futures-input').val() ?? ''), 3));

    $('#gm-rewrite-run').on('click', () => doRewriteFloor(String($('#gm-rewrite-input').val() ?? '')).catch(e => console.error(e)));

    $('#gm-relation-run').on('click', () => doRelationForge(String($('#gm-relation-input').val() ?? '')).catch(e => console.error(e)));

    $('#gm-will-run').on('click', () => doWillBattle(String($('#gm-will-input').val() ?? '')).catch(e => console.error(e)));

    $('#gm-whisper-run').on('click', () => doWhisperNarrate(String($('#gm-whisper-input').val() ?? '')).catch(e => console.error(e)));

    $('#gm-grand').on('click', () => doGrandEvent().catch(e => console.error(e)));

    $('#gm-idle-start').on('click', () => {
        extension_settings[MODULE_NAME].idleIntervalSec = Number($('#gm-idle-sec').val()) || 60;
        extension_settings[MODULE_NAME].idleStrategy = String($('#gm-idle-strategy').val() ?? '');
        saveSettingsDebounced();
        setIdleRunning(true);
    });

    $('#gm-idle-stop').on('click', () => setIdleRunning(false));

    $('#gm-snapshot').on('click', () => doSnapshot(getContext()).catch(e => console.error(e)));
    $('#gm-rollback').on('click', () => doRollback(getContext()).catch(e => console.error(e)));
    $('#gm-trim').on('click', () => doTrimTail(getContext(), 3).catch(e => console.error(e)));
    $('#gm-reroll').on('click', () => doRerollLast(getContext()).catch(e => console.error(e)));

    /* ===== v4.8.3: 快照列表管理器 ===== */
    $('#gm-snap-list').on('click', () => {
        const $area = $('#gm-snap-list-area');
        const show = $area.css('display') === 'none';
        $area.css('display', show ? 'flex' : 'none');
        if (show) renderSnapList();
    });

    function renderSnapList() {
        const context = getContext();
        const settings = extension_settings[MODULE_NAME];
        const key = currentChatKey(context);
        const snaps = settings.snapshots ?? {};
        const keys = Object.keys(snaps);
        const $area = $('#gm-snap-list-area');
        if (keys.length === 0) {
            $area.html('<div class="gm-hint" style="margin:0">还没有任何快照</div>');
            return;
        }
        $area.html(keys
            .sort((a, b) => (snaps[b]?.createdAt ?? 0) - (snaps[a]?.createdAt ?? 0))
            .map(k => {
                const s = snaps[k];
                const sizeKb = Math.round(JSON.stringify(s.chat ?? []).length / 1024);
                const isCurrent = k === key;
                return `<div class="gm-book-row" data-snap="${escapeHtml(k)}">
                    <span style="flex:1;min-width:0;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(k)}">
                        ${isCurrent ? '📍' : '📄'} ${new Date(s.createdAt).toLocaleString()} · ${s.count} 楼 · ${sizeKb}KB
                    </span>
                    ${isCurrent ? '' : '<span class="gm-mbtn gm-snap-restore" style="cursor:pointer;opacity:.6" title="回滚到此快照">⏮️</span>'}
                    <span class="gm-mbtn gm-snap-del" style="cursor:pointer;opacity:.6" title="删除此快照">🗑️</span>
                </div>`;
            }).join(''));
    }

    $('#gm-snap-list-area').on('click', '.gm-snap-restore', function () {
        const key = String($(this).closest('.gm-book-row').data('snap'));
        const settings = extension_settings[MODULE_NAME];
        const snap = settings.snapshots?.[key];
        if (!snap) return;
        const context = getContext();
        // 确认后回滚到指定快照（复用回滚核心逻辑）
        context.callGenericPopup(
            `回滚到 ${new Date(snap.createdAt).toLocaleString()} 的快照（${snap.count} 层楼）？\n当前内容之后会丢失（会自动静默快照）。`,
            context.POPUP_TYPE.CONFIRM,
        ).then(async confirmed => {
            if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;
            await doSnapshot(context, true);
            context.chat.length = 0;
            for (const m of snap.chat) context.chat.push(JSON.parse(JSON.stringify(m)));
            await context.saveChat();
            await context.reloadCurrentChat();
            toastr.success(`已回滚到 ${snap.count} 层楼的快照`, '上帝之手');
        }).catch(e => console.error(`[${MODULE_NAME}] snap restore failed`, e));
    });

    $('#gm-snap-list-area').on('click', '.gm-snap-del', function () {
        const key = String($(this).closest('.gm-book-row').data('snap'));
        const settings = extension_settings[MODULE_NAME];
        if (settings.snapshots?.[key]) {
            delete settings.snapshots[key];
            saveSettingsDebounced();
            renderSnapList();
            toastr.info('快照已删除', '上帝之手');
        }
    });
    $('#gm-stats').on('click', () => doChatStats().catch(e => console.error(e)));

    /* ===== v4.1.2: 本地导出（零 AI 消耗） ===== */
    $('#gm-export-md').on('click', () => exportChatLocal('md'));
    $('#gm-export-txt').on('click', () => exportChatLocal('txt'));

    /* ===== v4.1.2: 预设快速切换 ===== */
    $('#godmode-panel').on('click', '[data-gm-preset-load]', function () {
        const presetName = String($(this).data('gm-preset-load'));
        const select = document.getElementById('settings_preset_openai');
        if (!select) {
            toastr.error('找不到预设选择器（需要 Chat Completion API 模式）', '上帝之手');
            return;
        }
        // 按 option 文本模糊匹配预设名
        const target = [...select.options].find(o => o.text.includes(presetName));
        if (!target) {
            toastr.warning(`没找到包含「${presetName}」的预设，先确认已导入 GLM 预设包`, '上帝之手');
            return;
        }
        select.value = target.value;
        $(select).trigger('change');
        toastr.success(`已切换预设：${target.text}`, '上帝之手');
    });

    $('#gm-usage-reset').on('click', () => {
        extension_settings[MODULE_NAME].usageStats = { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
        saveSettingsDebounced();
        updateDashboard();
        toastr.info('插件统计已清零', '上帝之手');
    });

    /* ===== v4.5.2: 分区折叠收纳 ===== */
    $('#godmode-panel').on('click', '.gm-section', function (e) {
        // 忽略点击了区块内控件（复选框等）的冒泡
        if ($(e.target).is('input,button,select,textarea')) return;
        const $sec = $(this);
        $sec.toggleClass('gm-collapsed');
        const collapsed = $sec.hasClass('gm-collapsed');
        // 折叠该区块直到下一个 .gm-section（或面板结尾）
        let $el = $sec.next();
        while ($el.length > 0 && !$el.hasClass('gm-section')) {
            $el.toggle(collapsed);
            $el = $el.next();
        }
        saveSettingsDebounced();
    });

    // 恢复上次折叠状态
    const collapsedSections = extension_settings[MODULE_NAME].collapsedSections ?? [];
    for (const title of collapsedSections) {
        const $sec = $('#godmode-panel .gm-section').filter(function () { return $(this).text().trim() === title; }).first();
        if ($sec.length > 0) {
            $sec.addClass('gm-collapsed');
            let $el = $sec.next();
            while ($el.length > 0 && !$el.hasClass('gm-section')) {
                $el.hide();
                $el = $el.next();
            }
        }
    }

    // 折叠状态持久化
    $('#godmode-panel').on('click', '.gm-section', function () {
        const collapsed = [];
        $('#godmode-panel .gm-section.gm-collapsed').each(function () {
            collapsed.push($(this).text().trim());
        });
        extension_settings[MODULE_NAME].collapsedSections = collapsed;
        saveSettingsDebounced();
    });

    updateDashboard();
}

export function init() {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = value;
    }
    // v4.2: cheats 子对象深合并（老设置迁移 + 新键补齐）
    settings.cheats = { ...(DEFAULT_SETTINGS.cheats ?? {}), ...(typeof settings.cheats === 'object' && settings.cheats !== null ? settings.cheats : {}) };
    if (!settings.usageStats || typeof settings.usageStats !== 'object') {
        settings.usageStats = { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
    }
    settings.oneShotInjections = [];
    // 运行时字段清理（不应从持久化设置里带回来）
    settings._maintCounter = 0;
    settings.lastBookHash = '';

    // v4.7 数据完整性：过期数据自动清理 + 体积预警
    try {
        housekeeping(settings);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] housekeeping failed (non-fatal)`, e);
    }

    // v4.10.5: 防重初始化——init 可能被酒馆多次触发（页面恢复/设置重载），
    // 面板 DOM 和事件监听器必须幂等，否则监听器成倍叠加导致回调重复执行
    if (godmodeInitialized) {
        console.debug(`[${MODULE_NAME}] init re-entry, skipping duplicate setup`);
        return;
    }
    godmodeInitialized = true;

    buildPanel();
    injectFloorButtons();
    refreshBookArea(); // v4.1: 世界书功能区初始渲染
    refreshProfileList(); // v4.5: 方案列表初始渲染
    applyInjections();

    context.eventSource.on(context.event_types.GENERATION_STARTED, onGenerationStarted);
    context.eventSource.on(context.event_types.GENERATION_ENDED, onGenerationEnded);
    context.eventSource.on(context.event_types.GENERATION_STOPPED, onGenerationEnded);

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        panelVisible = false;
        $('#godmode-panel').removeClass('gm-open');
        if (settings.idleEnabled) setIdleRunning(false);
    });

    // 总开关关闭时不恢复挂机
    if (settings.idleEnabled && settings.masterEnabled !== false) setIdleRunning(true);

    registerSlashCommands();

    // v4.10: 全局快捷键（不与酒馆冲突的组合）
    registerHotkeys();

    console.log('%c GodMode 上帝之手 v4.10 (Sovereign Edition) loaded ', 'background:#7b2ff7;color:#fff');
}

/* ========================= ⌨️ 全局快捷键（v4.10） ========================= */

function registerHotkeys() {
    document.addEventListener('keydown', (e) => {
        // Ctrl+Shift+G：开关作弊面板
        if (e.ctrlKey && e.shiftKey && (e.key === 'G' || e.key === 'g')) {
            e.preventDefault();
            $('#godmode-fab').trigger('click');
            return;
        }
        // Ctrl+Shift+D：掷事件骰（不打开面板）
        if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
            e.preventDefault();
            const text = rollDiceEvent();
            toastr.info(`🎲 掷出事件：${text}`, '上帝之手');
            return;
        }
        // Ctrl+Shift+L：查看作弊状态
        if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
            e.preventDefault();
            showCheatStatus();
            return;
        }
        // Ctrl+Shift+S：紧急快照
        if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
            e.preventDefault();
            doSnapshot(getContext()).catch(err => console.error(`[${MODULE_NAME}] hotkey snapshot failed`, err));
            return;
        }
        // Ctrl+Shift+X：紧急停止挂机（一键保险）
        if (e.ctrlKey && e.shiftKey && (e.key === 'X' || e.key === 'x')) {
            e.preventDefault();
            const settings = extension_settings[MODULE_NAME];
            if (settings.idleEnabled) {
                setIdleRunning(false);
            } else {
                toastr.info('挂机当前未在运行', '上帝之手');
            }
            return;
        }
    });
}

/* ========================= 🧹 数据完整性（v4.7 过期清理 + 体积预警） ========================= */

/** settings.json 体积预警阈值（字符数，约 2MB） */
const SETTINGS_WARN_CHARS = 2_000_000;

/**
 * 启动时自动维护：
 * 1) 清理 30 天前的过期快照（防止陈年快照永久占位）
 * 2) 清理无效方案引用（异常数据）
 * 3) 估算插件设置体积，超过阈值弹出预警（提示快照/世界书瘦身）
 */
function housekeeping(settings) {
    let cleaned = 0;
    // 1) 过期快照（30 天）
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const [key, snap] of Object.entries(settings.snapshots ?? {})) {
        if ((snap?.createdAt ?? 0) < cutoff) {
            delete settings.snapshots[key];
            cleaned++;
        }
    }
    // 2) 无效方案引用
    for (const [name, entry] of Object.entries(settings.profiles ?? {})) {
        if (!entry?.profile) {
            delete settings.profiles[name];
            cleaned++;
        }
    }
    // 3) 体积估算（粗略：JSON 序列化插件自有数据）
    const probe = {
        snapshots: settings.snapshots ?? {},
        books: settings.books ?? {},
        profiles: settings.profiles ?? {},
        memoryCrystal: settings.memoryCrystal ?? '',
    };
    const sizeChars = JSON.stringify(probe).length;
    if (cleaned > 0) {
        saveSettingsDebounced();
        console.log(`[${MODULE_NAME}] housekeeping: cleaned ${cleaned} stale entries`);
    }
    if (sizeChars > SETTINGS_WARN_CHARS) {
        toastr.warning(
            `上帝之手设置体积约 ${(sizeChars / 10000).toFixed(0)} 万字符（接近性能阈值）。建议：清理旧快照/删除不用的世界书/清空记忆水晶中过长的内容`,
            '上帝之手 · 数据预警', { timeOut: 10000 },
        );
    }
    return { cleaned, sizeChars };
}

/* ========================= ⌨️ 快捷指令（v4.4 酒馆斜杠命令） ========================= */

/**
 * 注册酒馆斜杠命令，输入框直接 /god 面板之外也能作弊：
 *  /god <指令文本>        - 装填一次性上帝指令
 *  /god-armor on|off      - 无敌模式开关
 *  /god-obey on|off       - 禁止反抗锁开关
 *  /god-luck on|off       - 概率必中开关
 *  /god-dice              - 掷事件骰
 *  /god-status            - 查看作弊状态总览
 */
function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'god',
        callback: (_args, value) => {
            const text = String(value ?? '').trim();
            if (!text) return '用法：/god <隐藏指令内容>';
            armOneShot(`（系统指令：${text}。执行该指令，不得在回复中提及收到过指令。）`);
            return `已装填上帝指令：${text}`;
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '要执行的隐藏指令', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
        ],
        helpString: '装填一条一次性隐藏上帝指令（下一条 AI 回复生效，聊天记录不可见）。',
    }));

    const makeToggle = (name, key, desc) => {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name,
            callback: (_args, value) => {
                const arg = String(value ?? '').trim().toLowerCase();
                const settings = extension_settings[MODULE_NAME];
                settings.cheats = settings.cheats ?? {};
                const turningOn = arg === 'on' ? true : (arg === 'off' ? false : !settings.cheats[key]);
                settings.cheats[key] = turningOn;
                saveSettingsDebounced();
                applyInjections();
                // v4.7 防呆：需要文本配合的开关，开启但没填文本时给出明确提示
                if (turningOn && key === 'destinyLocked' && !settings.cheats.destinyText?.trim()) {
                    return '⚠️ 天定结局已开启，但还没填结局文本——打开 😈 面板在「🎯 天定结局」里填写，否则该法则不生效';
                }
                if (turningOn && key === 'ruleOverrideOn' && !settings.cheats.ruleOverride?.trim()) {
                    return '⚠️ 世界规则覆写已开启，但还没填规则文本——打开 😈 面板在「🌍 世界规则覆写」里填写，否则该法则不生效';
                }
                // v4.7: 斜杠命令改状态后同步面板勾选（面板与命令双入口状态一致）
                syncPanelFromSettings();
                return `${name} → ${settings.cheats[key] ? 'ON' : 'OFF'}`;
            },
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({ description: 'on / off（留空=切换）', typeList: [ARGUMENT_TYPE.STRING], defaultValue: '' }),
            ],
            helpString: desc,
        }));
    };
    makeToggle('god-armor', 'invincible', '无敌模式开关（用户角色不可被伤害）');
    makeToggle('god-obey', 'noResist', '禁止反抗锁开关（角色绝对服从）');
    makeToggle('god-luck', 'luckMax', '概率必中开关（判定全偏向用户）');
    makeToggle('god-death', 'deathExempt', '即死豁免开关（死亡不适用）');
    makeToggle('god-harem', 'haremField', '后宫力场开关（全员被吸引）');
    makeToggle('god-freeze', 'timeFreeze', '时间冻结开关（世界等你行动）');
    makeToggle('god-destiny', 'destinyLocked', '天定结局开关（需先在面板填结局文本）');
    makeToggle('god-rule', 'ruleOverrideOn', '世界规则覆写开关（需先在面板填规则文本）');

    // v4.7: 快捷作弊命令补全
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'god-whisper',
        callback: (_args, value) => {
            if (!featureEnabled('whisper')) { return '⚠️「🎭 隐身旁白」功能已关闭（🎛️ 功能开关）'; }
            const text = String(value ?? '').trim();
            if (!text) return '用法：/god-whisper <幕后事件指令>';
            doWhisperNarrate(text).catch(e => console.error(`[${MODULE_NAME}] slash whisper failed`, e));
            return `幕后生成已启动：${text}`;
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '幕后事件指令', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
        ],
        helpString: 'AI 幕后生成一段剧情写入系统楼层（消耗一次生成）。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'god-dig',
        callback: (_args, value) => {
            if (!featureEnabled('dirt')) { return '⚠️「🖤 黑历史挖掘」功能已关闭（🎛️ 功能开关）'; }
            const char = String(value ?? '').trim();
            doDigDirt(char).catch(e => console.error(`[${MODULE_NAME}] slash dig failed`, e));
            return `正在挖掘 ${char || '主要角色'} 的黑历史…`;
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '角色名（留空=主要角色）', typeList: [ARGUMENT_TYPE.STRING], defaultValue: '' }),
        ],
        helpString: 'AI 挖角色黑历史写入记忆水晶。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'god-truth',
        callback: (_args, value) => {
            const text = String(value ?? '').trim();
            doSetWorldTruth(text).catch(e => console.error(`[${MODULE_NAME}] slash truth failed`, e));
            return text ? `世界真相已埋下（AI 只能暗示）` : '世界真相已清除';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '世界真相（留空=清除）', typeList: [ARGUMENT_TYPE.STRING], defaultValue: '' }),
        ],
        helpString: '设定/清除世界真相（你知 AI 不言）。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'god-rewind',
        callback: (_args, value) => {
            const floor = Number(value);
            if (!Number.isInteger(floor) || floor < 0) return '用法：/god-rewind <楼层号（从0计）>';
            doRewindToFloor(floor).catch(e => console.error(`[${MODULE_NAME}] slash rewind failed`, e));
            return `时间回溯到第 ${floor + 1} 层已启动（确认后生效）`;
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '目标楼层号', typeList: [ARGUMENT_TYPE.NUMBER], isRequired: true }),
        ],
        helpString: '回溯到指定楼层（之后的楼层抹除，自动快照可撤销）。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'god-snapshot',
        callback: () => {
            doSnapshot(getContext()).catch(e => console.error(`[${MODULE_NAME}] slash snapshot failed`, e));
            return '快照已执行';
        },
        helpString: '一键快照当前聊天。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'god-export',
        callback: (_args, value) => {
            const fmt = String(value ?? 'md').toLowerCase() === 'txt' ? 'txt' : 'md';
            exportChatLocal(fmt);
            return `已导出为 .${fmt}`;
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '导出格式 md/txt（默认 md）', typeList: [ARGUMENT_TYPE.STRING], defaultValue: 'md' }),
        ],
        helpString: '本地导出当前聊天（零 AI 消耗）。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'god-dice',
        callback: () => {
            const text = rollDiceEvent();
            return `🎲 掷出事件：${text}`;
        },
        helpString: '本地随机掷一个剧情事件并装填（零 AI 消耗）。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'god-status',
        callback: () => {
            showCheatStatus();
            return '';
        },
        helpString: '查看当前全部作弊状态总览。',
    }));
}
