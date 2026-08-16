"use strict";

const TELEMETRY_MODES = {
    run: [["目标速度", "Hz"], ["实际速度", "Hz"], ["目标 Iq", "A"], ["实际 Iq", "A"], ["原始角度", "deg"]],
    standby: [["U 相 ADC", "count"], ["W 相 ADC", "count"], ["原始角度", "deg"], ["母线电压", "V"], ["Motor ID", ""]],
    calibration: [["目标速度", "Hz"], ["实际速度", "Hz"], ["目标 Iq", "A"], ["实际 Iq", "A"], ["标定状态", ""]],
    raw: [["CH1", ""], ["CH2", ""], ["CH3", ""], ["CH4", ""], ["CH5", ""]]
};

const TELEMETRY_TIMING = {
    run: { periodMs: 1, xPerDivMs: 200 },
    calibration: { periodMs: 10, xPerDivMs: 200 },
    standby: { periodMs: 1000, xPerDivMs: 1000 },
    raw: { periodMs: 1, xPerDivMs: 200 }
};

class TelemetryPlot
{
    constructor(canvas, legend, emptyHint, rangeLabel, tooltip, axisHint, overview)
    {
        this.canvas = canvas;
        this.context = canvas.getContext("2d");
        this.legend = legend;
        this.emptyHint = emptyHint;
        this.rangeLabel = rangeLabel;
        this.tooltip = tooltip;
        this.axisHint = axisHint;
        this.overview = overview;
        this.colors = ["#0071E3", "#0D9488", "#D97706", "#DC2626", "#7C3AED"];
        this.visible = [true, true, true, true, true];
        this.latestValues = [0, 0, 0, 0, 0];
        this.samples = [];
        this.sampleHead = 0;
        this.sampleIndex = 0;
        this.capacity = 10000;
        this.mode = "run";
        this.periodMs = 1;
        this.xDivisions = 10;
        this.autoAnchorRatio = 0.8;
        this.xPerDivMs = 200;
        this.viewStartMs = 0;
        this.viewEndMs = 2000;
        this.xAuto = true;
        this.paused = false;
        this.frozenSamples = null;
        this.autoScale = true;
        this.lastRange = [-1, 1];
        this.hoverPoint = null;
        this.hoverRegion = "outside";
        this.hoverChannel = null;
        this.dragState = null;
        this.overviewDrag = null;
        this.xViewNotificationPending = false;
        this.dirty = true;

        this.onAutoScaleChange = () => {};
        this.onPausedChange = () => {};
        this.onXViewChange = () => {};

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.canvas.parentElement);
        this.bindPointerEvents();
        this.bindOverviewEvents();
        this.setMode("run", true);
        this.animationFrame = requestAnimationFrame(() => this.drawLoop());
    }

    clamp(value, minimum, maximum)
    {
        return Math.max(minimum, Math.min(maximum, value));
    }

    resize()
    {
        const rect = this.canvas.getBoundingClientRect();
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        const width = Math.max(1, Math.round(rect.width * ratio));
        const height = Math.max(1, Math.round(rect.height * ratio));
        if (this.canvas.width !== width || this.canvas.height !== height)
        {
            this.canvas.width = width;
            this.canvas.height = height;
            this.dirty = true;
        }
    }

    getGeometryCss()
    {
        const rect = this.canvas.getBoundingClientRect();
        const left = 64;
        const right = 14;
        const top = 14;
        const bottom = 40;
        return { rect, left, right, top, bottom,
            plotWidth: Math.max(1, rect.width - left - right),
            plotHeight: Math.max(1, rect.height - top - bottom) };
    }

    getPosition(event, geometry)
    {
        return { x: event.clientX - geometry.rect.left, y: event.clientY - geometry.rect.top };
    }

    getRegion(position, geometry)
    {
        const plotRight = geometry.rect.width - geometry.right;
        const plotBottom = geometry.rect.height - geometry.bottom;
        if (position.x <= geometry.left && position.y >= geometry.top && position.y <= plotBottom)
        {
            return "y-axis";
        }
        if (position.y >= plotBottom && position.x >= geometry.left && position.x <= plotRight)
        {
            return "x-axis";
        }
        if (position.x >= geometry.left && position.x <= plotRight &&
            position.y >= geometry.top && position.y <= plotBottom)
        {
            return "plot";
        }
        return "outside";
    }

    bindPointerEvents()
    {
        this.canvas.addEventListener("wheel", event => this.handleWheel(event), { passive: false });
        this.canvas.addEventListener("pointerdown", event => this.handlePointerDown(event));
        this.canvas.addEventListener("pointermove", event => this.handlePointerMove(event));
        this.canvas.addEventListener("pointerup", event => this.handlePointerUp(event));
        this.canvas.addEventListener("pointercancel", event => this.handlePointerUp(event));
        this.canvas.addEventListener("pointerleave", () =>
        {
            if (!this.dragState)
            {
                this.hoverPoint = null;
                this.hoverRegion = "outside";
                this.tooltip.style.display = "none";
                this.hideAxisHint();
                this.canvas.style.cursor = "crosshair";
                this.dirty = true;
            }
        });
        this.canvas.addEventListener("dblclick", event => this.handleDoubleClick(event));
    }

    bindOverviewEvents()
    {
        if (!this.overview)
        {
            return;
        }
        const begin = (event, edge) =>
        {
            if (event.button !== 0)
            {
                return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
            this.overviewDrag = { pointerId: event.pointerId, edge };
            this.setPaused(true);
        };
        this.overview.start.addEventListener("pointerdown", event => begin(event, "start"));
        this.overview.end.addEventListener("pointerdown", event => begin(event, "end"));
        this.overview.container.addEventListener("pointermove", event =>
        {
            if (!this.overviewDrag || this.overviewDrag.pointerId !== event.pointerId)
            {
                return;
            }
            const bounds = this.getOverviewBounds();
            const rect = this.overview.container.getBoundingClientRect();
            const ratio = this.clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
            const timeMs = bounds.minimum + ratio * (bounds.maximum - bounds.minimum);
            if (this.overviewDrag.edge === "start")
            {
                this.setViewBounds(timeMs, this.viewEndMs);
            }
            else
            {
                this.setViewBounds(this.viewStartMs, timeMs);
            }
        });
        const finish = event =>
        {
            if (this.overviewDrag && this.overviewDrag.pointerId === event.pointerId)
            {
                this.overviewDrag = null;
            }
        };
        this.overview.container.addEventListener("pointerup", finish);
        this.overview.container.addEventListener("pointercancel", finish);
    }

    handleWheel(event)
    {
        event.preventDefault();
        const geometry = this.getGeometryCss();
        const position = this.getPosition(event, geometry);
        const region = this.getRegion(position, geometry);
        if (region === "y-axis" || (region === "plot" && event.ctrlKey))
        {
            this.zoomY(event.deltaY, position.y, geometry);
        }
        else if (region === "x-axis" || region === "plot")
        {
            this.zoomX(event.deltaY, position.x, geometry);
        }
    }

    nextNiceXDiv(zoomIn)
    {
        const current = Math.max(0.001, this.xPerDivMs);
        const exponent = Math.floor(Math.log10(current));
        const unit = Math.pow(10, exponent);
        const normalized = current / unit;
        let next;
        if (zoomIn)
        {
            next = normalized > 5.000001 ? 5 * unit :
                normalized > 2.000001 ? 2 * unit :
                normalized > 1.000001 ? unit : 5 * unit / 10;
        }
        else
        {
            next = normalized < 1.999999 ? 2 * unit :
                normalized < 4.999999 ? 5 * unit : 10 * unit;
        }
        const minimum = Math.max(0.001, this.periodMs / 10);
        const maximum = Math.max(this.periodMs * this.capacity, TELEMETRY_TIMING[this.mode].xPerDivMs * 1000);
        return this.clamp(next, minimum, maximum);
    }

    zoomX(deltaY, pointerX, geometry)
    {
        const cursorRatio = this.clamp((pointerX - geometry.left) / geometry.plotWidth, 0, 1);
        const anchorMs = this.viewStartMs + cursorRatio * (this.viewEndMs - this.viewStartMs);
        const newXDiv = this.nextNiceXDiv(deltaY < 0);
        if (newXDiv === this.xPerDivMs)
        {
            return;
        }
        const newSpan = newXDiv * this.xDivisions;
        this.xPerDivMs = newXDiv;
        if (this.xAuto && !this.paused)
        {
            // Why: Auto 模式下最新点是固定参考，不应因鼠标位置改变而漂离 80% 锚点。
            this.followLatest(true);
        }
        else
        {
            this.viewStartMs = anchorMs - cursorRatio * newSpan;
            this.viewEndMs = this.viewStartMs + newSpan;
        }
        this.notifyXViewChange();
        this.dirty = true;
    }

    zoomY(deltaY, pointerY, geometry)
    {
        if (this.autoScale)
        {
            this.computeRange(this.getVisibleSamples());
        }
        const oldSpan = Math.max(1e-9, this.lastRange[1] - this.lastRange[0]);
        const newSpan = this.clamp(oldSpan * (deltaY > 0 ? 1.18 : 1 / 1.18), 1e-9, 1e12);
        const yRatio = this.clamp((pointerY - geometry.top) / geometry.plotHeight, 0, 1);
        const cursorValue = this.lastRange[1] - oldSpan * yRatio;
        const newMaximum = cursorValue + newSpan * yRatio;
        this.lastRange = [newMaximum - newSpan, newMaximum];
        this.setAutoScale(false);
        this.dirty = true;
    }

    handlePointerDown(event)
    {
        if (event.button !== 0)
        {
            return;
        }
        const geometry = this.getGeometryCss();
        const region = this.getRegion(this.getPosition(event, geometry), geometry);
        if (region !== "x-axis" && region !== "y-axis")
        {
            return;
        }
        this.canvas.setPointerCapture(event.pointerId);
        if (region === "y-axis" && this.autoScale)
        {
            this.computeRange(this.getVisibleSamples());
        }
        this.dragState = { pointerId: event.pointerId, region,
            startX: event.clientX, startY: event.clientY,
            startView: [this.viewStartMs, this.viewEndMs], startRange: this.lastRange.slice() };
        if (region === "x-axis")
        {
            this.setPaused(true);
        }
        else
        {
            this.setAutoScale(false);
        }
        this.canvas.parentElement.classList.add("dragging");
        this.canvas.style.cursor = "grabbing";
    }

    handlePointerMove(event)
    {
        const geometry = this.getGeometryCss();
        const position = this.getPosition(event, geometry);
        this.hoverPoint = position;
        this.hoverRegion = this.getRegion(position, geometry);
        if (this.dragState && this.dragState.pointerId === event.pointerId)
        {
            if (this.dragState.region === "x-axis")
            {
                const span = this.dragState.startView[1] - this.dragState.startView[0];
                const deltaMs = -((event.clientX - this.dragState.startX) / geometry.plotWidth) * span;
                this.viewStartMs = this.dragState.startView[0] + deltaMs;
                this.viewEndMs = this.dragState.startView[1] + deltaMs;
                this.notifyXViewChange();
            }
            else
            {
                const span = this.dragState.startRange[1] - this.dragState.startRange[0];
                const deltaValue = ((event.clientY - this.dragState.startY) / geometry.plotHeight) * span;
                this.lastRange = [this.dragState.startRange[0] + deltaValue, this.dragState.startRange[1] + deltaValue];
            }
        }
        else
        {
            this.updatePointerPresentation(position, geometry);
        }
        this.dirty = true;
    }

    updatePointerPresentation(position, geometry)
    {
        if (this.hoverRegion === "x-axis")
        {
            this.canvas.style.cursor = "ew-resize";
            this.showAxisHint("VOFA 式 X 轴\n滚轮：切换 ms/X-div 量程\n左键拖动：平移起止边界\n双击：恢复 Auto 跟随", position, geometry);
        }
        else if (this.hoverRegion === "y-axis")
        {
            this.canvas.style.cursor = "ns-resize";
            this.showAxisHint("波形图 Y 轴\n滚轮：缩放数值范围\n左键拖动：上下平移\n双击：恢复自动量程", position, geometry);
        }
        else
        {
            this.canvas.style.cursor = "crosshair";
            this.hideAxisHint();
        }
    }

    showAxisHint(text, position, geometry)
    {
        if (!this.axisHint)
        {
            return;
        }
        this.axisHint.textContent = text;
        this.axisHint.style.display = "block";
        const left = position.x < geometry.rect.width * 0.55 ? position.x + 14 : position.x - 230;
        this.axisHint.style.left = `${Math.max(6, left)}px`;
        this.axisHint.style.top = `${this.clamp(position.y - 28, 6, geometry.rect.height - 100)}px`;
    }

    hideAxisHint()
    {
        if (this.axisHint)
        {
            this.axisHint.style.display = "none";
        }
    }

    handlePointerUp(event)
    {
        if (!this.dragState || this.dragState.pointerId !== event.pointerId)
        {
            return;
        }
        if (this.canvas.hasPointerCapture(event.pointerId))
        {
            this.canvas.releasePointerCapture(event.pointerId);
        }
        this.dragState = null;
        this.canvas.parentElement.classList.remove("dragging");
        this.updatePointerPresentation(this.hoverPoint || { x: 0, y: 0 }, this.getGeometryCss());
    }

    handleDoubleClick(event)
    {
        const geometry = this.getGeometryCss();
        const region = this.getRegion(this.getPosition(event, geometry), geometry);
        if (region === "x-axis")
        {
            this.resetXView();
        }
        else if (region === "y-axis")
        {
            this.setAutoScale(true);
        }
        else if (region === "plot")
        {
            this.resetXView();
            this.setAutoScale(true);
        }
    }

    resetXView()
    {
        this.xPerDivMs = TELEMETRY_TIMING[this.mode].xPerDivMs;
        this.setPaused(false);
        this.followLatest(true);
        this.notifyXViewChange();
    }

    setMode(mode, force = false)
    {
        if (!TELEMETRY_MODES[mode] || (!force && this.mode === mode))
        {
            return;
        }
        this.mode = mode;
        const timing = TELEMETRY_TIMING[mode];
        this.periodMs = timing.periodMs;
        this.xPerDivMs = timing.xPerDivMs;
        this.viewStartMs = 0;
        this.viewEndMs = this.xPerDivMs * this.xDivisions;
        this.xAuto = true;
        const wasPaused = this.paused;
        this.paused = false;
        this.frozenSamples = null;
        this.buildLegend();
        if (wasPaused)
        {
            this.onPausedChange(false);
        }
        this.notifyXViewChange();
        this.dirty = true;
    }

    setViewBounds(startMs, endMs)
    {
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
        {
            return;
        }
        const minimumSpan = Math.max(0.001, this.periodMs);
        if (endMs - startMs < minimumSpan)
        {
            return;
        }
        this.viewStartMs = startMs;
        this.viewEndMs = endMs;
        this.xPerDivMs = (endMs - startMs) / this.xDivisions;
        this.setPaused(true);
        this.notifyXViewChange();
        this.dirty = true;
    }

    setXAuto(enabled)
    {
        this.xAuto = enabled;
        if (enabled)
        {
            this.setPaused(false);
            this.followLatest(true);
        }
        else
        {
            this.setPaused(true);
        }
        this.notifyXViewChange();
        this.dirty = true;
    }

    followLatest(force = false)
    {
        const span = this.xPerDivMs * this.xDivisions;
        if (this.samples.length === this.sampleHead)
        {
            this.viewStartMs = 0;
            this.viewEndMs = span;
            return true;
        }
        const latest = this.samples[this.samples.length - 1].timeMs;
        const newStart = latest - span * this.autoAnchorRatio;
        const newEnd = newStart + span;
        const changed = force || newStart !== this.viewStartMs || newEnd !== this.viewEndMs;
        this.viewStartMs = newStart;
        this.viewEndMs = newEnd;
        return changed;
    }

    buildLegend()
    {
        this.legend.innerHTML = "";
        TELEMETRY_MODES[this.mode].forEach((definition, index) =>
        {
            const item = document.createElement("label");
            item.className = "channel-item";
            item.title = "双击仅显示此通道；再次双击恢复全部通道";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = this.visible[index];
            checkbox.addEventListener("change", () => { this.visible[index] = checkbox.checked; this.dirty = true; });
            const name = document.createElement("span");
            name.className = "channel-name";
            name.textContent = definition[0];
            name.style.color = this.colors[index];
            const value = document.createElement("strong");
            value.className = "channel-value";
            value.dataset.channelValue = String(index);
            value.textContent = "--";
            item.addEventListener("mouseenter", () => { this.hoverChannel = index; this.dirty = true; });
            item.addEventListener("mouseleave", () => { this.hoverChannel = null; this.dirty = true; });
            item.addEventListener("dblclick", event =>
            {
                event.preventDefault();
                const restoreAll = this.visible.filter(Boolean).length === 1 && this.visible[index];
                this.visible = this.visible.map((unused, channel) => restoreAll || channel === index);
                this.buildLegend();
                this.dirty = true;
            });
            item.append(checkbox, name, value);
            this.legend.appendChild(item);
        });
        this.updateLegendValues();
    }

    updateLegendValues()
    {
        const definitions = TELEMETRY_MODES[this.mode];
        this.legend.querySelectorAll("[data-channel-value]").forEach(item =>
        {
            const index = Number(item.dataset.channelValue);
            const unit = definitions[index][1];
            item.textContent = `${this.formatChannelValue(this.latestValues[index], unit)}${unit ? " " + unit : ""}`;
        });
    }

    formatChannelValue(value, unit)
    {
        if (!Number.isFinite(value)) { return "--"; }
        if (unit === "Hz") { return value.toFixed(6); }
        if (unit === "A") { return Math.abs(value) < 0.01 ? value.toFixed(6) : value.toFixed(4); }
        if (unit === "count" || unit === "")
        {
            return Math.abs(value - Math.round(value)) < 1e-4 ? String(Math.round(value)) : value.toFixed(3);
        }
        return value.toFixed(3);
    }

    formatAxisValue(value)
    {
        const absolute = Math.abs(value);
        return absolute >= 10000 || (absolute > 0 && absolute < 0.001) ? value.toExponential(3) : value.toFixed(3);
    }

    formatTime(valueMs)
    {
        const sign = valueMs < 0 ? "-" : "";
        const absolute = Math.abs(valueMs);
        if (absolute < 1000) { return `${sign}${Number(absolute.toFixed(3))} ms`; }
        if (absolute < 60000) { return `${sign}${Number((absolute / 1000).toFixed(3))} s`; }
        return `${sign}${(absolute / 60000).toFixed(2)} min`;
    }

    addSample(values)
    {
        if (!this.paused)
        {
            this.latestValues = values.slice(0, 5);
        }
        this.samples.push({ index: this.sampleIndex, timeMs: this.sampleIndex * this.periodMs, values: values.slice(0, 5) });
        this.sampleIndex++;
        if (this.samples.length - this.sampleHead > this.capacity)
        {
            // Why: 1 kHz 下逐帧 splice 会持续搬移约一万个元素；逻辑头索引保持
            // 严格 10000 点容量，仅在累计出一整块旧数据后低频压缩一次。
            this.sampleHead++;
            if (this.sampleHead >= 1000)
            {
                this.samples.splice(0, this.sampleHead);
                this.sampleHead = 0;
            }
        }
        if (this.xAuto && !this.paused)
        {
            if (this.followLatest(false))
            {
                this.xViewNotificationPending = true;
            }
        }
        if (!this.paused)
        {
            this.emptyHint.style.display = "none";
            this.dirty = true;
        }
    }

    setPaused(paused)
    {
        const changed = this.paused !== paused;
        if (!changed)
        {
            return;
        }
        if (paused)
        {
            // Why: 仅冻结坐标轴仍会让新点在窗口内部继续出现；保存完整显示快照
            // 才能同时冻结曲线、图例、光标、Y量程和范围条，而后台缓存继续接收。
            this.frozenSamples = this.getBufferedSamples();
        }
        else
        {
            this.frozenSamples = null;
            if (this.samples.length > this.sampleHead)
            {
                this.latestValues = this.samples[this.samples.length - 1].values.slice();
            }
        }
        this.paused = paused;
        this.xAuto = !paused;
        if (!paused)
        {
            this.followLatest(true);
        }
        this.onPausedChange(paused);
        this.notifyXViewChange();
        this.dirty = true;
    }

    clear()
    {
        this.samples = [];
        this.sampleHead = 0;
        this.sampleIndex = 0;
        this.frozenSamples = this.paused ? [] : null;
        this.latestValues = [NaN, NaN, NaN, NaN, NaN];
        this.viewStartMs = 0;
        this.viewEndMs = this.xPerDivMs * this.xDivisions;
        this.hoverPoint = null;
        this.tooltip.style.display = "none";
        this.hideAxisHint();
        this.emptyHint.style.display = "grid";
        this.notifyXViewChange();
        this.dirty = true;
    }

    setAutoScale(enabled)
    {
        const changed = this.autoScale !== enabled;
        this.autoScale = enabled;
        if (changed)
        {
            this.onAutoScaleChange(enabled);
        }
        this.dirty = true;
    }

    getVisibleSamples()
    {
        const source = this.frozenSamples || this.samples;
        const startIndex = this.frozenSamples ? 0 : this.sampleHead;
        const windowSamples = [];
        for (let index = startIndex; index < source.length; index++)
        {
            const sample = source[index];
            if (sample.timeMs >= this.viewStartMs && sample.timeMs <= this.viewEndMs)
            {
                windowSamples.push(sample);
            }
        }
        return windowSamples;
    }

    getBufferedSamples()
    {
        return this.samples.slice(this.sampleHead);
    }

    computeRange(samples)
    {
        if (!this.autoScale) { return this.lastRange; }
        let minimum = Infinity;
        let maximum = -Infinity;
        for (const sample of samples)
        {
            for (let channel = 0; channel < 5; channel++)
            {
                if (this.visible[channel])
                {
                    minimum = Math.min(minimum, sample.values[channel]);
                    maximum = Math.max(maximum, sample.values[channel]);
                }
            }
        }
        if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) { return this.lastRange; }
        if (minimum === maximum)
        {
            const margin = Math.max(1e-6, Math.abs(minimum) * 0.1, 0.001);
            minimum -= margin;
            maximum += margin;
        }
        else
        {
            const margin = (maximum - minimum) * 0.08;
            minimum -= margin;
            maximum += margin;
        }
        this.lastRange = [minimum, maximum];
        return this.lastRange;
    }

    notifyXViewChange()
    {
        this.updateOverview();
        this.onXViewChange({ startMs: this.viewStartMs, endMs: this.viewEndMs,
            xPerDivMs: this.xPerDivMs, periodMs: this.periodMs,
            xAuto: this.xAuto, capacity: this.capacity });
    }

    getOverviewBounds()
    {
        const source = this.frozenSamples || this.samples;
        const startIndex = this.frozenSamples ? 0 : this.sampleHead;
        const hasSamples = source.length > startIndex;
        const first = hasSamples ? source[startIndex].timeMs : 0;
        const latest = hasSamples ? source[source.length - 1].timeMs : 0;
        return { minimum: Math.min(first, this.viewStartMs), maximum: Math.max(latest, this.viewEndMs, 1) };
    }

    updateOverview()
    {
        if (!this.overview) { return; }
        const bounds = this.getOverviewBounds();
        const span = Math.max(1e-9, bounds.maximum - bounds.minimum);
        const position = value => this.clamp(((value - bounds.minimum) / span) * 100, 0, 100);
        const start = position(this.viewStartMs);
        const end = position(this.viewEndMs);
        const source = this.frozenSamples || this.samples;
        const startIndex = this.frozenSamples ? 0 : this.sampleHead;
        const latest = position(source.length > startIndex ? source[source.length - 1].timeMs : 0);
        this.overview.window.style.left = `${start}%`;
        this.overview.window.style.width = `${Math.max(0.4, end - start)}%`;
        this.overview.start.style.left = `${start}%`;
        this.overview.end.style.left = `${end}%`;
        this.overview.latest.style.left = `${latest}%`;
    }

    drawLoop()
    {
        if (this.dirty)
        {
            this.draw();
            this.dirty = false;
        }
        this.animationFrame = requestAnimationFrame(() => this.drawLoop());
    }

    draw()
    {
        // Why: 串口可达 1 kHz，图例和范围条只需跟随显示刷新率，数据缓存仍逐帧进行。
        this.updateLegendValues();
        if (this.xViewNotificationPending)
        {
            this.xViewNotificationPending = false;
            this.notifyXViewChange();
        }
        else
        {
            this.updateOverview();
        }
        const context = this.context;
        const width = this.canvas.width;
        const height = this.canvas.height;
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        const left = 64 * ratio;
        const right = 14 * ratio;
        const top = 14 * ratio;
        const bottom = 40 * ratio;
        const plotWidth = Math.max(1, width - left - right);
        const plotHeight = Math.max(1, height - top - bottom);
        context.clearRect(0, 0, width, height);
        
        // 旗舰级 HUD 视口底色 (纯净微冷渐变)
        const bgGrad = context.createLinearGradient(0, top, 0, height - bottom);
        bgGrad.addColorStop(0, "#FAFCFF");
        bgGrad.addColorStop(1, "#F4F7FB");
        context.fillStyle = bgGrad;
        context.fillRect(left, top, plotWidth, plotHeight);

        const samples = this.getVisibleSamples();
        const [minimum, maximum] = this.computeRange(samples);
        this.rangeLabel.textContent = `Y: ${this.formatAxisValue(minimum)} ～ ${this.formatAxisValue(maximum)}`;

        // 精密测控网格线与坐标刻度
        context.lineWidth = 1 * ratio;
        context.strokeStyle = "rgba(203, 213, 225, 0.65)";
        context.fillStyle = "#64748B";
        context.font = `${10 * ratio}px "JetBrains Mono", Consolas, monospace`;
        context.textAlign = "right";
        context.textBaseline = "middle";
        for (let row = 0; row <= 5; row++)
        {
            const y = top + (plotHeight * row) / 5;
            context.beginPath(); context.moveTo(left, y); context.lineTo(width - right, y); context.stroke();
            context.fillText(this.formatAxisValue(maximum - ((maximum - minimum) * row) / 5), left - 7 * ratio, y);
        }
        context.textAlign = "center";
        context.textBaseline = "top";
        for (let column = 0; column <= this.xDivisions; column++)
        {
            const x = left + (plotWidth * column) / this.xDivisions;
            context.beginPath(); context.moveTo(x, top); context.lineTo(x, height - bottom); context.stroke();
            context.fillText(this.formatTime(this.viewStartMs + this.xPerDivMs * column), x, height - bottom + 7 * ratio);
        }

        // 视口右上角 HUD 状态微标识
        context.save();
        context.font = `600 ${9.5 * ratio}px -apple-system, BlinkMacSystemFont, "Inter", sans-serif`;
        context.textAlign = "right";
        context.textBaseline = "top";
        if (this.paused)
        {
            context.fillStyle = "#D97706";
            context.fillText("❚❚ PAUSED", width - right - 8 * ratio, top + 6 * ratio);
        }
        else
        {
            context.fillStyle = "#059669";
            context.fillText("● 60 FPS LIVE", width - right - 8 * ratio, top + 6 * ratio);
        }
        context.restore();

        // 5 通道激光霓虹波形绘制 (含自适应柔和辉光)
        const viewSpan = Math.max(1e-12, this.viewEndMs - this.viewStartMs);
        const ySpan = Math.max(1e-12, maximum - minimum);
        for (let channel = 0; channel < 5; channel++)
        {
            if (!this.visible[channel] || samples.length === 0) { continue; }
            const isHovered = this.hoverChannel === channel;
            const hasFocus = this.hoverChannel !== null;
            context.save();
            context.beginPath();
            context.strokeStyle = this.colors[channel];
            context.fillStyle = this.colors[channel];
            if (hasFocus)
            {
                context.globalAlpha = isHovered ? 1.0 : 0.18;
                context.lineWidth = (isHovered ? 2.8 : 1.2) * ratio;
                if (isHovered)
                {
                    context.shadowColor = this.colors[channel];
                    context.shadowBlur = 6 * ratio;
                }
            }
            else
            {
                context.globalAlpha = 1.0;
                context.lineWidth = 1.8 * ratio;
                context.shadowColor = this.colors[channel];
                context.shadowBlur = 2.5 * ratio;
            }
            samples.forEach((sample, index) =>
            {
                const x = left + ((sample.timeMs - this.viewStartMs) / viewSpan) * plotWidth;
                const y = top + plotHeight * (1 - (sample.values[channel] - minimum) / ySpan);
                if (index === 0) { context.moveTo(x, y); } else { context.lineTo(x, y); }
            });
            if (samples.length === 1)
            {
                const sample = samples[0];
                const x = left + ((sample.timeMs - this.viewStartMs) / viewSpan) * plotWidth;
                const y = top + plotHeight * (1 - (sample.values[channel] - minimum) / ySpan);
                context.beginPath();
                context.arc(x, y, 2.5 * ratio, 0, Math.PI * 2);
                context.fill();
            }
            else { context.stroke(); }
            context.restore();
        }
        this.drawHover(samples, minimum, maximum, { left, right, top, bottom, plotWidth, plotHeight, ratio });
    }

    drawHover(samples, minimum, maximum, geometry)
    {
        if (!this.hoverPoint || this.hoverRegion !== "plot" || samples.length === 0)
        {
            this.tooltip.style.display = "none";
            return;
        }
        const xCss = this.clamp(this.hoverPoint.x, 64, this.canvas.clientWidth - 14);
        const yCss = this.clamp(this.hoverPoint.y, 14, this.canvas.clientHeight - 40);
        const targetTime = this.viewStartMs + ((xCss - 64) / Math.max(1, this.canvas.clientWidth - 78)) * (this.viewEndMs - this.viewStartMs);
        let sample = samples[0];
        for (const candidate of samples)
        {
            if (Math.abs(candidate.timeMs - targetTime) < Math.abs(sample.timeMs - targetTime)) { sample = candidate; }
        }
        const snappedX = geometry.left + ((sample.timeMs - this.viewStartMs) /
            Math.max(1e-12, this.viewEndMs - this.viewStartMs)) * geometry.plotWidth;
        const context = this.context;
        context.save();
        context.setLineDash([4 * geometry.ratio, 4 * geometry.ratio]);
        context.strokeStyle = "rgba(15, 23, 42, 0.4)";
        context.beginPath();
        context.moveTo(snappedX, geometry.top); context.lineTo(snappedX, this.canvas.height - geometry.bottom);
        context.moveTo(geometry.left, yCss * geometry.ratio); context.lineTo(this.canvas.width - geometry.right, yCss * geometry.ratio);
        context.stroke(); context.restore();
        const cursorValue = maximum - (maximum - minimum) * ((yCss - 14) / Math.max(1, this.canvas.clientHeight - 54));
        const definitions = TELEMETRY_MODES[this.mode];
        const lines = [`sample: ${sample.index}`, `time: ${this.formatTime(sample.timeMs)}`, `Y cursor: ${this.formatAxisValue(cursorValue)}`];
        definitions.forEach((definition, channel) =>
        {
            if (this.visible[channel])
            {
                lines.push(`${definition[0]}: ${this.formatChannelValue(sample.values[channel], definition[1])}${definition[1] ? " " + definition[1] : ""}`);
            }
        });
        this.tooltip.textContent = lines.join("\n");
        this.tooltip.style.display = "block";
        const tooltipWidth = 210;
        const tooltipHeight = 42 + lines.length * 16;
        this.tooltip.style.left = `${Math.max(4, xCss + 14 + tooltipWidth > this.canvas.clientWidth ? xCss - tooltipWidth - 10 : xCss + 14)}px`;
        this.tooltip.style.top = `${Math.max(4, yCss + 14 + tooltipHeight > this.canvas.clientHeight ? yCss - tooltipHeight - 8 : yCss + 14)}px`;
    }

    exportCsv()
    {
        if (this.samples.length === 0) { throw new Error("当前没有可导出的波形数据"); }
        const definitions = TELEMETRY_MODES[this.mode];
        const header = ["sample", "time_ms", ...definitions.map(item => `${item[0]}${item[1] ? "(" + item[1] + ")" : ""}`)];
        const rows = [header.join(",")];
        for (let index = this.sampleHead; index < this.samples.length; index++)
        {
            const sample = this.samples[index];
            rows.push([sample.index, sample.timeMs, ...sample.values].join(","));
        }
        const blob = new Blob(["\uFEFF" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `G3507_${this.mode}_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    }
}

window.TelemetryPlot = TelemetryPlot;
window.TELEMETRY_MODES = TELEMETRY_MODES;
window.TELEMETRY_TIMING = TELEMETRY_TIMING;
