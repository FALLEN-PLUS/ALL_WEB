"use strict";

const COMMAND = {
    ENABLE: 0x01,
    DISABLE: 0x02,
    CLEAR_ELECTRICAL_ZERO: 0x03,
    CURRENT: 0x04,
    SPEED: 0x05,
    POSITION: 0x07,
    STEP: 0x08,
    MOTOR_ID: 0x09,
    TELEMETRY: 0x44,
    ENCODER_CALIBRATION: 0x6A,
    TEMP_ZERO: 0xA2,
    SAVE_ZERO: 0xB2,
    LADRC_QUERY: 0xD0,
    LADRC_SET: 0xD1,
    LADRC_SAVE: 0xD2,
    LADRC_DEFAULTS: 0xD3
};

const LADRC_GROUPS = [
    { name: "Q 轴电流环", shortName: "Q轴", dt: 0.0001, wcMax: 3000, woMax: 6553.5 },
    { name: "D 轴电流环", shortName: "D轴", dt: 0.0001, wcMax: 3000, woMax: 6553.5 },
    { name: "速度环", shortName: "速度", dt: 0.001, wcMax: 300, woMax: 800 },
    { name: "位置环", shortName: "位置", dt: 0.001, wcMax: 300, woMax: 800 }
];

const LADRC_STATUS = {
    0: { text: "RAM 与 Flash 一致", className: "success" },
    1: { text: "RAM 已修改，尚未保存", className: "warning" },
    2: { text: "正在使用代码默认值", className: "neutral" },
    "-1": { text: "操作被下位机拒绝", className: "danger" },
    "-2": { text: "Flash 校验失败", className: "danger" }
};

const TELEMETRY_MODE_NAMES = {
    run: "运行状态",
    standby: "失能待机",
    calibration: "MT6826 自校准",
    raw: "原始通道"
};

const serial = new FocSerial();
const plot = new TelemetryPlot(
    document.getElementById("plotCanvas"),
    document.getElementById("channelLegend"),
    document.getElementById("plotEmpty"),
    document.getElementById("plotRange"),
    document.getElementById("plotTooltip"),
    document.getElementById("plotAxisHint"),
    {
        container: document.getElementById("plotOverview"),
        window: document.getElementById("plotOverviewWindow"),
        start: document.getElementById("plotOverviewStart"),
        end: document.getElementById("plotOverviewEnd"),
        latest: document.getElementById("plotOverviewLatest")
    }
);

plot.onAutoScaleChange = enabled =>
{
    element("autoScale").checked = enabled;
};
plot.onPausedChange = paused =>
{
    plotPaused = paused;
    element("btnPausePlot").textContent = paused ? "继续曲线" : "暂停曲线";
};
plot.onXViewChange = state =>
{
    element("xAuto").checked = state.xAuto;
    element("plotDeltaT").textContent = `${state.periodMs} ms`;
    element("plotXDiv").textContent = `${plot.formatTime(state.xPerDivMs)}/X-div`;
    if (document.activeElement !== element("plotXStart"))
    {
        element("plotXStart").value = String(Number(state.startMs.toFixed(3)));
    }
    if (document.activeElement !== element("plotXEnd"))
    {
        element("plotXEnd").value = String(Number(state.endMs.toFixed(3)));
    }
};

const markerWaiters = new Map();
const ladrcCurrentValues = Array.from({ length: 4 }, () => null);
let frameWindowCount = 0;
let frameWindowStart = performance.now();
let plotPaused = false;
let telemetryRequested = false;
let lastOrdinaryTelemetryAt = 0;
let lastMeasuredTelemetryRate = 0;
let resolvedTelemetryMode = "run";
let lastMotorId = null;
let ladrcTaskBusy = false;

function element(id)
{
    return document.getElementById(id);
}

function addLog(message, type = "info")
{
    const output = element("logOutput");
    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`;
    output.appendChild(line);
    while (output.children.length > 300)
    {
        output.firstElementChild.remove();
    }
    output.scrollTop = output.scrollHeight;
}

function showToast(message, type = "info")
{
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    element("toastContainer").appendChild(toast);
    window.setTimeout(() => toast.remove(), 3200);
}

function setBadge(target, text, className)
{
    target.textContent = text;
    target.className = `badge ${className}`;
}

function updateConnectionUi(connected)
{
    element("connectionIndicator").className = `status-dot ${connected ? "online" : "offline"}`;
    element("connectionText").textContent = connected ? "已连接" : "未连接";
    const btnConnect = element("btnConnect");
    if (connected)
    {
        btnConnect.className = "btn-disconnect";
        btnConnect.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            <span>断开串口</span>`;
    }
    else
    {
        btnConnect.className = "btn-connect-ready";
        btnConnect.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14"></path>
                <path d="M12 5l7 7-7 7"></path>
            </svg>
            <span>连接串口</span>`;
    }
    document.querySelectorAll(".requires-connection").forEach(button =>
    {
        button.disabled = !connected;
    });

    if (!connected)
    {
        telemetryRequested = false;
        lastOrdinaryTelemetryAt = 0;
        lastMeasuredTelemetryRate = 0;
        lastMotorId = null;
        setBadge(element("telemetryBadge"), "已关闭", "neutral");
        element("currentMotorId").textContent = "未知";
        element("motorIdReadbackHint").textContent = "等待失能待机帧";
        element("telemetrySchemaHint").textContent = "等待普通遥测数据以识别字段格式";
        rejectAllMarkerWaiters(new Error("串口已断开"));
    }
}

function applyTelemetrySchema(mode, reason)
{
    if (!TELEMETRY_MODE_NAMES[mode])
    {
        return;
    }
    const schemaChanged = resolvedTelemetryMode !== mode;
    resolvedTelemetryMode = mode;
    if (schemaChanged)
    {
        // Why: 三种遥测的五个 float 含义不同，旧采样不能套用新标签继续绘制。
        plot.clear();
        plot.setPaused(false);
    }
    plot.setMode(mode);
    element("telemetrySchemaHint").textContent =
        `当前格式：${TELEMETRY_MODE_NAMES[mode]}${reason ? `（${reason}）` : ""}`;
}

function setTelemetryMode(mode)
{
    if (element("telemetryMode").value === "auto")
    {
        applyTelemetrySchema(mode, "根据控制命令预判，收到数据后复核");
    }
}

function isIntegerNear(value)
{
    return Math.abs(value - Math.round(value)) < 0.01;
}

function looksLikeStandbyTelemetry(values)
{
    const adcValuesValid = values[0] >= 0 && values[0] <= 4095 &&
        values[1] >= 0 && values[1] <= 4095 &&
        isIntegerNear(values[0]) && isIntegerNear(values[1]) &&
        (values[0] > 100 || values[1] > 100);
    const angleValid = values[2] >= 0 && values[2] <= 360;
    const busVoltageValid = values[3] >= 0 && values[3] <= 100;
    const motorIdValid = values[4] >= 0 && values[4] <= 9 && isIntegerNear(values[4]);
    return adcValuesValid && angleValid && busVoltageValid && motorIdValid;
}

function updateMotorIdFromStandby(values)
{
    const motorId = Math.round(values[4]);
    if (motorId === lastMotorId)
    {
        return;
    }
    lastMotorId = motorId;
    element("currentMotorId").textContent = String(motorId);
    element("motorIdReadbackHint").textContent = "来自失能待机遥测，已确认";
    if (document.activeElement !== element("inputMotorId"))
    {
        element("inputMotorId").value = String(motorId);
    }
    addLog(`RX 当前 Motor ID: ${motorId}`, "rx");
}

function inferAutomaticModeFromRate(rate)
{
    if (element("telemetryMode").value !== "auto" || rate <= 0)
    {
        return;
    }
    if (rate >= 500)
    {
        applyTelemetrySchema("run", `检测到约 ${rate} Hz`);
    }
    else if (rate >= 20 && rate <= 250)
    {
        applyTelemetrySchema("calibration", `检测到约 ${rate} Hz`);
    }
    else if (rate <= 5)
    {
        applyTelemetrySchema("standby", `检测到约 ${rate} Hz`);
    }
}

function handleOrdinaryTelemetry(values)
{
    frameWindowCount++;
    lastOrdinaryTelemetryAt = performance.now();
    telemetryRequested = true;
    setBadge(element("telemetryBadge"), "设备正在上报", "success");

    if (looksLikeStandbyTelemetry(values))
    {
        updateMotorIdFromStandby(values);
        if (element("telemetryMode").value === "auto")
        {
            applyTelemetrySchema("standby", "待机字段特征已确认");
        }
    }
    plot.addSample(values);
}

function signedPhysicalToRaw(value, span)
{
    if (!Number.isFinite(value) || value < -span || value > span)
    {
        throw new Error(`输入必须位于 ${-span} ～ ${span}`);
    }
    if (value === -span)
    {
        return 0x8000;
    }
    return Math.round((value / span) * 32767) & 0xFFFF;
}

function readNumberInRange(inputId, minimum, maximum, label)
{
    const value = Number(element(inputId).value);
    if (!Number.isFinite(value) || value < minimum || value > maximum)
    {
        throw new Error(`${label}必须位于 ${minimum} ～ ${maximum}`);
    }
    return value;
}

async function sendControl(command, rawData, name)
{
    await serial.sendCommand(command, rawData, 0);
    if (command === COMMAND.ENABLE)
    {
        setTelemetryMode("run");
    }
    else if (command === COMMAND.DISABLE)
    {
        setTelemetryMode("standby");
    }
    else if (command === COMMAND.ENCODER_CALIBRATION)
    {
        setTelemetryMode("calibration");
    }
    element("commandState").textContent = `${name}已发送；等待实际遥测状态确认`;
    showToast(`${name}已发送`, "success");
}

function renderLadrcGroups()
{
    const container = element("ladrcGroups");
    container.innerHTML = "";

    LADRC_GROUPS.forEach((group, groupIndex) =>
    {
        const section = document.createElement("section");
        section.className = "ladrc-group";
        section.innerHTML = `
            <div class="ladrc-group-header">
                <strong>${group.name}</strong>
                <span id="ladrcStatus${groupIndex}" class="badge neutral">未读取</span>
            </div>
            <div class="ladrc-inputs">
                <label>b0<input id="ladrc${groupIndex}b0" type="number" min="0.6" max="6553.5" step="0.1" placeholder="--"></label>
                <label>wc<input id="ladrc${groupIndex}wc" type="number" min="0.1" max="${group.wcMax}" step="0.1" placeholder="--"></label>
                <label>wo<input id="ladrc${groupIndex}wo" type="number" min="0.1" max="${group.woMax}" step="0.1" placeholder="--"></label>
            </div>
            <div class="field-hint" style="margin:7px 0 0">dt=${group.dt} s，要求 wo ≥ wc</div>
            <div class="ladrc-group-actions">
                <button data-ladrc-query="${groupIndex}" class="btn-secondary requires-connection" disabled>查询</button>
                <button data-ladrc-apply="${groupIndex}" class="btn-secondary requires-connection" disabled>应用这一组</button>
            </div>`;
        container.appendChild(section);
    });

    container.querySelectorAll("[data-ladrc-query]").forEach(button =>
    {
        button.addEventListener("click", () => runTask(() => runLadrcTask(
            () => queryLadrcGroup(Number(button.dataset.ladrcQuery)))));
    });
    container.querySelectorAll("[data-ladrc-apply]").forEach(button =>
    {
        button.addEventListener("click", () => runTask(() => runLadrcTask(
            () => applyLadrcGroup(Number(button.dataset.ladrcApply)))));
    });
}

function updateLadrcGroup(groupIndex, values)
{
    const statusValue = Math.round(values[4]);
    ladrcCurrentValues[groupIndex] = {
        b0: values[1],
        wc: values[2],
        wo: values[3],
        status: statusValue
    };
    element(`ladrc${groupIndex}b0`).value = values[1].toFixed(1);
    element(`ladrc${groupIndex}wc`).value = values[2].toFixed(1);
    element(`ladrc${groupIndex}wo`).value = values[3].toFixed(1);

    const status = LADRC_STATUS[statusValue] || { text: `未知状态 ${statusValue}`, className: "danger" };
    setBadge(element(`ladrcStatus${groupIndex}`), status.text, status.className);
    setBadge(element("ladrcGlobalStatus"), status.text, status.className);
}

function markerKey(marker)
{
    return String(Math.round(marker));
}

function removeMarkerWaiter(key, waiter)
{
    const queue = markerWaiters.get(key) || [];
    const index = queue.indexOf(waiter);
    if (index >= 0)
    {
        queue.splice(index, 1);
    }
    if (queue.length === 0)
    {
        markerWaiters.delete(key);
    }
}

function createMarkerWaiter(marker, timeoutMs = 1500)
{
    const key = markerKey(marker);
    let waiter = null;
    const promise = new Promise((resolve, reject) =>
    {
        waiter = { resolve, reject, timer: null };
        waiter.timer = window.setTimeout(() =>
        {
            removeMarkerWaiter(key, waiter);
            reject(new Error(`等待下位机回复 ${marker} 超时`));
        }, timeoutMs);

        const queue = markerWaiters.get(key) || [];
        queue.push(waiter);
        markerWaiters.set(key, queue);
    });
    return {
        promise,
        cancel(error)
        {
            window.clearTimeout(waiter.timer);
            removeMarkerWaiter(key, waiter);
            waiter.reject(error);
        }
    };
}

function waitForMarker(marker, timeoutMs = 1500)
{
    return createMarkerWaiter(marker, timeoutMs).promise;
}

function deliverMarker(values)
{
    const key = markerKey(values[0]);
    const queue = markerWaiters.get(key);
    if (!queue || queue.length === 0)
    {
        return;
    }
    const waiter = queue.shift();
    window.clearTimeout(waiter.timer);
    if (queue.length === 0)
    {
        markerWaiters.delete(key);
    }
    waiter.resolve(values);
}

function rejectAllMarkerWaiters(error)
{
    for (const queue of markerWaiters.values())
    {
        for (const waiter of queue)
        {
            window.clearTimeout(waiter.timer);
            waiter.reject(error);
        }
    }
    markerWaiters.clear();
}

async function sendAndWait(command, rawData, aux, marker, timeoutMs = 1500)
{
    const waiter = createMarkerWaiter(marker, timeoutMs);
    try
    {
        await serial.sendCommand(command, rawData, aux);
    }
    catch (error)
    {
        waiter.cancel(error);
        await waiter.promise.catch(() => {});
        throw error;
    }
    return waiter.promise;
}

async function queryLadrcGroup(groupIndex)
{
    const marker = -10000 - groupIndex;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++)
    {
        try
        {
            const values = await sendAndWait(COMMAND.LADRC_QUERY, 0, groupIndex, marker, 1200);
            if (attempt > 1)
            {
                addLog(`${LADRC_GROUPS[groupIndex].name}第 ${attempt} 次查询成功`, "rx");
            }
            showToast(`${LADRC_GROUPS[groupIndex].name}参数已读取`, "success");
            return values;
        }
        catch (error)
        {
            lastError = error;
            if (attempt < 3)
            {
                addLog(`${LADRC_GROUPS[groupIndex].name}查询无回复，200 ms 后重试 (${attempt}/3)`, "error");
                await new Promise(resolve => window.setTimeout(resolve, 200));
            }
        }
    }

    throw new Error(`${LADRC_GROUPS[groupIndex].name}连续 3 次查询失败：${lastError.message}`);
}

function readLadrcTargets(groupIndex)
{
    const group = LADRC_GROUPS[groupIndex];
    const b0 = readNumberInRange(`ladrc${groupIndex}b0`, 0.6, 6553.5, "b0");
    const wc = readNumberInRange(`ladrc${groupIndex}wc`, 0.1, group.wcMax, "wc");
    const wo = readNumberInRange(`ladrc${groupIndex}wo`, 0.1, group.woMax, "wo");
    if (wo < wc)
    {
        throw new Error("wo 必须大于或等于 wc");
    }
    return {
        b0: Math.round(b0 * 10) / 10,
        wc: Math.round(wc * 10) / 10,
        wo: Math.round(wo * 10) / 10
    };
}

async function setLadrcParameter(groupIndex, itemIndex, value)
{
    const parameterId = groupIndex * 3 + itemIndex;
    const rawData = Math.round(value * 10);
    const marker = -10000 - groupIndex;
    const response = await sendAndWait(COMMAND.LADRC_SET, rawData, parameterId, marker);
    if (Math.round(response[4]) === -1)
    {
        throw new Error(`${LADRC_GROUPS[groupIndex].name}参数被下位机拒绝`);
    }
    return response;
}

async function applyLadrcGroup(groupIndex)
{
    const targets = readLadrcTargets(groupIndex);
    await queryLadrcGroup(groupIndex);
    const current = ladrcCurrentValues[groupIndex];
    if (!current)
    {
        throw new Error("未能读取当前 LADRC 参数");
    }

    const order = [0];
    if (targets.wc > current.wo)
    {
        order.push(2, 1);
    }
    else if (targets.wo < current.wc)
    {
        order.push(1, 2);
    }
    else
    {
        order.push(1, 2);
    }
    const values = [targets.b0, targets.wc, targets.wo];
    for (const itemIndex of order)
    {
        await setLadrcParameter(groupIndex, itemIndex, values[itemIndex]);
    }
    showToast(`${LADRC_GROUPS[groupIndex].name}已写入 RAM`, "success");
}

async function queryAllLadrc()
{
    const failedGroups = [];
    for (let group = 0; group < 4; group++)
    {
        try
        {
            await queryLadrcGroup(group);
        }
        catch (error)
        {
            failedGroups.push(LADRC_GROUPS[group].shortName);
            addLog(error.message, "error");
        }
    }
    if (failedGroups.length > 0)
    {
        throw new Error(`以下环路仍未读到：${failedGroups.join("、")}`);
    }
    showToast("四组 LADRC 参数读取完成", "success");
}

async function saveLadrc()
{
    if (!window.confirm("确认将当前全部 12 个 LADRC 参数写入 Flash？\n请确保电机已经失能。"))
    {
        return;
    }
    const response = await sendAndWait(COMMAND.LADRC_SAVE, 0, 0, -10010, 2500);
    if (Math.round(response[1]) !== 1)
    {
        throw new Error("下位机保存 LADRC 参数失败或拒绝执行");
    }
    setBadge(element("ladrcGlobalStatus"), "RAM 与 Flash 一致", "success");
    document.querySelectorAll("[id^='ladrcStatus']").forEach(status =>
    {
        setBadge(status, "RAM 与 Flash 一致", "success");
    });
    showToast(`LADRC 参数保存成功，Flash 版本 ${Math.round(response[2])}`, "success");
}

async function restoreLadrcDefaults()
{
    if (!window.confirm("确认把四组 LADRC 参数恢复为代码默认值？\n本操作只修改 RAM，仍需点击保存才会写入 Flash。"))
    {
        return;
    }

    const groupWaiters = [0, 1, 2, 3].map(group => createMarkerWaiter(-10000 - group, 2500));
    const failureWaiter = createMarkerWaiter(-10011, 2500);
    const allWaiters = [...groupWaiters, failureWaiter];
    try
    {
        await serial.sendCommand(COMMAND.LADRC_DEFAULTS, 0, 0);
    }
    catch (error)
    {
        allWaiters.forEach(waiter => waiter.cancel(error));
        await Promise.allSettled(allWaiters.map(waiter => waiter.promise));
        throw error;
    }

    let outcome;
    try
    {
        outcome = await Promise.race([
            Promise.all(groupWaiters.map(waiter => waiter.promise)).then(() => "success"),
            failureWaiter.promise.then(() => "rejected")
        ]);
    }
    catch (error)
    {
        allWaiters.forEach(waiter => waiter.cancel(error));
        await Promise.allSettled(allWaiters.map(waiter => waiter.promise));
        throw error;
    }
    if (outcome === "rejected")
    {
        const error = new Error("下位机拒绝恢复 LADRC 默认值");
        groupWaiters.forEach(waiter => waiter.cancel(error));
        await Promise.allSettled(groupWaiters.map(waiter => waiter.promise));
        throw error;
    }
    const completed = new Error("LADRC 默认参数回复已完整接收");
    failureWaiter.cancel(completed);
    await failureWaiter.promise.catch(() => {});
    showToast("已恢复代码默认值，当前尚未保存", "success");
}

function handleLadrcResponse(values)
{
    const marker = Math.round(values[0]);
    if (marker <= -10000 && marker >= -10003)
    {
        const group = -10000 - marker;
        updateLadrcGroup(group, values);
        addLog(`RX LADRC ${LADRC_GROUPS[group].shortName}: b0=${values[1]}, wc=${values[2]}, wo=${values[3]}, status=${Math.round(values[4])}`, "rx");
    }
    else if (marker === -10010)
    {
        addLog(`RX LADRC 保存结果: result=${Math.round(values[1])}, version=${Math.round(values[2])}`, "rx");
    }
    else if (marker === -10011)
    {
        addLog("RX LADRC 恢复默认失败", "error");
        showToast("下位机拒绝恢复 LADRC 默认值", "error");
    }
    else if (marker === -10020)
    {
        addLog(`RX LADRC 参数编号无效: ${Math.round(values[3])}`, "error");
        showToast("LADRC 参数或环路编号无效", "error");
    }
    deliverMarker(values);
}

function isLadrcMarker(value)
{
    const marker = Math.round(value);
    return Math.abs(value - marker) < 0.01 &&
        ((marker <= -10000 && marker >= -10003) || marker === -10010 || marker === -10011 || marker === -10020);
}

serial.onFrame = values =>
{
    element("statFrames").textContent = String(serial.frameCount);
    element("statResync").textContent = String(serial.resyncByteCount);
    element("statInvalid").textContent = String(serial.invalidFrameCount);
    element("statLastRx").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });

    if (isLadrcMarker(values[0]))
    {
        handleLadrcResponse(values);
    }
    else
    {
        handleOrdinaryTelemetry(values);
    }
};

serial.onTransmit = frame =>
{
    addLog("TX " + FocSerial.toHex(frame), "tx");
};

serial.onConnectionChange = connected =>
{
    updateConnectionUi(connected);
    addLog(connected ? "串口连接成功：460800 8N1" : "串口已断开", connected ? "rx" : "info");
};

serial.onError = message =>
{
    addLog(message, "error");
    showToast(message, "error");
};

async function toggleConnection()
{
    const button = element("btnConnect");
    button.disabled = true;
    try
    {
        if (serial.isConnected)
        {
            if (telemetryRequested)
            {
                await serial.sendCommand(COMMAND.TELEMETRY, 0, 0).catch(() => {});
            }
            await serial.disconnect();
        }
        else
        {
            await serial.connect();
        }
    }
    finally
    {
        button.disabled = false;
    }
}

async function runTask(task)
{
    try
    {
        await task();
    }
    catch (error)
    {
        addLog(error.message, "error");
        showToast(error.message, "error");
    }
}

async function runLadrcTask(task)
{
    if (ladrcTaskBusy)
    {
        throw new Error("已有 LADRC 操作正在执行，请等待当前操作完成");
    }
    ladrcTaskBusy = true;
    try
    {
        return await task();
    }
    finally
    {
        ladrcTaskBusy = false;
    }
}

function bindEvents()
{
    element("btnConnect").addEventListener("click", () => runTask(toggleConnection));

    element("btnTelemetryStart").addEventListener("click", () => runTask(async () =>
    {
        await serial.sendCommand(COMMAND.TELEMETRY, 1, 0);
        telemetryRequested = true;
        setBadge(element("telemetryBadge"), "等待设备上报", "warning");
        showToast("连续遥测开启命令已发送", "success");
    }));

    element("btnTelemetryStop").addEventListener("click", () => runTask(async () =>
    {
        await serial.sendCommand(COMMAND.TELEMETRY, 0, 0);
        telemetryRequested = false;
        setBadge(element("telemetryBadge"), "等待设备停止", "warning");
        showToast("连续遥测关闭命令已发送", "success");
    }));

    element("telemetryMode").addEventListener("change", event =>
    {
        if (event.target.value === "auto")
        {
            inferAutomaticModeFromRate(lastMeasuredTelemetryRate);
            if (lastMeasuredTelemetryRate <= 0)
            {
                applyTelemetrySchema(resolvedTelemetryMode, "等待新的遥测帧复核");
            }
        }
        else
        {
            applyTelemetrySchema(event.target.value, "手动选择");
        }
    });
    element("btnEnable").addEventListener("click", () => runTask(() => sendControl(COMMAND.ENABLE, 0, "电机使能")));
    element("btnDisable").addEventListener("click", () => runTask(() => sendControl(COMMAND.DISABLE, 0, "电机立即失能")));

    document.querySelectorAll("[data-motion]").forEach(button =>
    {
        button.addEventListener("click", () => runTask(async () =>
        {
            const type = button.dataset.motion;
            if (type === "current")
            {
                const value = readNumberInRange("inputCurrent", -10, 10, "Iq 电流");
                await sendControl(COMMAND.CURRENT, signedPhysicalToRaw(value, 10), `目标电流 ${value} A`);
            }
            else if (type === "speed")
            {
                const value = readNumberInRange("inputSpeed", -100, 100, "目标速度");
                await sendControl(COMMAND.SPEED, signedPhysicalToRaw(value, 100), `目标速度 ${value} Hz`);
            }
            else if (type === "position")
            {
                const value = readNumberInRange("inputPosition", -10, 10, "绝对位置");
                await sendControl(COMMAND.POSITION, signedPhysicalToRaw(value, 10), `绝对位置 ${value} 圈`);
            }
            else if (type === "step")
            {
                const value = readNumberInRange("inputStep", -2, 2, "相对步进");
                await sendControl(COMMAND.STEP, signedPhysicalToRaw(value, 2), `相对步进 ${value} 圈`);
            }
        }));
    });

    element("btnSetMotorId").addEventListener("click", () => runTask(async () =>
    {
        const motorId = readNumberInRange("inputMotorId", 0, 9, "Motor ID");
        if (!Number.isInteger(motorId))
        {
            throw new Error("Motor ID 必须是 0～9 的整数");
        }
        if (window.confirm(`确认把 Motor ID 设置为 ${motorId} 并写入 Flash？`))
        {
            await sendControl(COMMAND.MOTOR_ID, motorId, `Motor ID ${motorId}`);
            element("motorIdReadbackHint").textContent = "设置命令已发送，等待待机遥测确认";
        }
    }));

    element("btnClearElectricalZero").addEventListener("click", () => runTask(async () =>
    {
        if (window.confirm("确认擦除电气零点？\n设备重新启动后需要重新执行电气零点标定。"))
        {
            await sendControl(COMMAND.CLEAR_ELECTRICAL_ZERO, 0, "擦除电气零点");
        }
    }));

    element("btnEncoderCalibration").addEventListener("click", () => runTask(async () =>
    {
        if (window.confirm("确认启动 MT6826 自校准？\n请确保电机失能、机构可以安全转动。"))
        {
            await sendControl(COMMAND.ENCODER_CALIBRATION, 0, "MT6826 自校准");
        }
    }));

    element("btnSetTempZero").addEventListener("click", () => runTask(async () =>
    {
        if (window.confirm("确认把当前位置设为临时业务零点？\n该设置仅在本次上电期间有效。"))
        {
            await sendControl(COMMAND.TEMP_ZERO, 0, "临时业务零点");
        }
    }));

    element("btnSaveZero").addEventListener("click", () => runTask(async () =>
    {
        if (window.confirm("确认把当前位置保存为永久业务零点？\n该操作会写入 Flash。"))
        {
            await sendControl(COMMAND.SAVE_ZERO, 0, "永久业务零点");
        }
    }));

    element("btnQueryAll").addEventListener("click", () => runTask(() => runLadrcTask(queryAllLadrc)));
    element("btnSaveLadrc").addEventListener("click", () => runTask(() => runLadrcTask(saveLadrc)));
    element("btnRestoreLadrc").addEventListener("click", () => runTask(() => runLadrcTask(restoreLadrcDefaults)));

    element("btnPausePlot").addEventListener("click", () =>
    {
        plot.setPaused(!plot.paused);
    });
    element("btnClearPlot").addEventListener("click", () => plot.clear());
    element("btnExportCsv").addEventListener("click", () => runTask(async () => plot.exportCsv()));
    element("autoScale").addEventListener("change", event => plot.setAutoScale(event.target.checked));
    element("xAuto").addEventListener("change", event => plot.setXAuto(event.target.checked));
    const applyXBounds = () => plot.setViewBounds(
        Number(element("plotXStart").value),
        Number(element("plotXEnd").value)
    );
    element("plotXStart").addEventListener("change", applyXBounds);
    element("plotXEnd").addEventListener("change", applyXBounds);
    element("btnClearLog").addEventListener("click", () => { element("logOutput").innerHTML = ""; });
}

window.setInterval(() =>
{
    const now = performance.now();
    const elapsed = Math.max(0.001, (now - frameWindowStart) / 1000);
    const measuredRate = Math.round(frameWindowCount / elapsed);
    lastMeasuredTelemetryRate = measuredRate;
    element("statRate").textContent = `${measuredRate} Hz`;
    element("statResync").textContent = String(serial.resyncByteCount);
    element("statInvalid").textContent = String(serial.invalidFrameCount);
    inferAutomaticModeFromRate(measuredRate);

    if (lastOrdinaryTelemetryAt > 0)
    {
        const silenceLimit = resolvedTelemetryMode === "standby" ? 2500 : 500;
        if ((now - lastOrdinaryTelemetryAt) > silenceLimit)
        {
            telemetryRequested = false;
            setBadge(element("telemetryBadge"), "未检测到上报", "neutral");
        }
    }
    frameWindowCount = 0;
    frameWindowStart = now;
}, 1000);

renderLadrcGroups();
bindEvents();
updateConnectionUi(false);
addLog("上位机已就绪，请使用 Chrome 或 Edge 连接串口");
